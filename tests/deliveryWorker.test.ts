import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch } from "../src/deliveryWorker";
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
