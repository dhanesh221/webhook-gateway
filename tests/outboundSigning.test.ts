import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch, outboundHeaders, EVENT_ID_HEADER, EVENT_SOURCE_HEADER, EVENT_ATTEMPT_HEADER } from "../src/deliveryWorker";
import { verifySignature, SIGNATURE_HEADER } from "../src/signature";
import { makeFakeSupabase } from "./fakeSupabase";

const SECRET = "outbound-signing-secret-at-least-32-bytes-long";
type Received = { headers: http.IncomingHttpHeaders; body: string };

describe("outbound delivery headers", () => {
  let server: http.Server | undefined;
  let received: Received[];
  let url: string;
  let statusToSend: number;

  beforeEach(async () => {
    received = [];
    statusToSend = 200;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(statusToSend);
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/receive`;
    vi.stubEnv("WG_SOURCE_PAY_SECRET", SECRET);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { server?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("signs with the source secret over the exact bytes sent, keyed by the event id", async () => {
    const raw = '{"amount": 12345678901234567890, "k":"v"}';
    const fake = makeFakeSupabase([]);
    await fake.client.rpc("upsert_webhook_source", { p_name: "pay", p_destination_url: url, p_secret_env: "WG_SOURCE_PAY_SECRET" });
    fake.table.set("evt-1", { id: "evt-1", source: "pay", attempts: 0, payload: JSON.parse(raw), destination_url: url, status: "pending", raw_body: raw });

    const outcomes = await processPendingBatch(fake.client);
    expect(outcomes).toEqual([{ id: "evt-1", outcome: "delivered", attempt: 1 }]);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(body).toBe(raw);                                     // raw bytes, not re-serialised
    expect(headers[EVENT_ID_HEADER.toLowerCase()]).toBe("evt-1");
    expect(headers[EVENT_SOURCE_HEADER.toLowerCase()]).toBe("pay");
    expect(headers[EVENT_ATTEMPT_HEADER.toLowerCase()]).toBe("1");
    expect(headers["idempotency-key"]).toBe("evt-1");
    expect(headers["content-type"]).toBe("application/json");
    // The receiver verifies exactly as a gateway-protocol receiver would.
    const sig = headers[SIGNATURE_HEADER] as string;
    expect(sig).toMatch(/^t=\d+,v2=[0-9a-f]{64}$/);
    expect(verifySignature({ secret: SECRET, header: sig, rawBody: body, idempotencyKey: "evt-1" })).toEqual({ ok: true });
    // Bound to the event id: the same signature does not verify under another key.
    expect(verifySignature({ secret: SECRET, header: sig, rawBody: body, idempotencyKey: "evt-2" }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, header: sig, rawBody: body + " ", idempotencyKey: "evt-1" }).ok).toBe(false);
  });

  it("keeps the event id stable across a retry and increments only the attempt header", async () => {
    const fake = makeFakeSupabase([]);
    await fake.client.rpc("upsert_webhook_source", { p_name: "pay", p_destination_url: url, p_secret_env: "WG_SOURCE_PAY_SECRET" });
    fake.table.set("evt-2", { id: "evt-2", source: "pay", attempts: 0, payload: { a: 1 }, destination_url: url, status: "pending" });

    statusToSend = 500;
    await processPendingBatch(fake.client);
    statusToSend = 200;
    await processPendingBatch(fake.client);

    expect(received.map((r) => r.headers[EVENT_ID_HEADER.toLowerCase()])).toEqual(["evt-2", "evt-2"]);
    expect(received.map((r) => r.headers[EVENT_ATTEMPT_HEADER.toLowerCase()])).toEqual(["1", "2"]);
    expect(fake.table.get("evt-2")!.status).toBe("delivered");
    // Both signed, each over the body JSON.stringify produced for a row with no raw body.
    for (const r of received) {
      expect(verifySignature({ secret: SECRET, header: r.headers[SIGNATURE_HEADER] as string, rawBody: r.body, idempotencyKey: "evt-2" })).toEqual({ ok: true });
    }
  });

  it("delivers unsigned, with identity headers and a warning, when the source or its secret is unavailable", async () => {
    const fake = makeFakeSupabase([]);
    // "orphan" was never registered; "pay" is registered but this process lacks the env var.
    await fake.client.rpc("upsert_webhook_source", { p_name: "pay", p_destination_url: url, p_secret_env: "WG_SOURCE_PAY_SECRET" });
    vi.stubEnv("WG_SOURCE_PAY_SECRET", "");
    fake.table.set("o-1", { id: "o-1", source: "orphan", attempts: 0, payload: {}, destination_url: url, status: "pending" });
    fake.table.set("p-1", { id: "p-1", source: "pay", attempts: 0, payload: {}, destination_url: url, status: "pending" });
    fake.table.set("p-2", { id: "p-2", source: "pay", attempts: 0, payload: {}, destination_url: url, status: "pending" });

    const outcomes = await processPendingBatch(fake.client);
    expect(outcomes.map((o) => o.outcome)).toEqual(["delivered", "delivered", "delivered"]);
    for (const r of received) {
      expect(r.headers[SIGNATURE_HEADER]).toBeUndefined();
      expect(r.headers[EVENT_ID_HEADER.toLowerCase()]).toBeTruthy();
    }
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("delivering orphan unsigned"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("delivering pay unsigned"))).toHaveLength(1); // once per batch, not per row
  });

  it("outboundHeaders is deterministic for a fixed clock", () => {
    const a = outboundHeaders({ id: "e", source: "s" }, 3, "{}", SECRET, 1_700_000_000);
    const b = outboundHeaders({ id: "e", source: "s" }, 3, "{}", SECRET, 1_700_000_000);
    expect(a).toEqual(b);
    expect(a[SIGNATURE_HEADER]).toMatch(/^t=1700000000,v2=/);
    expect(outboundHeaders({ id: "e", source: "s" }, 1, "{}", null)[SIGNATURE_HEADER]).toBeUndefined();
  });
});
