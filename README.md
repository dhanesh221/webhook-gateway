# webhook-gateway

An HTTP webhook ingest, delivery, and replay gateway. It stores accepted events in Supabase/Postgres, delivers them to registered source destinations, retries failures with jittered backoff, holds exhausted events in a dead-letter queue, and provides a dashboard for inspection and replay.

Status: Phase 7, production-polish work. Phase 6 (CLI + development tunnel) is complete. This is a single-operator gateway, not a multi-tenant service or a claim of production readiness.

## Delivery contract

Ingest returns `202` after an event is stored. An optional `Idempotency-Key` deduplicates ingest within a source; a duplicate returns `200`. Without that header, repeated requests are separate events. The worker makes up to five attempts, with full-jitter exponential waits capped at five minutes. Failed events enter the DLQ, where they can be replayed.

Delivery is **at least once**, not exactly once. If the destination accepts an event but the gateway fails before recording success, a retry may repeat the side effect. Downstream applications must implement their own deduplication. An `in_progress` event abandoned by a crashed worker is returned to `pending` after ten minutes (migration 009) without using an attempt, so it may be delivered again.

Circuit breakers are shared by destination URL: five consecutive failures open a breaker for 60 seconds, then a delivery probes it. Breaker skips do not consume event attempts. Sources using the same URL share a breaker.

## Phase A changes

### Registered sources and routing

`webhook_sources` stores `name`, `destination_url`, `secret_env`, `enabled`, and `updated_at`. Each source has one destination. The destination is copied into the event when it is received. Updating or disabling a source affects new ingest only: queued events and DLQ replays keep their original destination. Disabling a source does not cancel queued delivery.

The signing secret itself is **not in the database**. `secret_env` references a server environment variable such as `WG_SOURCE_PAYMENTS_SECRET`. Its name must match `WG_SOURCE_[A-Z0-9_]+_SECRET`, and its value must contain at least 32 UTF-8 bytes. Generate a high-entropy value, not a 32-character human password. Use a different variable and secret for every source. The name convention does not enforce uniqueness across rows; operators are responsible for not sharing a secret.

Destinations must be HTTPS. Loopback HTTP (`localhost`, `127.0.0.1`, or `::1`) is allowed only outside `NODE_ENV=production`. Embedded URL credentials and fragments are rejected. Only trusted operators may manage sources. This URL check is not an SSRF sandbox: DNS can resolve public-looking names to private addresses. Delivery does not follow redirects; a 3xx counts as a failed attempt. Do not expose source management to untrusted tenants. Multi-subscriber routing should add a subscriptions table and separate per-subscriber delivery records, rather than treating one event's status as the status of several deliveries.

```bash
npm run gateway -- sources set payments https://receiver.example/hook WG_SOURCE_PAYMENTS_SECRET
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

This is a **custom protocol**, not a native GitHub or Stripe adapter. GitHub's `X-Hub-Signature-256` and Stripe's `Stripe-Signature` are not accepted directly. Provider-specific adapters are future work; a label named `stripe` does not make this Stripe-compatible.

Authentication headers (`X-Webhook-Signature`, `Authorization`, `Cookie`) are excluded from stored event headers. Payloads and other headers may still contain sensitive data; set retention and access rules accordingly.

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

Only one operator account is supported. No email reset flow, user registration, MFA, or distributed login rate limiting is provided. Do not confuse a revocable single-operator dashboard with a hosted identity service. Cookies are httpOnly, SameSite=Lax, path `/`, and Secure when `NODE_ENV=production`. Serve production behind HTTPS and protect login with rate limiting at your reverse proxy before public deployment.

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
```

Signing secret example generation: `openssl rand -hex 32`. Keep the generated value private and share it only through your sender's secure configuration path. Source secrets, the service-role key and session secret require secure collection, never chat.

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

## HTTP endpoints

- `GET /health`: public, `200 {"status":"ok"}`. Liveness only, not a database readiness check.
- `POST /webhooks/:source`: non-empty JSON body, 1 MB cap; source is 1-64 letters/digits/underscore/hyphen. `202` stored, `200` duplicate, `400` invalid input, `401` invalid signature, `415` body is not `application/json`, `404` unknown/disabled source, `413` oversized body, `503` unusable source configuration, `500` storage/server failure.
- `POST /api/login`: `{ "password": "..." }`; creates cookie after credential and durable-session storage success.
- `POST /api/logout`: revokes this session and clears cookie. Still works with no/invalid cookie; reports failure if revocation storage is unavailable.
- `GET /api/events?status=...`: authenticated event table, latest 100; valid filters `pending`, `in_progress`, `delivered`, `failed`, `dead_lettered`. Payloads/headers excluded from dashboard response.
- `GET /api/circuit-breakers`: authenticated breaker list.
- `POST /api/events/:id/replay`: authenticated replay of a dead-lettered event; `409` if not found/not dead-lettered.
- `/login.html`, `/dashboard.html`: public static shells; data/replay are gated server-side.

## Remaining work before a public service

- Confirm the reconstructed `migrations/000_base_schema.sql` against the live project: run `migrations/inspect_live_schema.sql`, diff the function bodies, correct 000 where they differ, then run `npm run verify:db` to check RPC presence and that anon is locked out.
- Add abandoned-claim recovery/leases, stable event IDs in downstream delivery and downstream idempotency. Polls within one worker no longer overlap; investigate circuit-breaker probe concurrency across multiple worker processes before scaling workers.
- Add provider-native signature adapters and outbound signing, destination controls appropriate for any multi-tenant use, stronger identity/rate limiting, retention, metrics and stable HTTPS hosting.
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

### Dependency audit at Phase A review

`npm audit --omit=dev` reported five pre-existing runtime vulnerabilities (three moderate, two high), involving localtunnel's axios and `qs` through Express/body-parser. No forced downgrade was applied. Treat localtunnel as development-only; resolve the dependency audit before public deployment. Phase A adds no runtime dependencies.

## Delivery safety (migration 009)

Apply `migrations/009_crash_safety_raw_body.sql` before running this version; ingest writes the new `raw_body` column and fails without it.

- Events are delivered as the exact bytes received, so integers above 2^53 and the sender's formatting arrive intact. Rows stored before the migration fall back to the parsed payload.
- A failure while handling one claimed event releases that event to `pending` instead of leaving it, and the rest of the batch, in `in_progress`.
- Events left `in_progress` for more than ten minutes (a crashed worker) are returned to `pending` on the next poll. Attempts are not incremented, so such an event can be delivered a second time; receivers should tolerate duplicates.
- Delivery does not follow redirects; a 3xx counts as a failed attempt.
- Dashboard login allows 5 failed attempts per client address per 15 minutes (50 across all clients), then answers `429` with `Retry-After`. The counters are in memory and reset on restart.
