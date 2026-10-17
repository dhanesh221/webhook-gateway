// Ingest rate limits. In memory and per process, like the login throttle: a
// first line of defence that keeps one noisy sender or one probing client from
// monopolising the database, not a distributed quota. Put a real limiter at the
// reverse proxy as well before public deployment.
//
// Two independent windows, each one minute long:
//
// - per source: every request that names an existing source counts, accepted or
//   not. WG_INGEST_RATE_PER_MINUTE (default 600). Protects storage from a sender
//   gone haywire; the sender sees 429 + Retry-After and, if it is a real
//   provider, retries later.
// - per client address: only requests answered 401 or 404 count, i.e. bad
//   signatures and unknown/disabled sources. WG_INGEST_AUTH_FAILURES_PER_MINUTE
//   (default 30). Secrets are 32+ random bytes, so this is not what stops a
//   brute force; it stops the log noise and database reads a scanner causes.
//
// The client address is req.ip, which is the socket peer unless TRUST_PROXY is
// set (see app.ts). Set either limit to 0 to disable it.

export const WINDOW_MS = 60 * 1000;
export const DEFAULT_SOURCE_RATE_PER_MINUTE = 600;
export const DEFAULT_AUTH_FAILURES_PER_MINUTE = 30;

// Read at call time so tests, and operators restarting with a new .env.local,
// see the current value. A missing or unparsable value means the default.
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number = WINDOW_MS) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.hits.delete(key); else this.hits.set(key, list);
    return list;
  }

  // Seconds until the oldest hit leaves the window, or 0 when under the limit.
  retryAfterSeconds(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    const list = this.recent(key, now);
    if (list.length < limit) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
  }

  hit(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    // Bound memory: when many distinct keys have been seen, drop the idle ones.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }

  reset(): void { this.hits.clear(); }
}

const perSource = new SlidingWindow();
const perClientFailures = new SlidingWindow();

// Counts the request against its source and says how long to wait if the
// source is over its limit.
export function sourceRetryAfterSeconds(source: string, now = Date.now()): number {
  const limit = envLimit("WG_INGEST_RATE_PER_MINUTE", DEFAULT_SOURCE_RATE_PER_MINUTE);
  const wait = perSource.retryAfterSeconds(source, limit, now);
  if (wait === 0) perSource.hit(source, now);
  return wait;
}

export function clientRetryAfterSeconds(client: string, now = Date.now()): number {
  const limit = envLimit("WG_INGEST_AUTH_FAILURES_PER_MINUTE", DEFAULT_AUTH_FAILURES_PER_MINUTE);
  return perClientFailures.retryAfterSeconds(client, limit, now);
}

export function recordClientAuthFailure(client: string, now = Date.now()): void {
  perClientFailures.hit(client, now);
}

export function resetIngestLimits(): void {
  perSource.reset();
  perClientFailures.reset();
}
