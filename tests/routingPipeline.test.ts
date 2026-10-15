// Fan-out through the real app and worker, backed by the shared fake Supabase.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import request, { TEST_SOURCE_SECRET } from "./signedRequest";
import plainRequest from "supertest";
import { processPendingBatch } from "../src/deliveryWorker";
import { TokenBuckets } from "../src/rateLimit";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";
import { makeFakeSupabase } from "./fakeSupabase";

const mocks = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => mocks.client }));
import { app } from "../src/app";
import { gatewayMetrics } from "../src/metrics";

const A = "https://a.example/hook";
const B = "https://b.example/hook";
const C = "https://c.example/hook";
const LEGACY = "https://legacy.example/hook";

function setup(rules: unknown[] | undefined) {
  if (rules === undefined) vi.stubEnv("WG_ROUTING_RULES", "");
  else vi.stubEnv("WG_ROUTING_RULES", JSON.stringify({ rules }));
  vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
  const db = makeFakeSupabase([]);
  db.sources.set("stripe", { name: "stripe", destination_url: LEGACY, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true });
  mocks.client = db.client;
  const calls: string[] = [];
  const failing = new Set<string>();
  const deliver = vi.fn(async (url: string) => { calls.push(url); return { ok: !failing.has(url) }; });
  return { ...db, calls, failing, deliver };
}
const fan = [{ source: "stripe", match: { type: "invoice.paid" }, destinations: [A, B] }];
const send = (body: object, key?: string) => {
  const r = request(app).post("/webhooks/stripe");
  if (key) r.set("Idempotency-Key", key);
  return r.send(body);
};
const rowsByDest = (t: Map<string, any>) => Object.fromEntries([...t.values()].map((r) => [r.destination_url, r]));

