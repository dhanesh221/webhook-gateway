# webhook-gateway

A webhook ingest, delivery, and replay gateway — built in public, in phases.

Status: Phase 0 (Recon) complete. See the project journal for design notes, decisions, and progress.

## Phases

0. Recon
1. Skeleton
2. Ingest endpoint
3. Delivery worker (backoff + jitter)
4. Dead-letter queue + circuit breaker
5. Dashboard (auth + replay)
6. CLI (localhost tunnel)
7. Production polish
