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

// Operational series added alongside the five event counters. They carry no
// route labels except the pseudonymous destination_id on breaker gauges, and a
// family is rendered only once it has data, so a process that never used a
// feature exposes nothing for it.
export const EXTRA_COUNTERS = {
  webhook_worker_polls_total: { label: "result", help: "Worker poll cycles by result (ok, error)." },
  webhook_breaker_skips_total: { label: null, help: "Events deferred because the destination's circuit breaker was open or its probe was leased elsewhere." },
  webhook_rate_limited_total: { label: null, help: "Events deferred by the per-destination delivery rate limit." },
  webhook_ingest_rejected_total: { label: "status", help: "Ingest requests answered with a non-2xx status, by HTTP status code." },
  webhook_retention_purged_total: { label: "kind", help: "Rows removed by retention (delivered, dead_lettered, sessions)." },
} as const;
export type ExtraCounter = keyof typeof EXTRA_COUNTERS;
export const GAUGES = {
  webhook_events_queued: { label: "status", help: "Events in the database by status, refreshed by the worker about once a minute." },
  webhook_circuit_breaker_open: { label: "destination_id", help: "1 when the destination's breaker is open (pseudonymous destination id)." },
  webhook_circuit_breaker_consecutive_failures: { label: "destination_id", help: "Consecutive delivery failures per destination (pseudonymous destination id)." },
} as const;
export type Gauge = keyof typeof GAUGES;
export const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LABEL_VALUE = /^[a-z0-9_]{1,64}$/;

function labelled(name: string, label: string | null, value: string | null): string {
  return label && value !== null ? `${name}{${label}="${value}"}` : name;
}

export class GatewayMetrics {
  private readonly totals = counts();
  private readonly routes = new Map<string, { source: string; destination: string; counts: Counts }>();
  private readonly overflow = counts();
  private readonly extra = new Map<ExtraCounter, Map<string | null, bigint>>();
  private readonly gauges = new Map<Gauge, Map<string | null, number>>();
  private readonly durations = new Map<"true" | "false", { buckets: number[]; sum: number; count: number }>();

  // Counters with at most one enumerated label (never free text).
  count(name: ExtraCounter, value: string | null = null, amount = 1n): void {
    const spec = EXTRA_COUNTERS[name];
    if (!spec) throw new Error("Unknown counter");
    if (spec.label && (value === null || !LABEL_VALUE.test(value))) throw new Error("Invalid label value");
    if (!spec.label) value = null;
    const series = this.extra.get(name) ?? new Map<string | null, bigint>();
    series.set(value, (series.get(value) ?? 0n) + amount);
    this.extra.set(name, series);
  }

  // Replaces the whole family: a refresh reports every current row, so stale
  // destinations drop out instead of lingering at their last value.
  setGauge(name: Gauge, samples: { label: string | null; value: number }[]): void {
    if (!GAUGES[name]) throw new Error("Unknown gauge");
    const series = new Map<string | null, number>();
    for (const sample of samples) {
      if (!Number.isFinite(sample.value)) throw new Error("Gauge values must be finite");
      const label = GAUGES[name].label === "destination_id" ? metricLabel(sample.label) : sample.label;
      if (GAUGES[name].label && (label === null || !/^[a-z0-9_]{1,64}$/.test(label))) throw new Error("Invalid label value");
      series.set(label, sample.value);
    }
    this.gauges.set(name, series);
  }

  observeDeliveryDuration(seconds: number, ok: boolean): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Duration must be a non-negative number");
    const key = ok ? "true" : "false";
    let h = this.durations.get(key);
    if (!h) { h = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }; this.durations.set(key, h); }
    DURATION_BUCKETS.forEach((b, i) => { if (seconds <= b) h!.buckets[i] += 1; });
    h.sum += seconds; h.count += 1;
  }

  private renderExtras(lines: string[]): void {
    for (const [name, series] of this.extra) {
      const spec = EXTRA_COUNTERS[name];
      lines.push(`# HELP ${name} ${spec.help}`, `# TYPE ${name} counter`);
      for (const [value, n] of series) lines.push(`${labelled(name, spec.label, value)} ${n}`);
    }
    for (const [name, series] of this.gauges) {
      const spec = GAUGES[name];
      lines.push(`# HELP ${name} ${spec.help}`, `# TYPE ${name} gauge`);
      for (const [value, n] of series) lines.push(`${labelled(name, spec.label, value)} ${n}`);
    }
    if (this.durations.size > 0) {
      const name = "webhook_delivery_duration_seconds";
      lines.push(`# HELP ${name} Time spent on one delivery HTTP request, by whether it succeeded.`, `# TYPE ${name} histogram`);
      for (const [ok, h] of this.durations) {
        DURATION_BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{ok="${ok}",le="${b}"} ${h.buckets[i]}`));
        lines.push(`${name}_bucket{ok="${ok}",le="+Inf"} ${h.count}`, `${name}_sum{ok="${ok}"} ${h.sum}`, `${name}_count{ok="${ok}"} ${h.count}`);
      }
    }
  }

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
    this.renderExtras(lines);
    return lines.join("\n") + "\n";
  }
}

export const gatewayMetrics = new GatewayMetrics();

// Queue depth and breaker state come from the database. The worker calls this
// about once a minute so scrapes themselves never touch the database.
export async function refreshDatabaseGauges(
  supabase: { rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }> },
  metrics: GatewayMetrics = gatewayMetrics
): Promise<void> {
  const [counts, breakers] = await Promise.all([
    supabase.rpc("count_webhook_events_by_status"),
    supabase.rpc("list_circuit_breakers"),
  ]);
  if (counts.error) throw new Error(`count_webhook_events_by_status failed: ${counts.error.message}`);
  if (breakers.error) throw new Error(`list_circuit_breakers failed: ${breakers.error.message}`);
  const rows = (counts.data ?? []) as { status: string; count: number | string }[];
  metrics.setGauge("webhook_events_queued", rows.map((r) => ({ label: r.status, value: Number(r.count) })));
  const b = (breakers.data ?? []) as { destination_url: string; state: string; consecutive_failures: number }[];
  metrics.setGauge("webhook_circuit_breaker_open", b.map((x) => ({ label: x.destination_url, value: x.state === "open" ? 1 : 0 })));
  metrics.setGauge("webhook_circuit_breaker_consecutive_failures", b.map((x) => ({ label: x.destination_url, value: x.consecutive_failures })));
}

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
