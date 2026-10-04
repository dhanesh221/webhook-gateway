import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { makeFakeSupabase } from "./fakeSupabase";
import { buildSignatureHeader, SIGNATURE_HEADER, signPayload, verifySignature } from "../src/signature";
import { saveSource } from "../src/sources";
import { processPendingBatch, STALE_CLAIM_SECONDS } from "../src/deliveryWorker";
import { resetLoginThrottle, MAX_FAILURES_PER_CLIENT } from "../src/loginThrottle";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";

const SECRET = "a".repeat(48);
let fake: ReturnType<typeof makeFakeSupabase>;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  fake = makeFakeSupabase([]);
  holder.client = fake.client;
  resetLoginThrottle();
  vi.stubEnv("WG_SOURCE_ALPHA_SECRET", SECRET);
  vi.stubEnv("SESSION_SECRET", "test-session-secret-only");
  vi.stubEnv("ADMIN_PASSWORD_HASH", bcrypt.hashSync("right-password-long-enough", 4));
  await saveSource("alpha", "https://alpha.example/hook", "WG_SOURCE_ALPHA_SECRET");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function send(body: string, header: string, key?: string, type = "application/json") {
  const r = request(app).post("/webhooks/alpha").set("Content-Type", type).set(SIGNATURE_HEADER, header);
  if (key) r.set("Idempotency-Key", key);
  return r.send(body);
}

describe("signed Idempotency-Key", () => {
  const BODY = '{"a":1}';
  it("rejects a captured request replayed with a swapped key", async () => {
    const header = buildSignatureHeader(SECRET, now(), BODY, "k1");
    expect((await send(BODY, header, "k1")).status).toBe(202);
    expect((await send(BODY, header, "attacker-k2")).status).toBe(401);
    expect(fake.table.size).toBe(1);
  });
  it("rejects a v1 signature when a key is sent, and a key added to a keyless signature", async () => {
    const t = now();
    expect((await send(BODY, buildSignatureHeader(SECRET, t, BODY), "k1")).status).toBe(401);
    expect(fake.table.size).toBe(0);
  });
  it("still accepts v1 with no key, and v2 with a key stripped is rejected", async () => {
    expect((await send(BODY, buildSignatureHeader(SECRET, now(), BODY))).status).toBe(202);
    const withKey = buildSignatureHeader(SECRET, now(), '{"b":2}', "k9");
    expect((await send('{"b":2}', withKey)).status).toBe(401);
  });
  it("does not let a v2 MAC be passed off as v1 or vice versa", () => {
    const t = now();
    const v1 = signPayload(SECRET, t, BODY);
    expect(verifySignature({ secret: SECRET, header: `t=${t},v2=${v1}`, rawBody: BODY, idempotencyKey: "k" }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, header: `t=${t},v1=${v1}`, rawBody: BODY, idempotencyKey: "k" }).ok).toBe(false);
  });
});

describe("content type", () => {
  it("answers 415 for non-JSON instead of a misleading 401", async () => {
    const body = "hello";
    const res = await send(body, buildSignatureHeader(SECRET, now(), body), undefined, "text/plain");
    expect(res.status).toBe(415);
    expect(fake.table.size).toBe(0);
  });
});

