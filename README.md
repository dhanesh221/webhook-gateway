# webhook-gateway

A webhook ingest, delivery, and replay gateway. It's a portfolio project that demonstrates the parts of backend engineering most junior portfolios skip: retrying failed deliveries safely, avoiding duplicate side effects (idempotency), routing permanently-failed messages to a dead-letter queue, and using a circuit breaker to stop hammering a downstream service that's down.

Status: Phase 1 (Skeleton).

## Stack

- **Node.js + TypeScript** — typed JavaScript, catches whole classes of bugs before the code even runs.
- **Express** — the most common Node.js web server framework, and the one interviewers ask about most.
- **Vitest** — the test runner. Chosen over Jest because it needs almost no configuration to work with TypeScript, and it's fast.
- **Supertest** — lets tests call HTTP endpoints (like `/health`) directly, without starting a real server on a real port.

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
