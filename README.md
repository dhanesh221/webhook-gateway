# webhook-gateway

A webhook ingest, delivery, and replay gateway. It's a portfolio project that demonstrates. retrying failed deliveries safely, avoiding duplicate side effects (idempotency), routing permanently-failed messages to a dead-letter queue, and using a circuit breaker to stop hammering a downstream service that's down.

Status: Phase 6 (CLI — one command starts everything and exposes it on a public URL).

```bash
npm run gateway -- start
```

## Stack

- **Node.js + TypeScript** — typed JavaScript, catches whole classes of bugs before the code even runs.
- **Express** — the most common Node.js web server framework, and the one interviewers ask about most.
- **Supabase (Postgres)** — stores received webhook events.
- **Vitest** — the test runner. Chosen over Jest because it needs almost no configuration to work with TypeScript, and it's fast.
- **Supertest** — lets tests call HTTP endpoints directly, without starting a real server on a real port.
- **bcryptjs + jsonwebtoken** — dashboard auth (Phase 5): bcrypt hashes the admin password so the stored value can't be reversed; JWT signs the session cookie so the server can trust it without keeping a session table.
- **commander** — CLI subcommand parsing (Phase 6): `gateway start`, `gateway dlq list`, `gateway dlq replay <id>`, and a real `--help`.
- **localtunnel** — gives the local server a public HTTPS URL so a real webhook sender can reach it during development. See [CLI and public tunnel](#cli-and-public-tunnel-phase-6) for why this and not `cloudflared`.

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

## Circuit breaker (Phase 4)

Backoff alone doesn't stop the worker from hammering a destination that's entirely down: each event still retries on its own schedule, and with enough concurrent events that adds up to steady traffic against a dead service. A circuit breaker tracks failures *per destination* (not per event) and, once a destination looks reliably down, stops sending it traffic for a cooldown period — giving it room to recover instead of getting retried into the ground.

State lives in a `circuit_breakers` table (one row per `destination_url`), managed entirely through `SECURITY DEFINER` RPCs — nothing touches the table directly. There's no stored "half-open" state; it's derived: once a breaker is `open` and its cooldown (`next_probe_at`) has passed, the next event claimed for that destination is treated as a probe attempt instead of being skipped.

Before attempting delivery, the worker checks `get_circuit_breaker_state(destination_url)`:

- **`closed`** — deliver normally.
- **`open`, cooldown not yet elapsed** — don't attempt delivery. Call `mark_webhook_event_skipped`, which puts the event back to `pending` with a new `next_attempt_at` *without* incrementing its `attempts` count — being skipped isn't a failed delivery attempt, so it shouldn't count against the event's own retry budget.
- **`open`, cooldown elapsed** — attempt delivery anyway, as a probe.

After every real delivery attempt (including probes): success calls `record_delivery_success` (resets the breaker to `closed`); failure calls `record_delivery_failure`, which increments a failure counter and flips the breaker to `open` (with a fresh cooldown) once it crosses the threshold. Defaults, applied by the RPCs themselves: **5 consecutive failures** trips the breaker, **60 second** cooldown.

Because the failure counter is per-destination, not per-event, a handful of different events all failing against the same flaky destination trips the breaker exactly like one event failing repeatedly would.

## Dead-letter queue (Phase 4)

Events that exhaust their 5 delivery attempts land in `status = 'dead_lettered'` and stop being retried automatically. The CLI inspects and replays them:

```bash
npm run gateway -- dlq list
npm run gateway -- dlq replay <event-id>
```

The older standalone form still works and does exactly the same thing — it is kept as an alias so nothing written against it breaks:

```bash
npm run dlq -- list
npm run dlq -- replay <event-id>
```

`list` prints every dead-lettered event's id, source, attempts, and last-updated time. `replay <id>` resets a dead-lettered event back to `pending` with `attempts = 0`, so the worker picks it up again on its next poll.

**Implementation note:** `replay_webhook_event` returns no signal either way — calling it on a real dead-lettered row and on a nonexistent id both come back as `{ data: null, error: null }` (confirmed empirically against the live RPC before writing the CLI). So `replay` checks `list_dead_lettered_events` itself first to decide whether to report success or a clear "not dead-lettered (not found, or already replayed)" message, rather than trusting the RPC's return value.

## Dashboard (Phase 5)

A small web dashboard for watching events and replaying dead-lettered ones by hand, served by the same Express process as the ingest endpoint.

### Logging in

Credentials are generated once, locally:

```bash
npm run setup:auth
```

That writes three things into `.env.local` (which is gitignored and never committed):

- `ADMIN_PASSWORD_HASH` — a bcrypt hash of a freshly generated random password.
- `SESSION_SECRET` — a random value used to sign session tokens.
- A comment line holding the **plaintext password**.

The plaintext password exists in that one file and nowhere else. It is never printed to the console, never written to the README, never committed, and cannot be recovered from the hash. Open `.env.local`, copy the password somewhere safe, and delete the comment line if you'd rather it not sit there.

Re-running `npm run setup:auth` refuses to overwrite an existing configuration. Use `npm run setup:auth -- --force` to deliberately generate a new password — which invalidates the old one and signs everyone out.

Then start the server and visit <http://localhost:3000>:

```bash
npm run dev
```

`/` redirects to `/login.html` or `/dashboard.html` depending on whether you already have a valid session.

### Pages

- **`/login.html`** — password form; posts to `/api/login` and redirects to the dashboard on success.
- **`/dashboard.html`** — a status filter, a table of the 100 most recent events (id, source, status, attempts, received), a circuit breakers table (destination, state, consecutive failures, next probe), and a **Replay** button on dead-lettered rows. Any fetch that comes back `401` bounces the browser to the login page.

Plain HTML and vanilla JavaScript, no build step and no framework — the interesting parts of this project are behind the API, not in front of it.

### API routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/login` | public | `{ "password": "..." }` → sets an httpOnly session cookie. Wrong, missing, or malformed password all get the same `401 {"error":"Invalid credentials"}`. |
| `POST /api/logout` | public | Clears the session cookie. Works without a valid session — logging out of an expired session isn't an error. |
| `GET /api/events?status=` | session | Calls `list_webhook_events`. `status` is optional; an unrecognised value gets a `400` rather than a silently empty list. Capped at 100 rows. |
| `GET /api/circuit-breakers` | session | Calls `list_circuit_breakers`. |
| `POST /api/events/:id/replay` | session | Calls `replay_webhook_event`. Returns `409` with a clear message if the event isn't dead-lettered. |

Both read routes go through `SECURITY DEFINER` RPCs (migration `add_dashboard_read_functions`) for the same reason every other database call in this project does: the `anon` key still has no direct read rights on `webhook_events`.

`GET /api/events` deliberately does **not** return each event's `payload` or `headers`. The RPC returns full rows, but a single payload can be ~100 KB, so 100 of them would be a multi-megabyte response for a table that renders five columns of metadata.

`POST /api/events/:id/replay` checks the dead-lettered list itself before calling the RPC, for the same reason the DLQ CLI does — `replay_webhook_event` returns `{ data: null, error: null }` whether it replayed a row or matched nothing, so trusting its return value would report success for every id, including ids that don't exist.

### Why not Supabase Auth here

This is a deliberately simple, self-rolled session scheme: a bcrypt-hashed password in `.env.local`, and a JWT signed with a local secret, handed to the browser as an httpOnly cookie with a 12-hour expiry. The reason it's sufficient is that **the browser never talks to Supabase**. In a typical Supabase app the frontend holds the anon key and calls the database directly, so Supabase's own auth has to be the gate — it's the only thing in the request path. Here the Express server is the only thing that ever holds that key; the browser only ever talks to this server's API. That makes a server-side session cookie a real gate rather than a decorative one, and it avoids wiring up Supabase Auth's email-confirmation flow for what is a single-operator admin page. The trade-offs are accepted and worth naming: one shared password rather than per-user accounts, no password reset flow, and no way to revoke an issued token before it expires — which is why the expiry is short.

## CLI and public tunnel (Phase 6)

Up to Phase 5 the gateway only ever listened on `localhost`, which meant no real webhook sender could reach it — you could test it against yourself, but never against Stripe. Phase 6 fixes that with one command:

```bash
npm run gateway -- start
```

That starts the ingest server, starts the delivery worker, opens a public tunnel to the local port, and prints where to point a sender:

```
Your gateway is live at: https://quiet-jars-push.loca.lt
Point Stripe (or any webhook sender) at https://quiet-jars-push.loca.lt/webhooks/<source>
  e.g. https://quiet-jars-push.loca.lt/webhooks/stripe

Dashboard: http://localhost:3000/dashboard.html
  Admin password lives in .env.local (written by `npm run setup:auth`).

Delivery worker is running in this same process. Press Ctrl+C to stop both.
```

The URL changes every run — quick tunnels are ephemeral by design.

### Commands

```bash
npm run gateway -- --help                     # all subcommands
npm run gateway -- start                      # server + worker + public tunnel
npm run gateway -- start --port 4100          # bind a different port (tunnel follows it)
npm run gateway -- start --no-tunnel          # local only, no public URL
npm run gateway -- start --poll-interval 500  # faster worker polling
npm run gateway -- dlq list
npm run gateway -- dlq replay <event-id>
```

### One process, not three

`start` runs the server and the worker **in the same process**, and `Ctrl+C` stops both. That is a deliberate choice rather than spawning child processes: `npm run` and `npx` each spawn a child that actually holds the port, and killing the wrapper leaves that child alive. This project lost most of a phase to exactly that — an orphaned server on port 3000 serving stale code and returning confusing 404s. A single process has no parent/child gap to leak through.

Shutdown closes things in reverse order of exposure — tunnel first (so no new external traffic arrives), then the HTTP server, then the worker, which is awaited so an in-flight delivery finishes recording its outcome instead of being cut off between "request sent" and "result written". Each step runs even if an earlier one throws, so one stubborn resource can't leave the port bound.

### Which tunnel, and why

**localtunnel**, because `cloudflared` is not installed on this machine.

A Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:3000`) would be the better option — no account needed, no interstitial page, and more reliable. But installing `cloudflared` requires a system package manager and root, which is out of scope here. localtunnel is a plain npm dependency with a programmatic Node API and no signup, so it works with what is actually available. Swapping back later means changing `src/tunnel.ts` only — everything else talks to the `openTunnel(port) → { url, close() }` interface.

**The caveat that comes with localtunnel:** `loca.lt` sometimes shows a one-time "click to continue" interstitial HTML page to an IP address the first time it sees it. A human in a browser clicks through it once; an automated sender like Stripe, hitting the URL directly, can receive that HTML page instead of reaching the gateway — which looks like the gateway silently ignoring webhooks.

Two ways around it:

- Send the header `bypass-tunnel-reminder: 1` (any value works). Good for `curl` and for any sender whose headers you control.
- Visit the URL once in a browser from the same IP and click through. Good for senders whose headers you don't control — which includes Stripe.

If a tunnel fails to open, `start` says so and keeps serving locally rather than exiting. Losing external reachability shouldn't take down a gateway that otherwise works.

### Pointing a real Stripe webhook at this

1. Run `npm run gateway -- start` and copy the printed public URL.
2. Open the URL in a browser once and click through the loca.lt interstitial if it appears. Do this **before** step 3 — otherwise Stripe's endpoint-verification request may hit the interstitial and the endpoint won't validate.
3. In the Stripe Dashboard, go to **Developers → Webhooks → Add endpoint** and set the endpoint URL to `https://<your-url>.loca.lt/webhooks/stripe`.
4. Select the events to send, save, and use **Send test webhook** to fire one.
5. Watch it arrive at `http://localhost:3000/dashboard.html`, or check the terminal — the worker logs each delivery attempt.

Set `DESTINATION_URL` in `.env.local` first, or events will be stored and then fail delivery with "no destination_url set". The URL is ephemeral, so a tunnel restart means updating the endpoint in Stripe again.

Signature verification is **not** implemented — this accepts any POST to `/webhooks/:source`. That is fine for development against a URL nobody else knows, and is Phase 7 work before anything like this faces the real internet for long.

### Dependency note

`localtunnel@2.0.2` pulls in an old `axios` with open high-severity advisories (`npm audit`). It is a development-only convenience that never runs in production, so it is accepted here rather than pinned around — but it is a real reason not to promote this dependency into a production path.

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

`ADMIN_PASSWORD_HASH` and `SESSION_SECRET` are added by `npm run setup:auth` — don't write those by hand.

## Running it

```bash
npm install
npm run setup:auth  # one-time: generates the dashboard password into .env.local

npm run gateway -- start     # the usual way in: server + worker + public tunnel, Ctrl+C stops all
npm run gateway -- --help    # all subcommands

npm test        # runs the test suite
```

Individual pieces, still available for running them apart (a second machine, a separate container, or just quieter output):

```bash
npm run dev     # ingest HTTP server + dashboard only (http://localhost:3000), no tunnel
npm run worker  # delivery worker only, as its own process
```

## Phases

0. Recon
1. Skeleton
2. Ingest endpoint
3. Delivery worker (backoff + jitter)
4. Dead-letter queue + circuit breaker
5. Dashboard (auth + replay)
6. CLI (localhost tunnel) (current)
7. Production polish
