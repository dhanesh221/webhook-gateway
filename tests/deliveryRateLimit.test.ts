import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach } from "vitest";
import { processPendingBatch, type ClaimedWebhookEvent } from "../src/deliveryWorker";
import { TokenBuckets } from "../src/rateLimit";
import { makeFakeSupabase } from "./fakeSupabase";

const a = "https://receiver.example/a";
const b = "https://receiver.example/b";
function rows(count: number, destination = a): ClaimedWebhookEvent[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${destination}-${i}`, source: "test", attempts: 0, payload: { i }, destination_url: destination }));
}
function setup(count = 3) {
  let now = 0;
  const db = makeFakeSupabase(rows(count));
  const limiter = new TokenBuckets({ rps: 1, burst: 1 }, new Map(), () => now);
  const deliver = vi.fn(async () => ({ ok: true }));
  const original = db.client.rpc.bind(db.client);
  const rpc = vi.spyOn(db.client, "rpc");
  return { ...db, limiter, deliver, rpc, original, at: (n: number) => { now = n; } };
}
afterEach(() => vi.restoreAllMocks());

describe("rate-limited worker", () => {
  it("delivers a burst and defers the rest without spending attempts", async () => {
    const d = setup();
    const outcomes = await processPendingBatch(d.client, d.deliver, d.limiter);
    expect(outcomes.map(o => o.outcome)).toEqual(["delivered", "rate_limited", "rate_limited"]);
    expect(d.deliver).toHaveBeenCalledTimes(1);
    for (const row of d.table.values()) expect(row.attempts).toBe(0);
    const calls = d.rpc.mock.calls.filter(([name]) => name === "mark_webhook_event_skipped");
    expect(calls).toHaveLength(2);
    expect(Date.parse((calls[0][1] as any).p_next_attempt_at)).toBeGreaterThan(Date.now());
  });
  it("keeps token state across batches, then delivers after refill", async () => {
    const d = setup();
    await processPendingBatch(d.client, d.deliver, d.limiter);
    expect((await processPendingBatch(d.client, d.deliver, d.limiter)).every(o => o.outcome === "rate_limited")).toBe(true);
    d.at(1000); await processPendingBatch(d.client, d.deliver, d.limiter);
    expect(d.deliver).toHaveBeenCalledTimes(2);
    d.at(2000); await processPendingBatch(d.client, d.deliver, d.limiter);
    expect([...d.table.values()].every(row => row.status === "delivered")).toBe(true);
  });
  it("does not let a limited destination block other destinations", async () => {
    const db = makeFakeSupabase([...rows(2), ...rows(1, b)]);
    const limiter = new TokenBuckets({ rps: 1, burst: 1 }, new Map(), () => 0);
    const deliver = vi.fn(async () => ({ ok: true }));
    const out = await processPendingBatch(db.client, deliver, limiter);
    expect(out.map(o => o.outcome)).toEqual(["delivered", "rate_limited", "delivered"]);
  });
  it("failed HTTP requests spend tokens but rate deferrals do not increment retries", async () => {
    const d = setup(1); d.deliver.mockResolvedValue({ ok: false });
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("retry");
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("rate_limited");
    expect([...d.table.values()][0].attempts).toBe(1);
    d.at(1000); await processPendingBatch(d.client, d.deliver, d.limiter);
    expect([...d.table.values()][0].attempts).toBe(2);
  });
  it("open breakers do not consume tokens", async () => {
    const d = setup(1);
    d.breakers.set(a, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() + 60000).toISOString() });
    const take = vi.spyOn(d.limiter, "take");
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("skipped");
    expect(take).not.toHaveBeenCalled(); expect(d.deliver).not.toHaveBeenCalled();
    d.breakers.set(a, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() - 1000).toISOString() });
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("delivered");
    expect(take).toHaveBeenCalledTimes(1);
  });
  it("a due breaker probe still waits if its bucket is empty", async () => {
    const d = setup(1); d.limiter.take(a);
    d.breakers.set(a, { state: "open", consecutiveFailures: 5, nextProbeAt: new Date(Date.now() - 1000).toISOString() });
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("rate_limited");
    expect(d.deliver).not.toHaveBeenCalled();
    expect(d.breakers.get(a)?.state).toBe("open");
    d.at(1000);
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("delivered");
    expect(d.breakers.get(a)?.state).toBe("closed");
  });
  it("continues a batch even if both deferral and release writes fail", async () => {
    const d = setup(2); d.limiter.take(a);
    d.rpc.mockImplementation(async (name: any, args: any) => {
      if (name === "mark_webhook_event_skipped") return { data: null, error: { message: "DB unavailable" } } as any;
      return d.original(name, args) as any;
    });
    const out = await processPendingBatch(d.client, d.deliver, d.limiter);
    expect(out).toHaveLength(2); expect(out.every(o => o.outcome === "released")).toBe(true);
    expect([...d.table.values()].every(r => r.status === "in_progress" && r.attempts === 0)).toBe(true);
    expect(d.deliver).not.toHaveBeenCalled();
  });
  it("a failed deferral write falls back to release, not HTTP delivery", async () => {
    const d = setup(1); d.limiter.take(a);
    const original = d.original;
    let failures = 0;
    d.rpc.mockImplementation(async (name: any, args: any) => {
      if (name === "mark_webhook_event_skipped" && failures++ === 0) return { data: null, error: { message: "write failed" } } as any;
      return original(name, args) as any;
    });
    expect((await processPendingBatch(d.client, d.deliver, d.limiter))[0].outcome).toBe("released");
    expect(d.deliver).not.toHaveBeenCalled(); expect([...d.table.values()][0].attempts).toBe(0);
    expect([...d.table.values()][0].status).toBe("pending");
  });
  it("overlapping batches sharing the limiter cannot exceed its burst", async () => {
    const limiter = new TokenBuckets({ rps: 1, burst: 1 }, new Map(), () => 0);
    const one = makeFakeSupabase(rows(1)); const two = makeFakeSupabase(rows(1));
    const deliver = vi.fn(async () => ({ ok: true }));
    const outcomes = (await Promise.all([processPendingBatch(one.client, deliver, limiter), processPendingBatch(two.client, deliver, limiter)])).flat();
    expect(outcomes.filter(o => o.outcome === "delivered")).toHaveLength(1);
    expect(outcomes.filter(o => o.outcome === "rate_limited")).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("an unexpected limiter error releases claimed rows without delivering", async () => {
    const d = setup();
    await expect(processPendingBatch(d.client, d.deliver, { take: () => { throw Error("broken limiter"); } })).resolves.toHaveLength(3);
    expect(d.deliver).not.toHaveBeenCalled();
    expect([...d.table.values()].every(row => row.status === "pending")).toBe(true);
  });
});


describe("HTTP rate boundary", () => {
  it("keeps real outgoing requests within burst and releases waiting rows", async () => {
    let count = 0, now = 0;
    const receiver = http.createServer((_req, res) => { count++; res.writeHead(200); res.end(); });
    await new Promise<void>(resolve => receiver.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/receive`;
      const db = makeFakeSupabase(rows(5, url));
      const limiter = new TokenBuckets({ rps: 2, burst: 2 }, new Map(), () => now);
      await processPendingBatch(db.client, undefined, limiter);
      expect(count).toBe(2);
      expect([...db.table.values()].filter(r => r.status === "pending")).toHaveLength(3);
      now = 500; await processPendingBatch(db.client, undefined, limiter); expect(count).toBe(3);
      now = 1500; await processPendingBatch(db.client, undefined, limiter); expect(count).toBe(5);
      expect([...db.table.values()].every(r => r.status === "delivered" && r.attempts === 0)).toBe(true);
    } finally { await new Promise<void>(resolve => receiver.close(() => resolve())); }
  });
});
