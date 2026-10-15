import { describe, it, expect, vi, afterEach } from "vitest";
import { processPendingBatch, type ClaimedWebhookEvent } from "../src/deliveryWorker";
import { GatewayMetrics } from "../src/metrics";
import { TokenBuckets } from "../src/rateLimit";
import { makeFakeSupabase } from "./fakeSupabase";
const destination = "https://receiver.test/private?token=secret";
const event = (attempts = 0, dest: string | null = destination): ClaimedWebhookEvent => ({ id: "evt", source: "github", attempts, payload: { secret: "payload-secret" }, destination_url: dest });
function setup(row = event()) {
  const db = makeFakeSupabase([row], { failureThreshold: 100 });
  const metrics = new GatewayMetrics(); const limiter = new TokenBuckets({ rps: 100, burst: 100 });
  const run = (deliver = async () => ({ ok: true })) => processPendingBatch(db.client, deliver, limiter, metrics);
  return { ...db, metrics, limiter, run };
}
function total(m: GatewayMetrics, kind: string) { return Number(m.render().match(new RegExp(`^webhook_events_${kind}_total (\\d+)$`, "m"))![1]); }
afterEach(() => vi.restoreAllMocks());

describe("worker metrics", () => {
  it("counts actual success once, not subsequent empty polls", async () => {
    const d = setup(); await d.run(); await d.run();
    expect(total(d.metrics, "delivered")).toBe(1); expect(total(d.metrics, "failed")).toBe(0);
  });
  it("counts two failures, two DB retries, then success", async () => {
    const d = setup(); await d.run(async () => ({ ok: false })); await d.run(async () => ({ ok: false })); await d.run();
    expect(total(d.metrics, "failed")).toBe(2); expect(total(d.metrics, "retried")).toBe(2);
    expect(total(d.metrics, "delivered")).toBe(1); expect(total(d.metrics, "dead_lettered")).toBe(0);
  });
  it("counts the final failed attempt as DLQ, not another retry", async () => {
    const d = setup(event(4)); await d.run(async () => ({ ok: false }));
    expect(total(d.metrics, "failed")).toBe(1); expect(total(d.metrics, "dead_lettered")).toBe(1); expect(total(d.metrics, "retried")).toBe(0);
  });
  it("counts all five attempts and only four retries across a full failure lifecycle", async () => {
    const d = setup(); for (let i = 0; i < 6; i++) await d.run(async () => ({ ok: false }));
    expect(total(d.metrics, "failed")).toBe(5); expect(total(d.metrics, "retried")).toBe(4); expect(total(d.metrics, "dead_lettered")).toBe(1);
  });
  it("counts missing destination failure with missing label", async () => {
    const d = setup(event(0, null)); await d.run();
    expect(total(d.metrics, "failed")).toBe(1); expect(d.metrics.render()).toContain('destination_id="missing"} 1');
  });
  it("counts delivery exceptions as one failure, not twice", async () => {
    const d = setup(); await d.run(async () => { throw new Error("timeout-secret"); });
    expect(total(d.metrics, "failed")).toBe(1); expect(total(d.metrics, "retried")).toBe(1); expect(d.metrics.render()).not.toContain("timeout-secret");
  });
  it.each(["mark_webhook_event_retry", "record_delivery_failure"])("handles returned database errors from %s without inventing transitions", async fn => {
    const d = setup(); const original = d.client.rpc.bind(d.client);
    vi.spyOn(d.client, "rpc").mockImplementation(async (name: any, args: any) => name === fn ? { data: null, error: { message: "offline" } } as any : original(name, args));
    await d.run(async () => ({ ok: false }));
    expect(total(d.metrics, "failed")).toBe(1); expect(total(d.metrics, "retried")).toBe(fn === "mark_webhook_event_retry" ? 0 : 1);
  });
  it.each([false, true])("does not count DLQ when its DB write fails (throw=%s)", async throws => {
    const d = setup(event(4)); const original = d.client.rpc.bind(d.client);
    vi.spyOn(d.client, "rpc").mockImplementation(async (name: any, args: any) => {
      if (name === "mark_webhook_event_retry") { if (throws) throw new Error("offline"); return { data: null, error: { message: "offline" } } as any; }
      return original(name, args);
    });
    await d.run(async () => ({ ok: false })); expect(total(d.metrics, "failed")).toBe(1); expect(total(d.metrics, "dead_lettered")).toBe(0);
  });
  it.each(["mark_webhook_event_delivered", "record_delivery_success"])("counts HTTP success despite returned accounting error from %s", async fn => {
    const d = setup(); const original = d.client.rpc.bind(d.client);
    vi.spyOn(d.client, "rpc").mockImplementation(async (name: any, args: any) => name === fn ? { data: null, error: { message: "offline" } } as any : original(name, args));
    await d.run(); expect(total(d.metrics, "delivered")).toBe(1); expect(total(d.metrics, "failed")).toBe(0);
  });
  it("counts a successful HTTP response even if the accounting call throws and releases the row", async () => {
    const d = setup(); const original = d.client.rpc.bind(d.client);
    vi.spyOn(d.client, "rpc").mockImplementation(async (name: any, args: any) => { if (name === "mark_webhook_event_delivered") throw new Error("offline"); return original(name, args); });
    expect((await d.run())[0].outcome).toBe("released"); expect(total(d.metrics, "delivered")).toBe(1); expect(total(d.metrics, "failed")).toBe(0);
  });
  it("does not count breaker skips or token delays as attempts", async () => {
    const d = setup(); d.breakers.set(destination, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() + 60000).toISOString() });
    expect((await d.run())[0].outcome).toBe("skipped");
    d.breakers.clear(); vi.spyOn(d.limiter, "take").mockReturnValue(1000);
    expect((await d.run())[0].outcome).toBe("rate_limited");
    for (const k of ["delivered", "failed", "retried", "dead_lettered"]) expect(total(d.metrics, k)).toBe(0);
  });
  it("unreadable raw bodies release without counting attempts", async () => {
    const d = setup(); vi.spyOn(d.client, "from").mockImplementation(() => { throw new Error("offline"); });
    expect((await d.run())[0].outcome).toBe("released"); expect(total(d.metrics, "failed")).toBe(0);
  });
  it("claim failures do not invent attempts", async () => {
    const d = setup(); vi.spyOn(d.client, "rpc").mockResolvedValue({ data: null, error: { message: "offline" } } as any);
    expect(await d.run()).toEqual([]); expect(total(d.metrics, "failed")).toBe(0);
  });
  it("never exposes event ID, payload or destination secrets", async () => {
    const d = setup(); await d.run();
    for (const secret of ["payload-secret", "token=secret", "receiver.test", '"evt"']) expect(d.metrics.render()).not.toContain(secret);
  });
});
