import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processPendingBatch, type ClaimedWebhookEvent } from "../src/deliveryWorker";
import { makeFakeSupabase } from "./fakeSupabase";

describe("processPendingBatch", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("delivers an event that fails twice then succeeds, with attempts incremented correctly", async () => {
    let requestCount = 0;
    server = http.createServer((req, res) => {
      requestCount += 1;
      if (requestCount <= 2) {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const { client, table } = makeFakeSupabase([
      {
        id: "evt-1",
        source: "test",
        attempts: 0,
        payload: { hello: "world" },
        destination_url: `http://127.0.0.1:${port}/receive`,
      },
    ]);

    // Simulates successive poll cycles without any real timers.
    for (let i = 0; i < 5 && table.get("evt-1")!.status !== "delivered"; i++) {
      await processPendingBatch(client);
    }

    const row = table.get("evt-1")!;
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(2); // two failures recorded before the third, successful, attempt
    expect(requestCount).toBe(3);
  });

  it("dead-letters a permanently-failing destination after 5 attempts", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const { client, table } = makeFakeSupabase([
      {
        id: "evt-2",
        source: "test",
        attempts: 0,
        payload: { hello: "world" },
        destination_url: `http://127.0.0.1:${port}/receive`,
      },
    ]);

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }

    const row = table.get("evt-2")!;
    expect(row.status).toBe("dead_lettered");
    expect(row.attempts).toBe(5);

    // A 6th poll cycle should not touch it again — it's no longer pending.
    await processPendingBatch(client);
    expect(row.attempts).toBe(5);
  });

  it("treats a missing destination_url as a failure instead of crashing", async () => {
    const { client, table } = makeFakeSupabase([
      {
        id: "evt-3",
        source: "test",
        attempts: 0,
        payload: { hello: "world" },
        destination_url: null,
      },
    ]);

    await processPendingBatch(client);

    const row = table.get("evt-3")!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });
});

// When the HTTP/delivery decision succeeds but the database write that records
// it fails, the row stays in_progress and stale-claim recovery returns it to
// pending. The batch outcome has to say that, not claim the recorded end state.
describe("unrecorded accounting writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unrecordedEvent = (attempts = 0): ClaimedWebhookEvent => ({
    id: "evt-u",
    source: "test",
    attempts,
    payload: { a: 1 },
    destination_url: "https://receiver.test/hook",
  });

  const failRpc = (client: SupabaseClient, fn: string) => {
    const original = client.rpc.bind(client);
    vi.spyOn(client, "rpc").mockImplementation(async (name: string, args?: Record<string, unknown>) =>
      name === fn ? ({ data: null, error: { message: "offline" } } as never) : original(name, args)
    );
  };

  it("reports delivered_unrecorded when the delivered-mark write fails after HTTP success", async () => {
    const { client, table } = makeFakeSupabase([unrecordedEvent()]);
    failRpc(client, "mark_webhook_event_delivered");
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcomes = await processPendingBatch(client, async () => ({ ok: true }));

    expect(outcomes).toEqual([{ id: "evt-u", outcome: "delivered_unrecorded", attempt: 1 }]);
    // The destination has the event; the row never left in_progress, so
    // stale-claim recovery will deliver it a second time.
    expect(table.get("evt-u")!.status).toBe("in_progress");
    expect(errLog).toHaveBeenCalledWith(
      expect.stringContaining("stale-claim recovery will re-deliver this event")
    );
  });

  it("reports skip_unrecorded when a breaker skip cannot be recorded", async () => {
    const { client, table, breakers } = makeFakeSupabase([unrecordedEvent()]);
    breakers.set("https://receiver.test/hook", {
      state: "open",
      consecutiveFailures: 5,
      nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
    });
    failRpc(client, "mark_webhook_event_skipped");
    const deliver = vi.fn(async () => ({ ok: true }));

    const outcomes = await processPendingBatch(client, deliver);

    expect(deliver).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ id: "evt-u", outcome: "skip_unrecorded", attempt: 0 }]);
    expect(table.get("evt-u")!.status).toBe("in_progress");
  });

  it("reports retry_unrecorded when the retry mark fails", async () => {
    const { client, table } = makeFakeSupabase([unrecordedEvent()]);
    failRpc(client, "mark_webhook_event_retry");

    const outcomes = await processPendingBatch(client, async () => ({ ok: false }));

    expect(outcomes).toEqual([{ id: "evt-u", outcome: "retry_unrecorded", attempt: 1 }]);
    expect(table.get("evt-u")!.status).toBe("in_progress");
    expect(table.get("evt-u")!.attempts).toBe(0);
  });

  it("reports dead_letter_unrecorded when the final-attempt mark fails", async () => {
    const { client, table } = makeFakeSupabase([unrecordedEvent(4)]);
    failRpc(client, "mark_webhook_event_retry");

    const outcomes = await processPendingBatch(client, async () => ({ ok: false }));

    expect(outcomes).toEqual([{ id: "evt-u", outcome: "dead_letter_unrecorded", attempt: 5 }]);
    expect(table.get("evt-u")!.status).toBe("in_progress");
  });
});