describe("raw body delivery", () => {
  let server: http.Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });
  it("delivers exact bytes: 64-bit ids, number formatting and whitespace survive", async () => {
    const received: string[] = [];
    server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(b); res.writeHead(200); res.end(); });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("WG_SOURCE_LOCAL_SECRET", SECRET);
    await saveSource("local", `http://127.0.0.1:${port}/in`, "WG_SOURCE_LOCAL_SECRET");
    const raw = '{ "id":12345678901234567890,  "n":1.10 }';
    const res = await request(app).post("/webhooks/local").set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, buildSignatureHeader(SECRET, now(), raw)).send(raw);
    expect(res.status).toBe(202);
    await processPendingBatch(fake.client);
    expect(received).toEqual([raw]);
  });
  it("falls back to the parsed payload for rows without a stored raw body", async () => {
    const f = makeFakeSupabase([{ id: "old", source: "s", attempts: 0, payload: { x: 1 }, destination_url: "https://d.example/h" }]);
    const deliver = vi.fn(async () => ({ ok: true }));
    await processPendingBatch(f.client, deliver);
    expect(deliver).toHaveBeenCalledWith("https://d.example/h", { x: 1 }, null);
  });
  it("does not follow redirects", async () => {
    let hits = 0;
    const target = http.createServer((_q, r) => { hits++; r.writeHead(200); r.end(); });
    await new Promise<void>((r) => target.listen(0, r));
    const tport = (target.address() as AddressInfo).port;
    server = http.createServer((_q, r) => { r.writeHead(307, { Location: `http://127.0.0.1:${tport}/x` }); r.end(); });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const f = makeFakeSupabase([{ id: "r", source: "s", attempts: 0, payload: { x: 1 }, destination_url: `http://127.0.0.1:${port}/` }]);
    const out = await processPendingBatch(f.client);
    target.close();
    expect(out[0].outcome).toBe("retry");
    expect(hits).toBe(0);
  });
});

describe("crash safety", () => {
  const mk = (id: string) => ({ id, source: "s", attempts: 0, payload: { id }, destination_url: "https://d.example/h" });
  it("a failing row does not strand later rows in in_progress", async () => {
    const f = makeFakeSupabase([mk("e1"), mk("e2"), mk("e3")]);
    const orig = f.client.rpc.bind(f.client);
    vi.spyOn(f.client, "rpc").mockImplementation(((fn: string, args?: Record<string, unknown>) => {
      if (fn === "get_circuit_breaker_state" && f.table.get("e2")!.status === "in_progress" && !f.table.get("e1")!.status.startsWith("in")) {
        // fail once, on the second row
        vi.mocked(f.client.rpc).mockImplementation(orig as never);
        throw new Error("ECONNRESET");
      }
      return orig(fn, args);
    }) as never);
    const out = await processPendingBatch(f.client, async () => ({ ok: true }));
    const statuses = ["e1", "e2", "e3"].map((i) => f.table.get(i)!.status);
    expect(statuses).not.toContain("in_progress");
    expect(out.map((o) => o.outcome)).toContain("released");
    expect(f.table.get("e2")!.attempts).toBe(0);
  });
  it("returns a stale in_progress row to pending and delivers it", async () => {
    const f = makeFakeSupabase([mk("crashed")]);
    await f.client.rpc("claim_pending_webhook_events"); // worker dies right after this
    f.table.get("crashed")!.claimed_at = Date.now() - (STALE_CLAIM_SECONDS + 5) * 1000;
    const out = await processPendingBatch(f.client, async () => ({ ok: true }));
    expect(out.map((o) => o.outcome)).toEqual(["delivered"]);
    expect(f.table.get("crashed")!.status).toBe("delivered");
  });
  it("leaves a recent claim alone", async () => {
    const f = makeFakeSupabase([mk("busy")]);
    await f.client.rpc("claim_pending_webhook_events");
    f.table.get("busy")!.claimed_at = Date.now();
    expect(await processPendingBatch(f.client, async () => ({ ok: true }))).toEqual([]);
    expect(f.table.get("busy")!.status).toBe("in_progress");
  });
});

describe("login throttle", () => {
  it("blocks after repeated failures, before spending bcrypt time, and a good login is also blocked while throttled", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_CLIENT; i++) {
      expect((await request(app).post("/api/login").send({ password: "wrong" + i })).status).toBe(401);
    }
    const blocked = await request(app).post("/api/login").send({ password: "right-password-long-enough" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
  it("a success clears the count", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_CLIENT - 1; i++) await request(app).post("/api/login").send({ password: "x" });
    expect((await request(app).post("/api/login").send({ password: "right-password-long-enough" })).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES_PER_CLIENT - 1; i++) {
      expect((await request(app).post("/api/login").send({ password: "x" })).status).toBe(401);
    }
  });
});
