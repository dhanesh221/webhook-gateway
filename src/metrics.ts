import { createHash, timingSafeEqual } from "node:crypto";

export const METRIC_KINDS = ["received", "delivered", "failed", "retried", "dead_lettered"] as const;
export type MetricKind = typeof METRIC_KINDS[number];
export const MAX_METRIC_ROUTES = 1000;
// Far beyond a process lifetime, but below the float range accepted by Prometheus.
export const MAX_METRIC_COUNT = 10n ** 100n;
const HELP: Record<MetricKind, string> = {
  received: "New webhook events successfully stored in this process.",
  delivered: "Delivery attempts that returned success, regardless of database accounting.",
  failed: "Failed delivery attempts, including missing destinations.",
  retried: "Failed events successfully scheduled for retry in the database.",
  dead_lettered: "Failed events successfully moved to the dead-letter queue in the database.",
};
type Counts = Record<MetricKind, bigint>;
const counts = (): Counts => ({ received: 0n, delivered: 0n, failed: 0n, retried: 0n, dead_lettered: 0n });

// Hashes are pseudonyms, not encryption. Never expose raw URLs, source text,
// credentials, query strings, payloads, headers or event IDs as metric labels.
export function metricLabel(value: string | null): string {
  if (value === null) return "missing";
  if (value.length > 4096) return "oversized";
  return createHash("sha256").update(value).digest("hex");
}

export class GatewayMetrics {
  private readonly totals = counts();
  private readonly routes = new Map<string, { source: string; destination: string; counts: Counts }>();
  private readonly overflow = counts();

  increment(kind: MetricKind, source: string, destination: string | null, amount = 1n): void {
    if (typeof amount !== "bigint" || amount < 0n) throw new Error("Counter increments must be non-negative bigint values");
    if (!METRIC_KINDS.includes(kind) || this.totals[kind] + amount > MAX_METRIC_COUNT) throw new Error("Counter exceeds supported range");
    if (amount === 0n) return;
    const s = metricLabel(source);
    const d = metricLabel(destination);
    const key = `${s}:${d}`;
    let route = this.routes.get(key);
    if (!route && this.routes.size < MAX_METRIC_ROUTES) {
      route = { source: s, destination: d, counts: counts() };
      this.routes.set(key, route);
    }
    this.totals[kind] += amount;
    (route?.counts ?? this.overflow)[kind] += amount;
  }

  render(): string {
    const lines: string[] = [];
    for (const kind of METRIC_KINDS) {
      const name = `webhook_events_${kind}_total`;
      lines.push(`# HELP ${name} ${HELP[kind]}`, `# TYPE ${name} counter`, `${name} ${this.totals[kind]}`);
      const detailed = `webhook_events_${kind}_by_route_total`;
      lines.push(`# HELP ${detailed} ${HELP[kind]} Split by bounded pseudonymous route IDs.`, `# TYPE ${detailed} counter`);
      for (const route of this.routes.values()) {
        lines.push(`${detailed}{source_id="${route.source}",destination_id="${route.destination}"} ${route.counts[kind]}`);
      }
      lines.push(`${detailed}{source_id="overflow",destination_id="overflow"} ${this.overflow[kind]}`);
    }
    return lines.join("\n") + "\n";
  }
}

export const gatewayMetrics = new GatewayMetrics();

// Hash first so timingSafeEqual compares equal-sized buffers. Never accept a
// blank token or a query-string token, and do not depend on database health.
export function hasMetricsBearer(authorization: string | undefined): boolean {
  const expected = process.env.WG_METRICS_TOKEN;
  if (!expected || expected.trim().length < 32 || expected.length > 4096 || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  if (supplied.length > 4096) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}
