import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeFakeSupabase } from "./fakeSupabase";
import { GatewayMetrics, gatewayMetrics, refreshDatabaseGauges, metricLabel, DURATION_BUCKETS } from "../src/metrics";
import { processPendingBatch } from "../src/deliveryWorker";
import { runRetention } from "../src/retention";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";

describe("operational series", () => {
  it("renders nothing extra until something is observed, then one HELP/TYPE per family", () => {
    const m = new GatewayMetrics();
    const base = m.render();
    expect(base.match(/^# TYPE /gm)).toHaveLength(10);
    m.count("webhook_worker_polls_total", "ok"); m.count("webhook_worker_polls_total", "ok"); m.count("webhook_worker_polls_total", "error");
    m.count("webhook_breaker_skips_total");
    const text = m.render();
    expect(text).toContain('webhook_worker_polls_total{result="ok"} 2\n');
    expect(text).toContain('webhook_worker_polls_total{result="error"} 1\n');
    expect(text).toContain("webhook_breaker_skips_total 1\n");
    expect(text.match(/^# TYPE webhook_worker_polls_total counter$/gm)).toHaveLength(1);
    expect(text.startsWith(base.trimEnd())).toBe(true); // existing families unchanged and first
  });

  it("rejects free-text label values and unknown names", () => {
    const m = new GatewayMetrics();
    expect(() => m.count("webhook_ingest_rejected_total", 'bad"\n# TYPE x')).toThrow();
    expect(() => m.count("webhook_worker_polls_total")).toThrow();          // label required
    expect(() => m.count("nope" as never)).toThrow();
    expect(() => m.setGauge("nope" as never, [])).toThrow();
    expect(() => m.setGauge("webhook_events_queued", [{ label: "pending", value: NaN }])).toThrow();
  });

  it("gauges replace the whole family and pseudonymise destinations", () => {
    const m = new GatewayMetrics();
    m.setGauge("webhook_circuit_breaker_open", [{ label: "https://a.test/private?token=1", value: 1 }, { label: "https://b.test/", value: 0 }]);
    let text = m.render();
    expect(text).toContain(`webhook_circuit_breaker_open{destination_id="${metricLabel("https://a.test/private?token=1")}"} 1`);
    expect(text).not.toContain("token=1");
    m.setGauge("webhook_circuit_breaker_open", [{ label: "https://b.test/", value: 0 }]);
    text = m.render();
    expect(text).not.toContain(metricLabel("https://a.test/private?token=1")); // stale row gone
    expect(text.match(/^webhook_circuit_breaker_open\{/gm)).toHaveLength(1);
  });

  it("histogram has cumulative buckets, +Inf, sum and count per outcome", () => {
    const m = new GatewayMetrics();
    m.observeDeliveryDuration(0.03, true); m.observeDeliveryDuration(0.7, true); m.observeDeliveryDuration(12, false);
    const text = m.render();
    expect(text).toContain('webhook_delivery_duration_seconds_bucket{ok="true",le="0.05"} 1');
    expect(text).toContain('webhook_delivery_duration_seconds_bucket{ok="true",le="1"} 2');
    expect(text).toContain('webhook_delivery_duration_seconds_bucket{ok="true",le="+Inf"} 2');
    expect(text).toContain('webhook_delivery_duration_seconds_count{ok="true"} 2');
    expect(text).toContain(`webhook_delivery_duration_seconds_bucket{ok="false",le="${DURATION_BUCKETS.at(-1)}"} 0`);
    expect(text).toContain('webhook_delivery_duration_seconds_bucket{ok="false",le="+Inf"} 1');
    expect(() => m.observeDeliveryDuration(-1, true)).toThrow();
  });
});

describe("instrumented paths", () => {
  let fake: ReturnType<typeof makeFakeSupabase>;
  beforeEach(() => {
    fake = makeFakeSupabase([]); holder.client = fake.client;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  const seriesValue = (m: GatewayMetrics, line: string) => {
    const match = m.render().match(new RegExp(`^${line.replace(/[{}"]/g, (c) => "\\" + c)} (\\d+(?:\\.\\d+)?)$`, "m"));
    return match ? Number(match[1]) : null;
  };

  it("times deliveries and counts breaker skips and rate-limit deferrals", async () => {
    const m = new GatewayMetrics();
    const url = "https://d.test/hook";
    fake.table.set("ok", { id: "ok", source: "s", attempts: 0, payload: {}, destination_url: url, status: "pending", raw_body: "{}" });
    await processPendingBatch(fake.client, async () => ({ ok: true, status: 200 }), { take: () => 0 }, m);
    expect(seriesValue(m, 'webhook_delivery_duration_seconds_count{ok="true"}')).toBe(1);

    fake.table.set("open", { id: "open", source: "s", attempts: 0, payload: {}, destination_url: url, status: "pending", raw_body: "{}" });
    fake.breakers.set(url, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() + 60_000).toISOString() });
    await processPendingBatch(fake.client, async () => ({ ok: true, status: 200 }), { take: () => 0 }, m);
    expect(seriesValue(m, "webhook_breaker_skips_total")).toBe(1);

    fake.breakers.delete(url);
    fake.table.set("slow", { id: "slow", source: "s", attempts: 0, payload: {}, destination_url: url, status: "pending", raw_body: "{}" });
    fake.table.get("open")!.status = "delivered";
    const out = await processPendingBatch(fake.client, async () => ({ ok: true, status: 200 }), { take: () => 500 }, m);
    expect(out.map((o) => o.outcome)).toEqual(["rate_limited"]);
    expect(seriesValue(m, "webhook_rate_limited_total")).toBe(1);
    expect(seriesValue(m, 'webhook_delivery_duration_seconds_count{ok="true"}')).toBe(1); // deferrals are not timed
  });

  it("refreshes queue depth and breaker gauges from the database", async () => {
    const m = new GatewayMetrics();
    fake.table.set("p1", { id: "p1", source: "s", attempts: 0, payload: {}, destination_url: "https://x/", status: "pending" });
    fake.table.set("p2", { id: "p2", source: "s", attempts: 0, payload: {}, destination_url: "https://x/", status: "pending" });
    fake.table.set("d1", { id: "d1", source: "s", attempts: 5, payload: {}, destination_url: "https://x/", status: "dead_lettered" });
    fake.breakers.set("https://x/", { state: "open", consecutiveFailures: 7, nextProbeAt: null });
    await refreshDatabaseGauges(fake.client as never, m);
    expect(seriesValue(m, 'webhook_events_queued{status="pending"}')).toBe(2);
    expect(seriesValue(m, 'webhook_events_queued{status="dead_lettered"}')).toBe(1);
    expect(seriesValue(m, `webhook_circuit_breaker_open{destination_id="${metricLabel("https://x/")}"}`)).toBe(1);
    expect(seriesValue(m, `webhook_circuit_breaker_consecutive_failures{destination_id="${metricLabel("https://x/")}"}`)).toBe(7);
    expect(m.render()).not.toContain("https://x/");
  });

  it("surfaces a missing 013 RPC instead of writing partial gauges", async () => {
    const m = new GatewayMetrics();
    vi.spyOn(fake.client, "rpc").mockResolvedValue({ data: null, error: { message: "function does not exist" } } as never);
    await expect(refreshDatabaseGauges(fake.client as never, m)).rejects.toThrow(/count_webhook_events_by_status/);
    expect(m.render()).not.toContain("webhook_events_queued");
  });

  it("counts rejected ingest answers by status code only", async () => {
    const before = seriesValue(gatewayMetrics, 'webhook_ingest_rejected_total{status="404"}') ?? 0;
    const before400 = seriesValue(gatewayMetrics, 'webhook_ingest_rejected_total{status="400"}') ?? 0;
    expect((await request(app).post("/webhooks/unknown-src").set("Content-Type", "application/json").send("{}")).status).toBe(404);
    expect((await request(app).post("/webhooks/bad name").set("Content-Type", "application/json").send("{}")).status).toBe(400);
    expect(seriesValue(gatewayMetrics, 'webhook_ingest_rejected_total{status="404"}')).toBe(before + 1);
    expect(seriesValue(gatewayMetrics, 'webhook_ingest_rejected_total{status="400"}')).toBe(before400 + 1);
    expect(gatewayMetrics.render()).not.toContain("unknown-src");
  });

  it("counts rows removed by retention", async () => {
    const before = seriesValue(gatewayMetrics, 'webhook_retention_purged_total{kind="delivered"}') ?? 0;
    fake.table.set("old", { id: "old", source: "s", attempts: 0, payload: {}, destination_url: "https://x/", status: "delivered", updated_at: Date.now() - 40 * 86_400_000 });
    await runRetention(fake.client, { deliveredDays: 30, deadLetteredDays: 0 });
    expect(seriesValue(gatewayMetrics, 'webhook_retention_purged_total{kind="delivered"}')).toBe(before + 1);
  });
});
