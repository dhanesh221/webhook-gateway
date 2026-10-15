import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import signedRequest, { TEST_SOURCE_SECRET } from "./signedRequest";
import { makeFakeSupabase } from "./fakeSupabase";
const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";
import { gatewayMetrics } from "../src/metrics";
import { issueSessionToken, SESSION_COOKIE } from "../src/auth";
const token = "unit-test-metrics-bearer-at-least-32-characters";
let db: ReturnType<typeof makeFakeSupabase>;
beforeEach(() => {
  db = makeFakeSupabase([]); holder.client = db.client;
  db.sources.set("github", { name: "github", destination_url: "https://receiver.test/private?secret=abc", secret_env: "WG_SOURCE_TEST_SECRET", enabled: true });
  vi.stubEnv("WG_METRICS_TOKEN", token); vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
  vi.stubEnv("SESSION_SECRET", "session-secret-with-more-than-32-chars"); vi.stubEnv("ADMIN_PASSWORD_HASH", "test-credential-version");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const scrape = () => request(app).get("/metrics").set("Authorization", `Bearer ${token}`);
const received = () => BigInt(gatewayMetrics.render().match(/^webhook_events_received_total (\d+)$/m)![1]);

describe("GET /metrics", () => {
  it("serves the correct Prometheus content type and no-cache policy", async () => {
    const res = await scrape(); expect(res.status).toBe(200);
    expect(res.headers["content-type"].split("; ").sort()).toEqual(["charset=utf-8", "text/plain", "version=0.0.4"]);
    expect(res.headers["cache-control"]).toBe("no-store"); expect(res.text.endsWith("\n")).toBe(true);
    expect(res.text).toBe(gatewayMetrics.render());
  });
  it("does not disclose counters without authentication", async () => {
    const res = await request(app).get("/metrics"); expect(res.status).toBe(401);
    expect(res.text).not.toContain("webhook_events"); expect(res.headers["cache-control"]).toBe("no-store");
  });
  it.each(["Bearer bad", "Bearer ", "Basic abc", "bearer lower", "Bearer " + token + "suffix"])("rejects invalid bearer: %s", async auth => {
    expect((await request(app).get("/metrics").set("Authorization", auth)).status).toBe(401);
  });
  it("never accepts query string tokens", async () => {
    expect((await request(app).get("/metrics").query({ token, access_token: token })).status).toBe(401);
  });
  it("fails closed when token is not configured", async () => {
    vi.stubEnv("WG_METRICS_TOKEN", ""); expect((await scrape()).status).toBe(401);
  });
  it("scrapes with bearer even if database and session config are unavailable", async () => {
    holder.client = null; vi.stubEnv("SESSION_SECRET", "");
    expect((await scrape()).status).toBe(200);
  });
  it("supports a real valid dashboard session without a bearer", async () => {
    const session = await issueSessionToken(); vi.stubEnv("WG_METRICS_TOKEN", "");
    expect((await request(app).get("/metrics").set("Cookie", `${SESSION_COOKIE}=${session}`)).status).toBe(200);
  });
  it("rejects a revoked dashboard session", async () => {
    const session = await issueSessionToken(); for (const s of db.sessions.values()) s.revoked = true;
    expect((await request(app).get("/metrics").set("Cookie", `${SESSION_COOKIE}=${session}`)).status).toBe(401);
  });
  it("rejects malformed dashboard cookies", async () => {
    expect((await request(app).get("/metrics").set("Cookie", `${SESSION_COOKIE}=junk`)).status).toBe(401);
  });
  it("fails closed on session database errors without leaking them", async () => {
    const session = await issueSessionToken(); vi.spyOn(db.client, "rpc").mockResolvedValue({ data: null, error: { message: "private DB error" } } as any);
    const res = await request(app).get("/metrics").set("Cookie", `${SESSION_COOKIE}=${session}`);
    expect(res.status).toBe(500); expect(res.text).not.toContain("private DB error");
  });
  it("supports HEAD with the same content type and no body", async () => {
    const res = await request(app).head("/metrics").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200); expect(res.text).toBeUndefined(); expect(res.headers["content-type"]).toContain("version=0.0.4");
  });
  it("does not accept POST", async () => {
    expect((await request(app).post("/metrics").set("Authorization", `Bearer ${token}`)).status).toBe(404);
  });
  it("scraping 100 times concurrently does not increment any counter or query DB", async () => {
    const before = gatewayMetrics.render(); const rpc = vi.spyOn(db.client, "rpc");
    const results = await Promise.all(Array.from({ length: 100 }, scrape));
    expect(results.every(r => r.status === 200 && r.text === before)).toBe(true); expect(rpc).not.toHaveBeenCalled();
  });
  it("never exposes the bearer token, session secret or raw destination", async () => {
    gatewayMetrics.increment("received", "github", "https://receiver.test/private?secret=abc");
    const res = await scrape(); for (const secret of [token, "session-secret-with-more-than-32-chars", "receiver.test", "secret=abc"]) expect(res.text).not.toContain(secret);
  });
});

describe("ingest metric boundaries", () => {
  it("counts only newly stored events and excludes duplicate acknowledgements", async () => {
    const before = received();
    for (const expected of [202, 200]) {
      const res = await signedRequest(app).post("/webhooks/github").set("Idempotency-Key", "same").send({ ping: true }); expect(res.status).toBe(expected);
    }
    expect(received()).toBe(before + 1n);
  });
  it.each(["invalid JSON", "empty object", "invalid signature", "missing source", "unsupported type"])("does not count rejected ingest: %s", async reason => {
    const before = received(); let res;
    if (reason === "invalid JSON") res = await request(app).post("/webhooks/github").set("Content-Type", "application/json").send("{bad");
    else if (reason === "empty object") res = await signedRequest(app).post("/webhooks/github").send({});
    else if (reason === "invalid signature") res = await request(app).post("/webhooks/github").send({ ping: true });
    else if (reason === "missing source") res = await signedRequest(app).post("/webhooks/missing").send({ ping: true });
    else res = await request(app).post("/webhooks/github").send("plain text");
    expect(res.status).toBeGreaterThanOrEqual(400); expect(received()).toBe(before);
  });
  it("does not count a failed database insert", async () => {
    const before = received(); vi.spyOn(db.client, "from").mockReturnValue({ insert: async () => ({ error: { message: "offline" } }) } as any);
    expect((await signedRequest(app).post("/webhooks/github").send({ ping: true })).status).toBe(500); expect(received()).toBe(before);
  });
  it("counts concurrently accepted events exactly", async () => {
    const before = received(); const results = await Promise.all(Array.from({ length: 100 }, (_, i) => signedRequest(app).post("/webhooks/github").send({ i })));
    expect(results.every(r => r.status === 202)).toBe(true); expect(received()).toBe(before + 100n);
  });
});
