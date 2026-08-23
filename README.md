# webhook-gateway

A webhook ingest, delivery, and replay gateway. It's a portfolio project that demonstrates the parts of backend engineering most junior portfolios skip: retrying failed deliveries safely, avoiding duplicate side effects (idempotency), routing permanently-failed messages to a dead-letter queue, and using a circuit breaker to stop hammering a downstream service that's down.

Status: Phase 3 (Delivery worker).

## Stack

- **Node.js + TypeScript** — typed JavaScript, catches whole classes of bugs before the code even runs.
- **Express** — the most common Node.js web server framework, and the one interviewers ask about most.
- **Supabase (Postgres)** — stores received webhook events.
- **Vitest** — the test runner. Chosen over Jest because it needs almost no configuration to work with TypeScript, and it's fast.
- **Supertest** — lets tests call HTTP endpoints directly, without starting a real server on a real port.

## Endpoints

### `GET /health`

Returns `200` with `{ "status": "ok" }`.

### `POST /webhooks/:source`

Receives a webhook from an external provider (`:source` is a label such as `stripe` or `github`), stores it, and returns immediately. Actual delivery to downstream targets is the Phase 3 worker's job.

Send a JSON body. Optionally send an `Idempotency-Key` header.

| Situation | Status | Body |
|---|---|---|
| Stored successfully | `202` | `{ "id": "<uuid>", "status": "pending" }` |
| Already received (same source + `Idempotency-Key`) | `200` | `{ "status": "duplicate", "message": "already received" }` |
| Empty or non-object JSON body | `400` | `{ "error": "..." }` |
| Malformed JSON | `400` | `{ "error": "Invalid JSON body" }` |

```bash
curl -X POST http://localhost:3000/webhooks/stripe \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: evt_abc123" \
  -d '{"event":"payment.succeeded","amount":500}'
```

## Idempotency

Webhook providers redeliver. A provider that doesn't receive a timely `2xx` will send the same event again, so an ingest endpoint must be able to receive the same event twice without recording it twice.

A unique index on `(source, idempotency_key)` makes the database itself the source of truth: a replayed event violates that index, Postgres raises error `23505`, and the endpoint answers `200 duplicate` instead of failing. Duplicate delivery is normal traffic, not an error — answering `2xx` is what tells the provider to stop retrying.

Events sent without an `Idempotency-Key` are always stored (the column is nullable and the unique index ignores nulls).

### Delivery destination

Every stored event carries a `destination_url`, but for now it's the same value for every source: whatever `DESTINATION_URL` is set to in the environment. **Known limitation:** in a real gateway, each source (or each subscriber) would configure its own destination; this project deliberately hardcodes one global destination for now to keep Phase 3 focused on the retry mechanics rather than multi-tenant config. Revisit this before Phase 5 (dashboard), which will need per-source destinations.

## Delivery worker (Phase 3)

A standalone process, separate from the HTTP server, that delivers stored events to their `destination_url` and retries failures with exponential backoff.

```bash
npm run worker
```

It polls every ~2 seconds. Each cycle:

1. Calls the `claim_pending_webhook_events` RPC (a `SECURITY DEFINER` Postgres function, added via migration, granted to the `anon` role), which atomically claims every due event (`status = 'pending'` and `next_attempt_at <= now`) and flips it to `in_progress` in one transaction. That atomicity is what makes it safe to eventually run more than one worker instance without two workers claiming — and delivering — the same event twice.
2. For each claimed event, sends an HTTP POST to its `destination_url` with the stored `payload` as the body.
3. A `2xx` response calls `mark_webhook_event_delivered` and the event is done.
4. Anything else — non-2xx, timeout, network error, or a missing `destination_url` — calls `mark_webhook_event_retry` with a computed backoff delay. After 5 total attempts, that same RPC marks the event `dead_lettered` instead of scheduling another retry (Phase 4 will build a way to inspect and replay dead-lettered events).

Every attempt is logged to the console with the event id, attempt number, and outcome.

The claim/deliver/mark loop lives in `src/deliveryWorker.ts` as `processPendingBatch()`, kept separate from the `setInterval` wrapper in `src/worker.ts` so it can be tested by calling it directly, without waiting on real timers.

### Backoff formula

`src/backoff.ts` implements **exponential backoff with full jitter**: instead of always waiting exactly `baseDelay * 2^attempt`, it waits a *random* amount of time between 0 and that value. In plain terms — after your Nth failure, don't just wait longer each time (that's plain exponential backoff); wait a *random* amount up to that longer ceiling. This staggers retries so that if many events fail at once (e.g. the destination goes down entirely), they don't all come back and retry at the exact same instant and immediately overwhelm it again the moment it recovers.

```
delay = random(0, min(maxDelay, baseDelay * 2^attempt))
```

With `baseDelay = 1000ms` and `maxDelay = 5 minutes`: the first retry waits up to 1s, the second up to 2s, the third up to 4s, and so on, capping at 5 minutes once the exponent gets large. After 5 attempts total, the event is dead-lettered rather than retried again.

## Security notes

The `webhook_events` table has Row Level Security enabled with a policy permitting `INSERT` only for the `anon` role — no select, update, or delete. The ingest endpoint runs server-side but deliberately uses that low-privilege key, so a leaked key cannot be used to read or tamper with stored events.

One consequence worth knowing: because the key has no read rights, the endpoint cannot ask Postgres to return the row it just inserted (`INSERT ... RETURNING` requires SELECT rights and fails with `42501`). The event `id` is therefore generated in the application and included in the insert, which keeps the response contract intact without loosening the policy.

## Configuration

Copy the required values into `.env.local` (gitignored, never committed):

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
DESTINATION_URL=...
```

## Running it

```bash
npm install
npm run dev     # starts the ingest HTTP server
npm run worker  # starts the delivery worker (separate process)
npm test        # runs the test suite
```

## Phases

0. Recon
1. Skeleton
2. Ingest endpoint
3. Delivery worker (backoff + jitter)
4. Dead-letter queue + circuit breaker
5. Dashboard (auth + replay)
6. CLI (localhost tunnel)
7. Production polish
