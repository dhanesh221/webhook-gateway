# webhook-gateway

A webhook ingest, delivery, and replay gateway. It's a portfolio project that demonstrates the parts of backend engineering most junior portfolios skip: retrying failed deliveries safely, avoiding duplicate side effects (idempotency), routing permanently-failed messages to a dead-letter queue, and using a circuit breaker to stop hammering a downstream service that's down.

Status: Phase 2 (Ingest endpoint).

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

## Security notes

The `webhook_events` table has Row Level Security enabled with a policy permitting `INSERT` only for the `anon` role — no select, update, or delete. The ingest endpoint runs server-side but deliberately uses that low-privilege key, so a leaked key cannot be used to read or tamper with stored events.

One consequence worth knowing: because the key has no read rights, the endpoint cannot ask Postgres to return the row it just inserted (`INSERT ... RETURNING` requires SELECT rights and fails with `42501`). The event `id` is therefore generated in the application and included in the insert, which keeps the response contract intact without loosening the policy.

## Configuration

Copy the required values into `.env.local` (gitignored, never committed):

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

## Running it

```bash
npm install
npm run dev    # starts the dev server
npm test       # runs the test suite
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
