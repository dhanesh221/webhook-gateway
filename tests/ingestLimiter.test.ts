import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeFakeSupabase } from "./fakeSupabase";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";
import { saveSource } from "../src/sources";
import {
  SlidingWindow, resetIngestLimits, DEFAULT_SOURCE_RATE_PER_MINUTE, DEFAULT_AUTH_FAILURES_PER_MINUTE,
} from "../src/ingestLimiter";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app, configureTrustProxy } from "../src/app";

const SECRET = "rate-limit-test-secret-at-least-32-bytes-long";
const raw = '{"ping":true}';

describe("SlidingWindow", () => {
  it("allows `limit` hits per window and then reports the wait until the oldest expires", () => {
    const w = new SlidingWindow(60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) { expect(w.retryAfterSeconds("k", 3, t0 + i * 1000)).toBe(0); w.hit("k", t0 + i * 1000); }
    expect(w.retryAfterSeconds("k", 3, t0 + 3000)).toBe(57);     // oldest at t0 leaves at t0+60s
    expect(w.retryAfterSeconds("k", 3, t0 + 60_000)).toBe(0);    // and it has
    expect(w.retryAfterSeconds("other", 3, t0 + 3000)).toBe(0);  // keys are independent
    expect(w.retryAfterSeconds("k", 0, t0 + 3000)).toBe(0);      // 0 disables
  });
});

describe("ingest rate limits", () => {
  let fake: ReturnType<typeof makeFakeSupabase>;
  beforeEach(async () => {
    resetIngestLimits();
    fake = makeFakeSupabase([]); holder.client = fake.client;
    vi.stubEnv("WG_SOURCE_PAY_SECRET", SECRET);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await saveSource("pay", "https://pay.example/hook", "WG_SOURCE_PAY_SECRET");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); configureTrustProxy(app, undefined); });

  const signed = (source = "pay", extra: Record<string, string> = {}) => {
    const r = request(app).post(`/webhooks/${source}`).set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, buildSignatureHeader(SECRET, Math.floor(Date.now() / 1000), raw));
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r.send(raw);
  };
  const unsigned = (source = "pay", extra: Record<string, string> = {}) => {
    const r = request(app).post(`/webhooks/${source}`).set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r.send(raw);
  };

  it("answers 429 with Retry-After once a source exceeds its per-minute rate, before touching the registry", async () => {
    vi.stubEnv("WG_INGEST_RATE_PER_MINUTE", "3");
    for (let i = 0; i < 3; i++) expect((await signed()).status).toBe(202);
    const rpc = vi.spyOn(fake.client, "rpc");
    const blocked = await signed();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error).toMatch(/source/);
    expect(rpc).not.toHaveBeenCalled();             // no registry read while limited
    expect(fake.table.size).toBe(3);
  });

  it("limits sources independently and counts rejected requests against the source too", async () => {
    vi.stubEnv("WG_INGEST_RATE_PER_MINUTE", "2");
    expect((await unsigned()).status).toBe(401);    // counts
    expect((await signed()).status).toBe(202);
    expect((await signed()).status).toBe(429);
    expect((await unsigned("nope")).status).toBe(404); // another source, its own bucket
  });

  it("blocks a client after repeated signature failures, while other clients proceed when a proxy is trusted", async () => {
    vi.stubEnv("WG_INGEST_AUTH_FAILURES_PER_MINUTE", "2");
    configureTrustProxy(app, "1");
    const a = { "X-Forwarded-For": "203.0.113.10" };
    const b = { "X-Forwarded-For": "203.0.113.20" };
    expect((await unsigned("pay", a)).status).toBe(401);
    expect((await unsigned("nope", a)).status).toBe(404);     // unknown source counts as well
    const blocked = await signed("pay", a);                   // even a valid request is refused now
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error).toMatch(/failed requests/);
    expect((await signed("pay", b)).status).toBe(202);        // a different client is unaffected
  });

  it("without TRUST_PROXY, X-Forwarded-For is ignored and all requests share the peer address", async () => {
    vi.stubEnv("WG_INGEST_AUTH_FAILURES_PER_MINUTE", "1");
    expect((await unsigned("pay", { "X-Forwarded-For": "203.0.113.10" })).status).toBe(401);
    expect((await signed("pay", { "X-Forwarded-For": "203.0.113.20" })).status).toBe(429);
  });

  it("a limit of 0 disables that limit", async () => {
    vi.stubEnv("WG_INGEST_RATE_PER_MINUTE", "0");
    vi.stubEnv("WG_INGEST_AUTH_FAILURES_PER_MINUTE", "0");
    for (let i = 0; i < 5; i++) expect((await unsigned()).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await signed()).status).toBe(202);
  });

  it("defaults are generous enough for a real provider burst", () => {
    expect(DEFAULT_SOURCE_RATE_PER_MINUTE).toBeGreaterThanOrEqual(600);
    expect(DEFAULT_AUTH_FAILURES_PER_MINUTE).toBeGreaterThanOrEqual(30);
  });

  it("configureTrustProxy accepts Express's forms", () => {
    configureTrustProxy(app, undefined); expect(app.get("trust proxy")).toBe(false);
    configureTrustProxy(app, "false"); expect(app.get("trust proxy")).toBe(false);
    configureTrustProxy(app, "true"); expect(app.get("trust proxy")).toBe(true);
    configureTrustProxy(app, "2"); expect(app.get("trust proxy")).toBe(2);
    configureTrustProxy(app, "loopback, 10.0.0.0/8"); expect(app.get("trust proxy")).toBe("loopback, 10.0.0.0/8");
  });
});
