import { TokenBuckets } from "../src/rateLimit";
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch, PROBE_LEASE_SECONDS, type DeliverFn } from "../src/deliveryWorker";
import { makeFakeSupabase } from "./fakeSupabase";

describe("circuit breaker", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    vi.useRealTimers();
  });

  it("trips open after the failure threshold, then skips further events without attempting delivery", async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://127.0.0.1:${port}/receive`;

    // Five distinct one-shot events at the same destination, each attempted
    // once — this trips the breaker via record_delivery_failure without any
    // single event reaching its own per-event MAX_ATTEMPTS dead-letter cap.
    const failingRows = Array.from({ length: 5 }, (_, i) => ({
      id: `fail-${i}`,
      source: "test",
      attempts: 0,
      payload: { i },
      destination_url: destinationUrl,
    }));

    const { client, table, breakers } = makeFakeSupabase(failingRows, { cooldownMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));
    }

    expect(breakers.get(destinationUrl)?.state).toBe("open");
    for (let i = 0; i < 5; i++) {
      expect(table.get(`fail-${i}`)!.status).toBe("pending"); // retried, not dead-lettered
    }
    expect(requestCount).toBe(5);

    // Add a sixth event only now, so it's claimed while the breaker is open.
    table.set("sixth", {
      id: "sixth",
      source: "test",
      attempts: 0,
      payload: { hello: "world" },
      destination_url: destinationUrl,
      status: "pending",
    });

    const outcomes = await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));

    const sixthOutcome = outcomes.find((o) => o.id === "sixth");
    expect(sixthOutcome?.outcome).toBe("skipped");
    expect(table.get("sixth")!.attempts).toBe(0); // not counted as an attempt
    expect(table.get("sixth")!.status).toBe("pending");
    expect(requestCount).toBe(5); // never actually attempted delivery
  });

  it("recovers via a probe attempt once the cooldown elapses, then resumes normal delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    let shouldFail = true;
    server = http.createServer((_req, res) => {
      if (shouldFail) {
        res.writeHead(500);
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://127.0.0.1:${port}/receive`;

    const COOLDOWN_MS = 5_000;
    const failingRows = Array.from({ length: 5 }, (_, i) => ({
      id: `fail-${i}`,
      source: "test",
      attempts: 0,
      payload: { i },
      destination_url: destinationUrl,
    }));

    const { client, table, breakers } = makeFakeSupabase(failingRows, {
      cooldownMs: COOLDOWN_MS,
    });

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));
    }
    expect(breakers.get(destinationUrl)?.state).toBe("open");

    // Still within cooldown: a fresh event gets skipped, not probed.
    table.set("still-cooling", {
      id: "still-cooling",
      source: "test",
      attempts: 0,
      payload: {},
      destination_url: destinationUrl,
      status: "pending",
    });
    let outcomes = await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));
    expect(outcomes.find((o) => o.id === "still-cooling")?.outcome).toBe("skipped");

    // Advance the fake clock past the cooldown, and make the destination succeed.
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1000));
    shouldFail = false;
    table.set("probe-event", {
      id: "probe-event",
      source: "test",
      attempts: 0,
      payload: {},
      destination_url: destinationUrl,
      status: "pending",
    });

    outcomes = await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));
    const probeOutcome = outcomes.find((o) => o.id === "probe-event");
    expect(probeOutcome?.outcome).toBe("delivered");
    expect(breakers.get(destinationUrl)?.state).toBe("closed");
    expect(table.get("probe-event")!.status).toBe("delivered");

    // Breaker closed: normal delivery resumes for a subsequent event.
    table.set("resumed-event", {
      id: "resumed-event",
      source: "test",
      attempts: 0,
      payload: {},
      destination_url: destinationUrl,
      status: "pending",
    });
    outcomes = await processPendingBatch(client, undefined, new TokenBuckets({ rps: 10000, burst: 10000 }));
    expect(outcomes.find((o) => o.id === "resumed-event")?.outcome).toBe("delivered");
  });

  // Trips a breaker for `url` using an injected deliver, without a real server.
  async function tripBreaker(client: ReturnType<typeof makeFakeSupabase>["client"], url: string) {
    const failing: DeliverFn = async () => ({ ok: false, status: 500 });
    for (let i = 0; i < 5; i++) await processPendingBatch(client, failing);
  }

  const row = (id: string, destination_url: string) =>
    ({ id, source: "test", attempts: 0, payload: {}, destination_url, status: "pending" });

  it("lets exactly one of several concurrent workers probe a due breaker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = "https://recovering.invalid/hook";
    const COOLDOWN_MS = 5_000;
    const { client, table, breakers } = makeFakeSupabase(
      Array.from({ length: 5 }, (_, i) => ({ id: `fail-${i}`, source: "test", attempts: 0, payload: {}, destination_url: url })),
      { cooldownMs: COOLDOWN_MS, claimLimit: 1 }
    );
    // claimLimit 1 means each poll claims one row; drain the five failing rows.
    const failing: DeliverFn = async () => ({ ok: false, status: 500 });
    for (let i = 0; i < 5; i++) await processPendingBatch(client, failing);
    expect(breakers.get(url)?.state).toBe("open");
    for (const r of table.values()) r.status = "delivered"; // out of the way

    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1000));
    table.set("a", row("a", url));
    table.set("b", row("b", url));

    // Both "workers" poll at the same instant. The probe hangs until released so
    // the second worker decides while the first probe is still in flight.
    let release!: (r: { ok: boolean; status: number }) => void;
    const gate = new Promise<{ ok: boolean; status: number }>((res) => (release = res));
    const calls: string[] = [];
    const slowDeliver: DeliverFn = async (u) => { calls.push(u); return gate; };

    const batches = Promise.all([processPendingBatch(client, slowDeliver), processPendingBatch(client, slowDeliver)]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // Lease taken: the breaker's probe time moved out by the lease length.
    const leaseEnd = Date.parse(breakers.get(url)!.nextProbeAt!);
    expect(leaseEnd).toBeGreaterThan(Date.now());
    expect(leaseEnd).toBeLessThanOrEqual(Date.now() + PROBE_LEASE_SECONDS * 1000);

    release({ ok: true, status: 200 });
    const [first, second] = await batches;
    const all = [...first, ...second];
    expect(calls).toHaveLength(1);                       // one probe, not two
    expect(all.map((o) => o.outcome).sort()).toEqual(["delivered", "skipped"]);
    const skipped = all.find((o) => o.outcome === "skipped")!;
    expect(table.get(skipped.id)!.status).toBe("pending");
    expect(table.get(skipped.id)!.attempts).toBe(0);     // waiting costs nothing
    expect(breakers.get(url)?.state).toBe("closed");     // the one probe closed it
  });

  it("still probes, unleased, when the lease RPC is missing (pre-010 database)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = "https://legacy.invalid/hook";
    const COOLDOWN_MS = 5_000;
    const fake = makeFakeSupabase(
      Array.from({ length: 5 }, (_, i) => ({ id: `fail-${i}`, source: "test", attempts: 0, payload: {}, destination_url: url })),
      { cooldownMs: COOLDOWN_MS }
    );
    const realRpc = (fake.client as unknown as { rpc: (fn: string, args?: unknown) => Promise<unknown> }).rpc;
    (fake.client as unknown as { rpc: unknown }).rpc = async (fn: string, args?: unknown) =>
      fn === "claim_circuit_probe"
        ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
        : realRpc(fn, args);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await tripBreaker(fake.client, url);
    expect(fake.breakers.get(url)?.state).toBe("open");
    for (const r of fake.table.values()) r.status = "delivered"; // out of the way
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1000));
    fake.table.set("probe", row("probe", url));

    const calls: string[] = [];
    const ok: DeliverFn = async (u) => { calls.push(u); return { ok: true, status: 200 }; };
    const outcomes = await processPendingBatch(fake.client, ok);

    expect(outcomes.find((o) => o.id === "probe")?.outcome).toBe("delivered");
    expect(calls).toEqual([url]);
    expect(fake.breakers.get(url)?.state).toBe("closed");
    expect(errors.mock.calls.some(([m]) => String(m).includes("Apply migrations/010"))).toBe(true);
    errors.mockRestore();
  });
});
