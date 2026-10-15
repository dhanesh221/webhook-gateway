import { performance } from "node:perf_hooks";

export interface RateLimit { rps: number; burst: number }
export interface DeliveryLimiter { take(destination: string): number }
interface Bucket { tokens: number; updatedAt: number }

function validate(value: unknown): RateLimit {
  const v = value as RateLimit;
  if (!v || typeof v !== "object" || !Number.isFinite(v.rps) || v.rps < 0.001 || v.rps > 10_000 ||
      !Number.isSafeInteger(v.burst) || v.burst < 1 || v.burst > 10_000) {
    throw new Error("Delivery rate requires rps between 0.001 and 10000 and integer burst between 1 and 10000");
  }
  return { rps: v.rps, burst: v.burst };
}

// Synchronous check-and-spend: overlapping async batches in this process cannot
// spend the same token. The clock is monotonic, not the system wall clock.
export class TokenBuckets implements DeliveryLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly defaults: RateLimit;
  private readonly overrides: Map<string, RateLimit>;
  constructor(defaults: RateLimit, overrides: Map<string, RateLimit> = new Map(),
    private readonly now: () => number = () => performance.now()) {
    this.defaults = validate(defaults);
    this.overrides = new Map([...overrides].map(([url, limit]) => [url, validate(limit)]));
  }

  // Zero permits one request; a positive value is the milliseconds until retry.
  // Denials do not reserve future tokens or consume delivery attempts.
  take(destination: string): number {
    const current = this.now();
    if (!Number.isFinite(current)) throw new Error("Invalid delivery rate clock");
    const limit = this.overrides.get(destination) ?? this.defaults;
    let bucket = this.buckets.get(destination);
    if (!bucket) {
      // Remove only buckets that have completely refilled: recreating those at
      // full capacity changes nothing. Keep partial buckets across poll cycles.
      if (this.buckets.size >= 10_000) {
        for (const [url, old] of this.buckets) {
          const rule = this.overrides.get(url) ?? this.defaults;
          if (current >= old.updatedAt && old.tokens + (current - old.updatedAt) * rule.rps / 1000 >= rule.burst) {
            this.buckets.delete(url);
          }
        }
        if (this.buckets.size >= 10_000) return 1000;
      }
      bucket = { tokens: limit.burst, updatedAt: current };
      this.buckets.set(destination, bucket);
    }
    // Defensive even with a monotonic clock: backwards test/custom clocks never
    // mint tokens or double-count time when they recover.
    const elapsed = Math.max(0, current - bucket.updatedAt);
    bucket.tokens = Math.min(limit.burst, bucket.tokens + elapsed * limit.rps / 1000);
    bucket.updatedAt = Math.max(current, bucket.updatedAt);
    if (bucket.tokens >= 1 - Number.EPSILON * 8) {
      bucket.tokens = Math.max(0, bucket.tokens - 1);
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) * 1000 / limit.rps - 1e-9));
  }
}

export function limiterFromEnv(env: NodeJS.ProcessEnv = process.env): TokenBuckets {
  const defaults = validate({ rps: Number(env.WG_DELIVERY_RATE_RPS ?? 10), burst: Number(env.WG_DELIVERY_RATE_BURST ?? 10) });
  let parsed: unknown;
  try { parsed = JSON.parse(env.WG_DELIVERY_RATE_OVERRIDES ?? "{}"); }
  catch { throw new Error("WG_DELIVERY_RATE_OVERRIDES must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WG_DELIVERY_RATE_OVERRIDES must be a JSON object");
  const overrides = new Map<string, RateLimit>();
  for (const [url, rule] of Object.entries(parsed)) {
    let destination: URL;
    try { destination = new URL(url); } catch { throw new Error("Invalid delivery rate destination URL"); }
    if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password || destination.hash) {
      throw new Error("Invalid delivery rate destination URL");
    }
    overrides.set(url, validate(rule));
  }
  return new TokenBuckets(defaults, overrides);
}

let shared: DeliveryLimiter | undefined;
export function defaultDeliveryLimiter(): DeliveryLimiter {
  return shared ??= limiterFromEnv();
}