beforeEach(() => vi.useRealTimers());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("routed fan-out", () => {
  it("stores one row per destination, linked by a group id, and returns delivery_ids", async () => {
    const s = setup(fan);
    const res = await send({ type: "invoice.paid" }, "k1");
    expect(res.status).toBe(202);
    expect(s.table.size).toBe(2);
    const rows = [...s.table.values()];
    expect(new Set(rows.map((r) => r.fanout_group_id)).size).toBe(1);
    expect(res.body.id).toBe(rows[0].id);
    expect(res.body.delivery_ids).toEqual(rows.map((r) => r.id));
    expect(rows[0].idempotency_key).toBe("k1");
    expect(rows[1].idempotency_key).toBeNull();
  });

  it("delivers to every destination, each once", async () => {
    const s = setup(fan);
    await send({ type: "invoice.paid" }, "k1");
    await processPendingBatch(s.client, s.deliver);
    expect(s.calls.sort()).toEqual([A, B]);
    expect([...s.table.values()].every((r) => r.status === "delivered")).toBe(true);
  });

  it("a single matching destination returns no delivery_ids", async () => {
    const s = setup([{ source: "stripe", match: { type: "x" }, destinations: [A] }]);
    const res = await send({ type: "x" });
    expect(res.status).toBe(202);
    expect(res.body.delivery_ids).toBeUndefined();
    expect(s.table.size).toBe(1);
  });

  it("keeps successful and failed siblings independent", async () => {
    const s = setup(fan);
    s.failing.add(B);
    await send({ type: "invoice.paid" }, "k1");
    const out = await processPendingBatch(s.client, s.deliver);
    expect(out.map((o) => o.outcome).sort()).toEqual(["delivered", "retry"]);
    const r = rowsByDest(s.table);
    expect(r[A].status).toBe("delivered");
    expect(r[B].status).toBe("pending");
    expect(r[B].attempts).toBe(1);
  });

  it("an open breaker on one destination does not hold back the other", async () => {
    const s = setup(fan);
    s.breakers.set(B, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() + 60_000).toISOString() });
    await send({ type: "invoice.paid" }, "k1");
    await processPendingBatch(s.client, s.deliver);
    const r = rowsByDest(s.table);
    expect(r[A].status).toBe("delivered");
    expect(r[B].status).toBe("pending");
    expect(s.calls).toEqual([A]);
  });

  it("an exhausted rate bucket on one destination does not block the other", async () => {
    const s = setup(fan);
    const limiter = new TokenBuckets({ rps: 1, burst: 1 }, new Map(), () => 0);
    limiter.take(B);
    await send({ type: "invoice.paid" }, "k1");
    const out = await processPendingBatch(s.client, s.deliver, limiter);
    expect(out.map((o) => o.outcome).sort()).toEqual(["delivered", "rate_limited"]);
    expect(rowsByDest(s.table)[A].status).toBe("delivered");
  });

  it("dead-letters and replays one copy without touching its sibling", async () => {
    const s = setup(fan);
    s.failing.add(B);
    await send({ type: "invoice.paid" }, "k1");
    for (let i = 0; i < 5; i++) await processPendingBatch(s.client, s.deliver);
    let r = rowsByDest(s.table);
    expect(r[B].status).toBe("dead_lettered");
    expect(r[A].status).toBe("delivered");
    const deliveredCalls = s.calls.filter((u) => u === A).length;
    await s.client.rpc("replay_webhook_event", { p_id: r[B].id });
    s.failing.clear();
    s.breakers.clear();
    await processPendingBatch(s.client, s.deliver);
    r = rowsByDest(s.table);
    expect(r[B].status).toBe("delivered");
    expect(s.calls.filter((u) => u === A).length).toBe(deliveredCalls);
  });

  it("dedupes repeated URLs inside and across matching rules", async () => {
    const s = setup([
      { source: "stripe", match: { type: "t" }, destinations: [A, A, "https://A.example/hook"] },
      { source: "stripe", match: { type: "t" }, destinations: [A, B] },
    ]);
    await send({ type: "t" });
    expect(s.table.size).toBe(2);
  });

  it("falls back to the registry destination when no rule matches", async () => {
    const s = setup(fan);
    const res = await send({ type: "other" });
    expect(res.status).toBe(202);
    const row = [...s.table.values()][0];
    expect(row.destination_url).toBe(LEGACY);
    expect(row.fanout_group_id).toBeUndefined();
    expect(res.body.delivery_ids).toBeUndefined();
  });

  it("uses the legacy path entirely when no routing config is set", async () => {
    const s = setup(undefined);
    const spy = vi.spyOn(s.client, "rpc");
    await send({ type: "invoice.paid" });
    expect(spy.mock.calls.some(([n]) => n === "ingest_routed_webhook")).toBe(false);
    expect([...s.table.values()][0].destination_url).toBe(LEGACY);
  });

  it("dedupes a redelivered key and stores no extra copies", async () => {
    const s = setup(fan);
    expect((await send({ type: "invoice.paid" }, "dup")).status).toBe(202);
    const again = await send({ type: "invoice.paid" }, "dup");
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    expect(s.table.size).toBe(2);
  });

  it("dedupes a routed event against an earlier legacy row with the same key", async () => {
    const s = setup(undefined);
    await send({ type: "invoice.paid" }, "shared");
    vi.stubEnv("WG_ROUTING_RULES", JSON.stringify({ rules: fan }));
    const res = await send({ type: "invoice.paid" }, "shared");
    expect(res.body.status).toBe("duplicate");
    expect(s.table.size).toBe(1);
  });

  it("dedupes a legacy redelivery against an earlier routed event", async () => {
    const s = setup(fan);
    await send({ type: "invoice.paid" }, "shared");
    vi.stubEnv("WG_ROUTING_RULES", "");
    const res = await send({ type: "invoice.paid" }, "shared");
    expect(res.body.status).toBe("duplicate");
    expect(s.table.size).toBe(2);
  });

  it("50 concurrent duplicate requests create exactly one group", async () => {
    const s = setup(fan);
    const results = await Promise.all(Array.from({ length: 50 }, () => send({ type: "invoice.paid" }, "burst")));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.body.status === "duplicate")).toHaveLength(49);
    expect(s.table.size).toBe(2);
  });

  it("counts received once per source event, not per copy", async () => {
    const s = setup([{ source: "stripe", match: { type: "m" }, destinations: [A, B, C] }]);
    const spy = vi.spyOn(gatewayMetrics, "increment");
    await send({ type: "m" }, "met");
    expect(s.table.size).toBe(3);
    expect(spy.mock.calls.filter(([k]) => k === "received")).toHaveLength(1);
  });

  it("fails closed when the routed RPC is missing: nothing stored", async () => {
    const s = setup(fan);
    const real = s.client.rpc.bind(s.client);
    vi.spyOn(s.client, "rpc").mockImplementation(((fn: string, args: any) =>
      fn === "ingest_routed_webhook"
        ? Promise.resolve({ data: null, error: { code: "PGRST202", message: "function not found" } })
        : real(fn, args)) as any);
    const res = await send({ type: "invoice.paid" }, "k");
    expect(res.status).toBe(500);
    expect(s.table.size).toBe(0);
  });

  it("fails closed on a malformed routing config", async () => {
    const s = setup(undefined);
    vi.stubEnv("WG_ROUTING_RULES", "{broken");
    const res = await send({ type: "invoice.paid" });
    expect(res.status).toBe(503);
    expect(s.table.size).toBe(0);
  });

  it("rejects unsigned requests before routing", async () => {
    const s = setup(fan);
    const res = await plainRequest(app).post("/webhooks/stripe").send({ type: "invoice.paid" });
    expect(res.status).toBe(401);
    expect(s.table.size).toBe(0);
  });

  it("ignores headers when routing", async () => {
    const s = setup(fan);
    const body = JSON.stringify({ type: "other" });
    const res = await plainRequest(app).post("/webhooks/stripe")
      .set("Content-Type", "application/json").set("X-Event-Type", "invoice.paid").set("type", "invoice.paid")
      .set(SIGNATURE_HEADER, buildSignatureHeader(TEST_SOURCE_SECRET, Math.floor(Date.now() / 1000), body, undefined))
      .send(body);
    expect(res.status).toBe(202);
    expect([...s.table.values()][0].destination_url).toBe(LEGACY);
  });

  it("does not store authentication headers on routed copies", async () => {
    const s = setup(fan);
    await send({ type: "invoice.paid" });
    // the fake keeps no headers; assert the RPC argument instead
    const spy = vi.spyOn(s.client, "rpc");
    await send({ type: "invoice.paid" });
    const args = spy.mock.calls.find(([n]) => n === "ingest_routed_webhook")![1] as any;
    expect(Object.keys(args.p_headers)).not.toContain(SIGNATURE_HEADER);
  });
});
