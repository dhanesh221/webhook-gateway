import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch } from "../src/deliveryWorker";
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
      await processPendingBatch(client);
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

    const outcomes = await processPendingBatch(client);

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
      await processPendingBatch(client);
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
    let outcomes = await processPendingBatch(client);
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

    outcomes = await processPendingBatch(client);
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
    outcomes = await processPendingBatch(client);
    expect(outcomes.find((o) => o.id === "resumed-event")?.outcome).toBe("delivered");
  });
});
