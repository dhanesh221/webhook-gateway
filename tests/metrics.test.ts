import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayMetrics, METRIC_KINDS, MAX_METRIC_ROUTES, MAX_METRIC_COUNT, metricLabel, hasMetricsBearer } from "../src/metrics";
const total = (m: GatewayMetrics, k: string) => BigInt(m.render().match(new RegExp(`^webhook_events_${k}_total (\\d+)$`, "m"))![1]);
afterEach(() => vi.unstubAllEnvs());

describe("bounded Prometheus counters", () => {
  it("exports all five totals at zero before any traffic", () => {
    const m = new GatewayMetrics();
    for (const kind of METRIC_KINDS) expect(total(m, kind)).toBe(0n);
  });
  it.each(METRIC_KINDS)("increments only %s, with matching route and total", kind => {
    const m = new GatewayMetrics(); m.increment(kind, "github", "https://a.test/hook");
    for (const k of METRIC_KINDS) expect(total(m, k)).toBe(k === kind ? 1n : 0n);
    expect(m.render()).toContain(`webhook_events_${kind}_by_route_total{source_id="${metricLabel("github")}",destination_id="${metricLabel("https://a.test/hook")}"} 1\n`);
  });
  it("keeps different sources and exact destination paths separate", () => {
    const m = new GatewayMetrics();
    for (const s of ["a", "b"]) for (const d of ["https://x/a", "https://x/a/", "https://x/b"]) m.increment("received", s, d);
    expect(total(m, "received")).toBe(6n);
    expect(m.render().split("\n").filter(l => l.startsWith("webhook_events_received_by_route_total{"))).toHaveLength(7);
  });
  it("has distinct missing, empty and oversized label IDs", () => {
    expect(new Set([metricLabel(null), metricLabel(""), metricLabel("x".repeat(4097))]).size).toBe(3);
    expect(metricLabel("x".repeat(4096))).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['bad"\n# TYPE injected gauge', "back\\slash", "🔐\u0000\rsecret", "https://user:password@host/path-token?secret=abc#private", "__proto__", "constructor"])("never prints raw labels: %s", input => {
    const m = new GatewayMetrics(); m.increment("failed", input, input);
    expect(m.render()).not.toContain(input);
    expect(m.render()).not.toContain("injected gauge");
  });
  it("caps label routes globally, preserves totals and updates old routes after cap", () => {
    const m = new GatewayMetrics();
    for (let i = 0; i < 20000; i++) m.increment("received", `s${i}`, `https://h/${i}`);
    m.increment("received", "s0", "https://h/0");
    expect(total(m, "received")).toBe(20001n);
    expect(m.render()).toContain('source_id="overflow",destination_id="overflow"} 19000\n');
    expect(m.render()).toContain(`source_id="${metricLabel("s0")}",destination_id="${metricLabel("https://h/0")}"} 2\n`);
    expect(m.render().split("\n").filter(l => l && !l.startsWith("#"))).toHaveLength(5 + 5 * (MAX_METRIC_ROUTES + 1));
    expect(Buffer.byteLength(m.render())).toBeLessThan(1200000);
  });
  it("does not confuse a user string named overflow with the overflow bucket", () => {
    const m = new GatewayMetrics(); m.increment("received", "overflow", "overflow");
    expect(m.render()).toContain('source_id="overflow",destination_id="overflow"} 0');
  });
  it("survives concurrently queued increments without lost counts", async () => {
    const m = new GatewayMetrics();
    await Promise.all(Array.from({ length: 20000 }, () => Promise.resolve().then(() => m.increment("failed", "s", "d"))));
    expect(total(m, "failed")).toBe(20000n);
  });
  it("retains integer precision beyond Number.MAX_SAFE_INTEGER", () => {
    const m = new GatewayMetrics(); const large = 9007199254740992n;
    m.increment("received", "s", "d", large); m.increment("received", "s", "d");
    expect(total(m, "received")).toBe(large + 1n);
    m.increment("received", "s", "d", 10n ** 30n);
    expect(total(m, "received")).toBe(10n ** 30n + large + 1n);
    expect(m.render()).not.toMatch(/NaN|Infinity/);
  });
  it.each([-1n, 1, NaN, Infinity, 0.5])("rejects invalid increments %s before mutation", amount => {
    const m = new GatewayMetrics(); expect(() => m.increment("failed", "s", "d", amount as bigint)).toThrow();
    expect(total(m, "failed")).toBe(0n);
  });
  it("rejects values beyond the exposition float range without partial updates", () => {
    const m = new GatewayMetrics(); const before = m.render();
    expect(() => m.increment("failed", "s", "d", 10n ** 309n)).toThrow();
    expect(m.render()).toBe(before);
    m.increment("failed", "s", "d", MAX_METRIC_COUNT);
    const full = m.render(); expect(() => m.increment("failed", "s", "d")).toThrow(); expect(m.render()).toBe(full);
  });
  it("rejects invalid runtime metric names before mutation", () => {
    const m = new GatewayMetrics(); const before = m.render();
    expect(() => m.increment("__proto__" as any, "s", "d")).toThrow(); expect(m.render()).toBe(before);
  });
  it("zero increments neither create a route nor change counts", () => {
    const m = new GatewayMetrics(); const before = m.render(); m.increment("received", "s", "d", 0n);
    expect(m.render()).toBe(before);
  });
  it("renders stable valid line-oriented exposition with one HELP/TYPE per family", () => {
    const m = new GatewayMetrics(); m.increment("delivered", "s", "d");
    const text = m.render(); expect(m.render()).toBe(text); expect(text.endsWith("\n")).toBe(true);
    const seen = new Set<string>();
    for (const line of text.trimEnd().split("\n")) {
      if (line.startsWith("#")) expect(line).toMatch(/^# (HELP|TYPE) [a-z_]+ .+$/);
      else {
        expect(line).toMatch(/^[a-z_]+(?:\{source_id="(?:[a-f0-9]{64}|overflow|missing|oversized)",destination_id="(?:[a-f0-9]{64}|overflow|missing|oversized)"\})? \d+$/);
        const sample = line.split(" ")[0]; expect(seen.has(sample)).toBe(false); seen.add(sample);
      }
    }
    expect(text.match(/^# TYPE /gm)).toHaveLength(10); expect(text.match(/^# HELP /gm)).toHaveLength(10);
  });
  it("new instances reset independently", () => {
    const m = new GatewayMetrics(); m.increment("failed", "s", "d");
    expect(total(new GatewayMetrics(), "failed")).toBe(0n); expect(total(m, "failed")).toBe(1n);
  });
});

describe("metrics bearer", () => {
  const token = "test-scrape-token-at-least-32-characters";
  it("requires a configured token, with exact match", () => {
    vi.stubEnv("WG_METRICS_TOKEN", token);
    expect(hasMetricsBearer(`Bearer ${token}`)).toBe(true);
    expect(hasMetricsBearer(`Bearer ${token}extra`)).toBe(false);
  });
  it.each([undefined, "", "Bearer ", "Basic anything", "bearer wrong", "Bearer " + "x".repeat(4097)])("rejects missing/malformed/wrong authorization %s", auth => {
    vi.stubEnv("WG_METRICS_TOKEN", token); expect(hasMetricsBearer(auth)).toBe(false);
  });
  it.each(["", " ".repeat(40), "short", "x".repeat(4097)])("fails closed for bad token configuration", config => {
    vi.stubEnv("WG_METRICS_TOKEN", config); expect(hasMetricsBearer(`Bearer ${config}`)).toBe(false);
  });
  it("revokes access immediately when the environment token rotates", () => {
    vi.stubEnv("WG_METRICS_TOKEN", token); expect(hasMetricsBearer(`Bearer ${token}`)).toBe(true);
    vi.stubEnv("WG_METRICS_TOKEN", token + "new"); expect(hasMetricsBearer(`Bearer ${token}`)).toBe(false);
  });
});
