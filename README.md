# webhook-gateway

An HTTP webhook ingest, delivery, and replay gateway. It stores accepted events in Supabase/Postgres, delivers them to registered source destinations, retries failures with jittered backoff, holds exhausted events in a dead-letter queue, and provides a dashboard for inspection and replay.

Status: Phase 7, production-polish work. Phase 6 (CLI + development tunnel) is complete. This is a single-operator gateway, not a multi-tenant service or a claim of production readiness.

## Delivery contract

Ingest returns `202` after an event is stored. An optional `Idempotency-Key` deduplicates ingest within a source; a duplicate returns `200`. Without that header, repeated requests are separate events. The worker makes up to five attempts, with full-jitter exponential waits capped at five minutes. Failed events enter the DLQ, where they can be replayed.

Delivery is **at least once**, not exactly once. If the destination accepts an event but the gateway fails before recording success, a retry may repeat the side effect. Downstream applications must implement their own deduplication. An `in_progress` event abandoned by a crashed worker is returned to `pending` after ten minutes (migration 009) without using an attempt, so it may be delivered again.

Each delivery carries `X-Webhook-Event-Id` (the event's UUID, stable across retries and DLQ replays), `X-Webhook-Source`, `X-Webhook-Attempt`, and `Idempotency-Key` set to the same event id, so receivers can dedupe. When the worker can resolve the source's signing secret (the source is registered and its `secret_env` variable is set in the worker's environment) the delivery is also signed with `X-Webhook-Signature: t=<unix-seconds>,v2=<hex>` over `"v2\n" + t + "\n" + eventId + "\n" + body`, using the **same secret the sender uses** for that source; a receiver verifies it exactly as the gateway verifies inbound requests, with the event id as the key. If the secret cannot be resolved the delivery goes out unsigned with the identity headers and a warning is logged once per source per poll, so a worker missing one variable does not stall a queue. Receivers that require signatures will reject such deliveries, which then retry and dead-letter visibly. Each source therefore has one secret shared by its sender, the gateway, and its receiver; a separate outbound secret per destination is future work.

Circuit breakers are shared by destination URL: five consecutive failures open a breaker for 60 seconds, then a single delivery probes it. The probe is leased (migration 010): the worker that wins the lease sends it, and any other worker that sees the same due breaker waits for the lease (30 seconds) or the probe's outcome, so a recovering destination gets one request however many workers run. Without migration 010 every worker probes, as before. Breaker skips do not consume event attempts. Sources using the same URL share a breaker.

## Process metrics

`GET /metrics` returns Prometheus text exposition version 0.0.4. It is private: use a valid dashboard session cookie or a separate `Authorization: Bearer <token>` header. Set `WG_METRICS_TOKEN` to a high-entropy secret of at least 32 non-padding characters, up to 4096 characters. Generate one with `openssl rand -hex 32` and keep it in secure server configuration. An unset, short or blank token disables bearer access, not the dashboard-session route. Tokens in query strings are never accepted. Serve scrapes over HTTPS in production; restrict scrape traffic at the reverse proxy.

Bearer scrapes work without querying Supabase. Dashboard-cookie access still checks the revocable session in Supabase and fails closed if that check fails. Responses use `Cache-Control: no-store`. Changing the configured token invalidates the old token; environment-file changes require restarting the process. Dashboard session revocation does not revoke the separate scrape token.

Example Prometheus scrape configuration (the credentials file contains only the token, and must be readable only by the monitoring service):

```yaml
scrape_configs:
  - job_name: webhook-gateway
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/wg_metrics_token
    static_configs:
      - targets: ['gateway.example:443']
```

For a local manual scrape, load the token into `WG_METRICS_TOKEN` securely, then send the header via stdin rather than placing the token in curl's command-line arguments:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$WG_METRICS_TOKEN" | curl --config - http://127.0.0.1:3000/metrics
```

| Counter | Counts |
| --- | --- |
| `webhook_events_received_total` | Newly stored events. Duplicate acknowledgements, rejected signatures/bodies and failed inserts do not count. |
| `webhook_events_delivered_total` | Delivery attempts returning HTTP success. Counts even if later DB accounting fails. It is not a count of unique delivered events or proof that the DB status is delivered. |
| `webhook_events_failed_total` | Failed delivery attempts, including network exceptions and missing destinations. The final failure also counts here. |
| `webhook_events_retried_total` | Failed events whose retry-scheduling RPC returned without an error before attempt five. This counts acknowledged schedules, not the later retry attempt itself. |
| `webhook_events_dead_lettered_total` | Failed events whose retry/DLQ RPC returned without an error at attempt five or later. |

Retry/DLQ metrics depend on the existing RPC contract. No live database readback is added. A thrown or returned DB error does not increment them. Breaker skips, rate-limit deferrals, failed claims and raw-body releases do not count as delivery attempts. Replays do not increment received; subsequent attempts increment delivered/failed normally. At-least-once redelivery can increase attempt counters more than once for the same event.

Each total has a separate `webhook_events_<kind>_by_route_total` family with `source_id` and `destination_id` labels. These are SHA-256 hex digests of the exact source and destination URL, not raw text. Payloads, headers, IDs, URL credentials, query tokens and error messages are never exported. Hashes are pseudonyms, not encryption: someone with candidate values can hash them and correlate the labels. Authentication is still required. Different URL paths, trailing slashes and query strings get different IDs. `missing` represents a null destination; strings longer than 4096 UTF-16 code units are grouped as `oversized`.

The process retains at most 1000 named source/destination pairs across all counters. Further new pairs go to `source_id="overflow",destination_id="overflow"`; existing pairs keep updating. No pairs are evicted until restart, preserving counter monotonicity. Detailed families sum to the corresponding totals, including overflow. Do not sum a total and its detailed family together. At the cap there are 5010 samples and roughly 1 MB of text per scrape. Apply a sensible scrape interval and protect against abusive scrape traffic; this is not an unbounded public endpoint.

Counts live only in memory, start at zero and reset on process restart. They are not persisted historical totals or "today" counts. Use `npm run gateway -- start` to keep ingest and the worker in the same process. A separately running `npm run worker` keeps its own delivery counters, which the ingest server's `/metrics` cannot expose; this change does not add a standalone-worker scrape server or shared aggregation. Prometheus must handle process resets and instance labels. Internal integers remain exact beyond 2^53, but Prometheus stores floating-point values and cannot retain every unit at that scale. Impossible increments beyond 10^100 are rejected before changing any counter. No database migration or monitoring service installation is needed.

## Phase A changes

### Registered sources and routing

`webhook_sources` stores `name`, `destination_url`, `secret_env`, `enabled`, and `updated_at`. Each source has one destination. The destination is copied into the event when it is received. Updating or disabling a source affects new ingest only: queued events and DLQ replays keep their original destination. Disabling a source does not cancel queued delivery.

The signing secret itself is **not in the database**. `secret_env` references a server environment variable such as `WG_SOURCE_PAYMENTS_SECRET`. Its name must match `WG_SOURCE_[A-Z0-9_]+_SECRET`, and its value must contain at least 32 UTF-8 bytes. Generate a high-entropy value, not a 32-character human password. Use a different variable and secret for every source. The name convention does not enforce uniqueness across rows; operators are responsible for not sharing a secret.

Destinations must be HTTPS. Loopback HTTP (`localhost`, `127.0.0.1`, or `::1`) is allowed only outside `NODE_ENV=production`. Embedded URL credentials and fragments are rejected. Only trusted operators may manage sources. This URL check is not an SSRF sandbox: DNS can resolve public-looking names to private addresses. Delivery does not follow redirects; a 3xx counts as a failed attempt. Do not expose source management to untrusted tenants. Multi-subscriber routing should add a subscriptions table and separate per-subscriber delivery records, rather than treating one event's status as the status of several deliveries.

```bash
npm run gateway -- sources set payments https://receiver.example/hook WG_SOURCE_PAYMENTS_SECRET
npm run gateway -- sources set repo-events https://receiver.example/gh WG_SOURCE_REPO_EVENTS_SECRET --scheme github
npm run gateway -- sources set stripe https://receiver.example/stripe WG_SOURCE_STRIPE_SECRET --scheme stripe
npm run gateway -- sources list
npm run gateway -- sources disable payments
```

`set` creates or updates a route and enables it. It checks that the referenced secret exists locally before writing. Commands print the variable name, never its value. To rotate a source secret, update its environment value and restart all gateway processes; old signatures stop working immediately. There is no overlap/key-ring period.

### Mandatory custom HMAC signing

Every ingest request must be signed. There is no unsigned development mode and no fallback to `DESTINATION_URL` or `WEBHOOK_SIGNING_SECRET`.

```
X-Webhook-Signature: t=<unix-seconds>,v1=<64-character hex HMAC-SHA256>
```

Sign the exact UTF-8 body as `${timestamp}.${rawBody}` with the source secret. Timestamps more than five minutes from the server clock are rejected. Duplicate signature fields, invalid timestamps, malformed hashes, body tampering and wrong-source secrets are rejected. Comparisons are constant-time. Signed requests can still be replayed within five minutes; supply an idempotency key to deduplicate them.

If you send an `Idempotency-Key`, sign it too, using the `v2` form: header `t=<timestamp>,v2=<hex>` where the MAC is HMAC-SHA256 over `"v2\n" + timestamp + "\n" + key + "\n" + rawBody`. A request carrying a key with a `v1` signature is rejected, so a captured request cannot be resent under a different key. Requests without a key keep using `t=...,v1=...` unchanged.

The header above is the gateway's own protocol, the `gateway` scheme. A source can instead declare a provider-native scheme with `--scheme` (migration 011); the scheme is a property of the source, so a label named `stripe` is Stripe-compatible only if it was registered with `--scheme stripe`. Every scheme uses the same `secret_env` convention and the same 32-byte minimum; GitHub lets you choose the secret, so generate it with `openssl rand -hex 32`, and Stripe's `whsec_...` signing secrets already qualify.

| Scheme | Verifies | Dedupes on | Replay window |
|---|---|---|---|
| `gateway` (default) | `X-Webhook-Signature: t=,v1=` or `v2=` over `t.body` (and the key) | `Idempotency-Key` header | 5 minutes |
| `github` | `X-Hub-Signature-256: sha256=<HMAC-SHA256 of body>` | `X-GitHub-Delivery`, else `Idempotency-Key`, else none | **unbounded**: GitHub signs no timestamp, so a captured request stays valid; the delivery id dedupes an honest redelivery only |
| `stripe` | `Stripe-Signature: t=,v1=` over `t.body`; any of several `v1` values may match (secret rotation) | the event's `id` field, else `Idempotency-Key`, else none | 5 minutes |

A request carrying the wrong scheme's header for its source is rejected with `401`, the same as any other signature failure. A source whose stored scheme is unrecognised answers `503`.

Authentication headers (`X-Webhook-Signature`, `X-Hub-Signature-256`, `X-Hub-Signature`, `Stripe-Signature`, `Authorization`, `Cookie`) are excluded from stored event headers. Payloads and other headers may still contain sensitive data; set retention and access rules accordingly.

### Dashboard credentials and revocable sessions

Passwords were already bcrypt-hashed before Phase A. Previously, setup also saved a generated plaintext password as a comment in `.env.local`. Setup now reads an operator-chosen password through stdin, saves only a cost-12 bcrypt hash and a random session signing secret, and removes the old plaintext comment. Save the password in your password manager.

A successful login creates a durable `dashboard_sessions` row and a 12-hour JWT with a random `jti` and password-hash fingerprint. Every protected request checks both JWT validity and the database session. Logout revokes the server-side session, so a copied cookie no longer works. The CLI can revoke all sessions. Password-hash or session-secret changes invalidate existing tokens. Legacy tokens without session IDs are rejected. Database failures fail closed and issue no login cookie.

```bash
# Bash: hidden prompt; no password in command arguments or shell history.
read -r -s -p 'Dashboard password (16-72 UTF-8 bytes): ' WG_PASSWORD; printf '\n'
printf '%s' "$WG_PASSWORD" | npm run setup:auth
unset WG_PASSWORD

# Password replacement invalidates existing cookies:
# Repeat the hidden prompt, then pipe into npm run setup:auth -- --force
npm run gateway -- sessions-revoke-all
```

Only one operator account is supported. No email reset flow, user registration, MFA, or distributed login rate limiting is provided. Do not confuse a revocable single-operator dashboard with a hosted identity service. Cookies are httpOnly, SameSite=Lax, path `/`, and Secure when `NODE_ENV=production`. Serve production behind HTTPS, set `TRUST_PROXY` so the per-client throttles see real client addresses, and add rate limiting at your reverse proxy as well before public deployment.

## Database access and migration

Phase A uses `SUPABASE_SERVICE_ROLE_KEY` **server-side only**. Never put it in frontend code, logs, a public environment file, or chat. The previous anon-key RPC design was not a safe auth boundary: SECURITY DEFINER read/replay RPCs granted to anon could be called directly, bypassing dashboard cookies. `migrations/008_phase_a.sql` revokes PUBLIC/anon/authenticated access to the gateway tables and old/new RPCs, and grants access to service_role. New RPCs pin an empty search path and fully qualify tables.

008 is an upgrade migration over the Phase 2-5 base schema (`webhook_events`, `circuit_breakers`, and the worker/DLQ/dashboard RPCs). The original base migrations were applied out-of-band and were never committed. `migrations/000_base_schema.sql` is a **reconstruction** of them from the application code, the behaviour the test double records, and what 008/009 assume exists. It is repeatable, so it can bootstrap a fresh database or be re-run over the live one without touching rows, but it has not yet been compared with the live definitions: paste `migrations/inspect_live_schema.sql` (read-only) into the SQL editor and diff its output, especially the function bodies in section 6, against 000 before treating 000 as the record of production. Points where the live value had to be guessed are marked "assumption" in the file. The migrations do not rewrite existing event destinations or register old source labels automatically.

Migration order, during a maintenance window:

1. Back up the database and stop old gateway/worker processes.
2. Run `migrations/inspect_live_schema.sql` and keep the output: it is the only record of the live schema before the change.
3. Review and apply, as the database owner in Supabase's SQL editor, `migrations/000_base_schema.sql` (fresh database only, or after confirming it matches the live definitions), then `008_phase_a.sql`, then `009_crash_safety_raw_body.sql`. Each is transactional and repeatable. `npm run test:migrations` applies the same sequence twice to a throwaway Postgres in Docker and drives every RPC through `migrations/selftest.sql`.
4. Set the server-only service-role key and per-source secrets, deploy this code, configure dashboard credentials, and register each source before reopening traffic.
5. Run `npm run verify:db`. It checks, with the service-role key, that every RPC and column the code uses exists, and, with `SUPABASE_ANON_KEY` set, that the anon key is denied on every gateway table and RPC. It is read-only: mutating RPCs are probed with a bogus argument that PostgREST rejects before any SQL runs.
6. Confirm signed ingest, delivery, login and copied-cookie logout revocation with a disposable source.

Old code using the anon key will fail after the migration. Reverting only the application is not a rollback. Do not restore anonymous RPC access on an internet-facing gateway; coordinate schema and application rollback together.

## Configuration

Create `.env.local` (gitignored). Do not commit real values. Protect this file and secret backups.

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
WG_SOURCE_PAYMENTS_SECRET=your-high-entropy-source-secret
# Generated by setup:auth:
# ADMIN_PASSWORD_HASH='...'
# SESSION_SECRET='...'
# Set NODE_ENV=production only when served over HTTPS.
# Behind a reverse proxy, tell Express which proxies to trust so req.ip (login
# throttle, ingest limits) is the real client: a hop count, "loopback", a CIDR
# list, or "true" (only if nothing can reach the port directly). Unset = none.
# TRUST_PROXY=1
# Ingest limits per minute, in memory per process; 0 disables.
# WG_INGEST_RATE_PER_MINUTE=600            # per source, all requests
# WG_INGEST_AUTH_FAILURES_PER_MINUTE=30    # per client address, 401/404 answers
```

Signing secret example generation: `openssl rand -hex 32`. Keep the generated value private and share it only through your sender's secure configuration path. Source secrets, the service-role key and session secret require secure collection, never chat.

## Deploy settings

Set `NODE_ENV=production` and serve the gateway over HTTPS so session cookies are Secure. Express leaves `trust proxy` off unless `TRUST_PROXY` is set. With exactly one trusted reverse proxy in front, set `TRUST_PROXY=1`; Express also accepts `loopback`, a CIDR or comma-separated list, or `true` (only when nothing can reach the port directly). Verify the actual proxy path with the host; do not assume every Render/Fly setup has one hop. Leave it unset for direct access. Multiple proxies need a separately reviewed value.

A wrong `trust proxy` setting can let callers spoof their client address through forwarded headers and bypass the per-address login throttle, even with a patched `proxy-addr`. Do not enable it blindly or allow a shorter route around the trusted proxy.

Build with dev dependencies, then omit them from the runtime install:

```bash
npm ci
npm run build
npm ci --omit=dev
NODE_ENV=production npm start
```

Localtunnel is dev-only and loaded only when requested. The compiled CLI can run without it: `node dist/cli.js start --no-tunnel`. Helmet adds security headers; dashboard scripts are same-origin files so the content security policy does not allow inline scripts.

## Running and tests

Node 22 or newer is recommended (locked dependencies include Commander 15).

```bash
npm ci
npm run build
npm test
npm run gateway -- --help
npm run gateway -- start --no-tunnel
```

`gateway start` runs server and worker in one process. Options: `--port <port>`, `--poll-interval <ms>`, `--no-tunnel`. The worker waits a 2-second gap after each poll finishes before starting the next (set with `--poll-interval`), so polls never overlap. Ctrl+C/SIGTERM shuts down the tunnel, server, then worker. `npm run dev` and `npm run worker` remain available separately. Avoid mixing old/new workers during migration.

Localtunnel is a development convenience: its URL is ephemeral, may show an interstitial, and is not a stable production endpoint. `start` opens a tunnel unless `--no-tunnel` is passed. Using a tunnel does not make the custom signatures compatible with a provider. No new paid service is required for Phase A.

```bash
npm run gateway -- dlq list
npm run gateway -- dlq replay <event-id>
```

Tests use fake Supabase RPC storage and real local HTTP receivers. They cover routing, source isolation, signing, idempotency, retries, DLQ/replay, breakers, session creation/revocation and failure handling. Passing these tests is not a live Supabase migration or deployment check. `npm run test:migrations` (Docker) checks the SQL itself against a real Postgres, and `npm run verify:db` checks the live project.

## Delivery rate limits

Each worker process uses a token bucket per exact destination URL. Defaults are 10 requests/second with a burst of 10. One outgoing attempt spends one token, including failed requests. If no token is available, the event returns to `pending` with `next_attempt_at` set to the next token time; attempts are unchanged. The worker does not sleep while holding a claim, so other destinations can continue. Actual delivery can be later than that time because of polling and queue load.

```dotenv
WG_DELIVERY_RATE_RPS=10
WG_DELIVERY_RATE_BURST=10
# Exact stored destination URLs, including path and trailing slash:
WG_DELIVERY_RATE_OVERRIDES='{"https://receiver.example/hook":{"rps":2,"burst":4}}'
```

Configuration is read once per process. Restart after changing it. `rps` must be finite and between 0.001 and 10000; `burst` must be an integer between 1 and 10000. Zero does not disable limiting: invalid settings stop worker startup before any database claim. An override must supply both fields. Different paths at one host are separate destinations; sources with the same stored URL share a bucket.

Refill uses a monotonic clock. Open circuit breakers defer without spending tokens; a due probe must still get a token. Rate deferral failures fall back to claim release/stale recovery, never unthrottled delivery. Buckets survive polls but not process restarts. Limits are **per process**, not a shared cap across workers or machines. Use a shared limiter before scaling out. At most 10000 active buckets are kept; capacity pressure defers new destinations until fully refilled buckets can be removed. Token buckets cap average rate and burst, not concurrent in-flight requests, and do not guarantee queue fairness.

## HTTP endpoints

- `GET /health`: public readiness check. Returns `200 {"status":"ok"}` when the database accepts a zero-row query for the ingest columns, including `raw_body`; returns `503 {"status":"unavailable"}` on missing schema, configuration or database access failure. The database request times out after 3 seconds. It creates no probe events. This detects a missing migration 009 column, but does not prove INSERT permissions, constraints or worker RPC readiness.
- `POST /webhooks/:source`: non-empty JSON body, 1 MB cap; source is 1-64 letters/digits/underscore/hyphen. `202` stored, `200` duplicate, `400` invalid input, `401` invalid signature, `415` body is not `application/json`, `404` unknown/disabled source, `413` oversized body, `429` with `Retry-After` when the source exceeds `WG_INGEST_RATE_PER_MINUTE` or the client address has exceeded `WG_INGEST_AUTH_FAILURES_PER_MINUTE` recent `401`/`404` answers, `503` unusable source configuration, `500` storage/server failure. Limits are checked before the registry is read.
- `POST /api/login`: `{ "password": "..." }`; creates cookie after credential and durable-session storage success.
- `POST /api/logout`: revokes this session and clears cookie. Still works with no/invalid cookie; reports failure if revocation storage is unavailable.
- `GET /api/events?status=...`: authenticated event table, latest 100; valid filters `pending`, `in_progress`, `delivered`, `failed`, `dead_lettered`. Payloads/headers excluded from dashboard response.
- `GET /api/circuit-breakers`: authenticated breaker list.
- `POST /api/events/:id/replay`: authenticated replay of a dead-lettered event; `409` if not found/not dead-lettered.
- `/login.html`, `/dashboard.html`: public static shells; data/replay are gated server-side.

## Remaining work before a public service

- Confirm the reconstructed `migrations/000_base_schema.sql` against the live project: run `migrations/inspect_live_schema.sql`, diff the function bodies, correct 000 where they differ, then run `npm run verify:db` to check RPC presence and that anon is locked out.
- Polls within one worker do not overlap, and open-breaker probes are leased across workers (010), so multiple worker processes can run; claims use the database's row locking.
- Add a distinct outbound secret per destination, destination controls appropriate for any multi-tenant use, retention, metrics and stable HTTPS hosting. Ingest and login limits are in-process; a shared limiter at the proxy is still needed for multi-instance deployments.
- Keep secrets separate from browser assets and logs. Service-role access has broad privileges; scope operational access to this dedicated gateway database.

## Phases

0. Recon
1. Skeleton
2. Ingest
3. Delivery worker
4. DLQ + circuit breaker
5. Dashboard
6. CLI + development tunnel (complete)
7. Production polish (Phase A in this branch; live migration/deployment pending)

### Dependency audit

The dependency patch updates Express/body-parser, `proxy-addr` and `qs` within their existing ranges. `npm audit --omit=dev` reports no runtime findings. Vitest was upgraded to 5 (with Vite 8), which cleared the test-runner findings (`@vitest/mocker`, `esbuild`, `tinypool`) without any test changes. The full audit's one remaining entry is axios 0.21 inside development-only localtunnel, reachable only when a developer opens a tunnel to loca.lt; replacing localtunnel would remove it. Re-run the audit before deployment because advisories change.

## Delivery safety (migration 009)

Apply `migrations/009_crash_safety_raw_body.sql` before running this version; ingest writes the new `raw_body` column and fails without it. Then apply `migrations/010_circuit_probe_lease.sql`; without it the worker logs once and probes open breakers unleased. Apply `migrations/011_signature_schemes.sql` as well: `sources set` calls the 4-argument `upsert_webhook_source` it defines (existing rows keep the `gateway` scheme and ingest for them is unchanged).

- Events are delivered as the exact bytes received, so integers above 2^53 and the sender's formatting arrive intact. Rows with an explicit NULL raw body (stored before the migration) fall back to the parsed payload. A failed raw-body read releases the batch for retry without spending delivery attempts; a missing or unreadable row is released too. No parsed-payload fallback is used on a read failure.
- A failure while handling one claimed event releases that event to `pending` instead of leaving it, and the rest of the batch, in `in_progress`.
- Events left `in_progress` for more than ten minutes (a crashed worker) are returned to `pending` on the next poll. Attempts are not incremented, so such an event can be delivered a second time; receivers should tolerate duplicates.
- Delivery does not follow redirects; a 3xx counts as a failed attempt.
- Dashboard login allows 5 failed attempts per client address per 15 minutes (50 across all clients), then answers `429` with `Retry-After`. Ingest allows `WG_INGEST_RATE_PER_MINUTE` requests per source and `WG_INGEST_AUTH_FAILURES_PER_MINUTE` failed authentications per client address, then `429`. All counters are in memory and reset on restart; set `TRUST_PROXY` behind a reverse proxy or every client shares one bucket.
