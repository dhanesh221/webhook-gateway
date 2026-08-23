// Edge cases probed against the worker and DLQ CLI. Each of these was tried
// against the live system first (see the 2026-08-23e session note); the ones
// that are deterministic enough to assert on are pinned down here so a future
// change can't quietly regress them.
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch } from "../src/deliveryWorker";
import { makeFakeSupabase } from "./fakeSupabase";

const mocks = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("../src/supabase", () => ({
  getSupabase: () => mocks.client,
}));

import { replay } from "../src/dlq";

describe("malformed destination_url", () => {
  // A destination_url can be wrong in more ways than "missing". The worker must
  // treat every one of them as an ordinary failed attempt — a bad URL on one
  // event must never take down the poll loop and stall every other event.
  const cases: Array<{ label: string; url: string }> = [
    { label: "not a URL at all", url: "not-a-url" },
    { label: "scheme with no host", url: "http://" },
    { label: "unsupported scheme", url: "ftp://example.com/hook" },
    { label: "syntactically valid but nothing listening", url: "http://127.0.0.1:1/receive" },
  ];

  for (const { label, url } of cases) {
    it(`treats "${label}" as a failed attempt rather than crashing the batch`, async () => {
      const { client, table } = makeFakeSupabase([
        {
          id: "bad-url",
          source: "test",
          attempts: 0,
          payload: { hello: "world" },
          destination_url: url,
        },
      ]);

      const outcomes = await processPendingBatch(client);

      expect(outcomes).toEqual([{ id: "bad-url", outcome: "retry", attempt: 1 }]);
      expect(table.get("bad-url")!.status).toBe("pending");
      expect(table.get("bad-url")!.attempts).toBe(1);
    });
  }

  it("keeps processing the rest of the batch after one event's URL blows up", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const { client, table } = makeFakeSupabase([
        {
          id: "poisoned",
          source: "test",
          attempts: 0,
          payload: {},
          destination_url: "not-a-url",
        },
        {
          id: "healthy",
          source: "test",
          attempts: 0,
          payload: {},
          destination_url: `http://127.0.0.1:${port}/receive`,
        },
      ]);

      const outcomes = await processPendingBatch(client);

      expect(outcomes).toHaveLength(2);
      expect(table.get("healthy")!.status).toBe("delivered");
      expect(table.get("poisoned")!.status).toBe("pending");
    } finally {
      server.close();
    }
  });

  it("treats an empty-string destination_url as no destination, without an HTTP attempt", async () => {
    const { client, table } = makeFakeSupabase([
      {
        id: "empty-url",
        source: "test",
        attempts: 0,
        payload: {},
        destination_url: "",
      },
    ]);

    const outcomes = await processPendingBatch(client);

    expect(outcomes).toEqual([{ id: "empty-url", outcome: "retry", attempt: 1 }]);
    expect(table.get("empty-url")!.attempts).toBe(1);
  });
});

describe("circuit breaker state within a single batch", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("re-reads breaker state per event, so the event after the threshold is skipped mid-batch", async () => {
    // The risk being tested: if the worker read the breaker state once per poll
    // instead of once per event, then a batch containing more events than the
    // failure threshold would keep hammering a destination that went open
    // partway through the batch. Six events, threshold five, one batch.
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://127.0.0.1:${port}/receive`;

    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `batch-${i}`,
      source: "test",
      attempts: 0,
      payload: { i },
      destination_url: destinationUrl,
    }));

    const { client, table, breakers } = makeFakeSupabase(rows, { cooldownMs: 60_000 });

    const outcomes = await processPendingBatch(client);

    expect(outcomes.map((o) => o.outcome)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retry",
      "skipped", // the breaker opened after the 5th failure, inside this batch
    ]);
    // Exactly five requests reached the destination — the sixth was cut off.
    expect(requestCount).toBe(5);
    expect(breakers.get(destinationUrl)?.state).toBe("open");
    expect(table.get("batch-5")!.attempts).toBe(0); // skipped, not attempted
  });
});

describe("DLQ replay of ids that aren't dead-lettered", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("fails cleanly for an id that doesn't exist at all", async () => {
    const { client } = makeFakeSupabase([]);
    mocks.client = client;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await replay("00000000-0000-0000-0000-000000000000");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not dead-lettered"));
    expect(process.exitCode).toBe(1);
  });

  it("fails cleanly — and does not touch the row — for an id that exists but is still pending", async () => {
    const { client, table } = makeFakeSupabase([
      {
        id: "still-pending",
        source: "test",
        attempts: 2,
        payload: {},
        destination_url: "http://127.0.0.1:9/receive",
      },
    ]);
    mocks.client = client;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await replay("still-pending");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not dead-lettered"));
    expect(process.exitCode).toBe(1);
    // Crucially, a mistaken replay must not silently reset a live event's
    // retry budget back to zero.
    expect(table.get("still-pending")!.status).toBe("pending");
    expect(table.get("still-pending")!.attempts).toBe(2);
  });
});

describe("replaying into an open circuit breaker", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("respects the open breaker instead of forcing a delivery attempt", async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://127.0.0.1:${port}/receive`;

    const { client, table } = makeFakeSupabase(
      [
        {
          id: "doomed",
          source: "test",
          attempts: 0,
          payload: {},
          destination_url: destinationUrl,
        },
      ],
      { cooldownMs: 60_000 }
    );
    mocks.client = client;

    // Five failures dead-letter the event and open the breaker together.
    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }
    expect(table.get("doomed")!.status).toBe("dead_lettered");
    expect(requestCount).toBe(5);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await replay("doomed");
    logSpy.mockRestore();
    expect(table.get("doomed")!.status).toBe("pending");

    // Replaying while the destination is still known-down must not bypass the
    // breaker — otherwise a bulk replay would immediately re-flood a dead host.
    const outcomes = await processPendingBatch(client);

    expect(outcomes).toEqual([{ id: "doomed", outcome: "skipped", attempt: 0 }]);
    expect(requestCount).toBe(5); // no new request
    expect(table.get("doomed")!.attempts).toBe(0); // replay's reset still intact
  });
});
