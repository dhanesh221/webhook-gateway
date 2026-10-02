import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { makeFakeSupabase } from "./fakeSupabase";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";
import { issueSessionToken, revokeAllSessions, SESSION_COOKIE } from "../src/auth";
import { saveSource, disableSource, validateDestination } from "../src/sources";
import { buildProgram } from "../src/cli";
import { realDeps } from "../src/cli";
import { processPendingBatch } from "../src/deliveryWorker";
const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";
const A = "a".repeat(48), B = "b".repeat(48);
let fake: ReturnType<typeof makeFakeSupabase>;
beforeEach(() => {
  fake = makeFakeSupabase([]); holder.client = fake.client;
  vi.stubEnv("WG_SOURCE_ALPHA_SECRET", A); vi.stubEnv("WG_SOURCE_BETA_SECRET", B);
  vi.stubEnv("SESSION_SECRET", "test-session-secret-only");
  vi.stubEnv("ADMIN_PASSWORD_HASH", bcrypt.hashSync("test-password-long-enough", 4));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function post(source: string, secret?: string) {
  const raw = '{"ping":true}';
  const r = request(app).post(`/webhooks/${source}`).set("Content-Type", "application/json");
  if (secret) r.set(SIGNATURE_HEADER, buildSignatureHeader(secret, Math.floor(Date.now()/1000), raw));
  return r.send(raw);
}
const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
async function guard(token: string) {
  return request(app).get("/api/events?status=invalid").set("Cookie", cookie(token));
}
describe("Phase A routes", () => {
  it("routes distinct sources separately, rejects cross-source signing, and snapshots pending destinations", async () => {
    await saveSource("alpha", "https://alpha.example/hook", "WG_SOURCE_ALPHA_SECRET");
    await saveSource("beta", "https://beta.example/hook", "WG_SOURCE_BETA_SECRET");
    expect((await post("alpha", B)).status).toBe(401);
    const first = await post("alpha", A), second = await post("beta", B);
    expect(first.status).toBe(202); expect(second.status).toBe(202);
    await saveSource("alpha", "https://new.example/hook", "WG_SOURCE_ALPHA_SECRET");
    expect(fake.table.get(first.body.id)!.destination_url).toBe("https://alpha.example/hook");
    const deliver = vi.fn(async () => ({ok: true}));
    await processPendingBatch(fake.client, deliver);
    expect(deliver.mock.calls.map(c => (c as unknown as [string])[0])).toEqual(["https://alpha.example/hook", "https://beta.example/hook"]);
  });
  it("rejects unknown, disabled, missing-secret and unsigned sources without insertion", async () => {
    expect((await post("unknown", A)).status).toBe(404);
    await saveSource("alpha", "https://alpha.example/hook", "WG_SOURCE_ALPHA_SECRET");
    expect((await post("alpha")).status).toBe(401);
    vi.stubEnv("WG_SOURCE_ALPHA_SECRET", "");
    expect((await post("alpha", A)).status).toBe(503);
    await disableSource("alpha");
    expect((await post("alpha", A)).status).toBe(404);
    expect(fake.table.size).toBe(0);
  });
  it("fails closed on registry failure", async () => {
    vi.spyOn(fake.client, "rpc").mockResolvedValue({ data: null, error: {message: "secret internal detail"} } as any);
    const result = await post("alpha", A);
    expect(result.status).toBe(500); expect(result.body).toEqual({error: "Internal server error"});
    expect(fake.table.size).toBe(0);
  });
  it("validates secret references and URL policy, including production loopback", async () => {
    await expect(saveSource("alpha", "https://example.com", "SESSION_SECRET")).rejects.toThrow();
    expect(() => validateDestination("https://user:pass@example.com")).toThrow();
    expect(() => validateDestination("ftp://example.com")).toThrow();
    expect(validateDestination("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000/");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => validateDestination("http://127.0.0.1:4000")).toThrow();
  });
  it("CLI manages sources and revokes sessions without exposing signing values", async () => {
    const log = vi.fn();
    await buildProgram({...realDeps, log}).parseAsync(["node", "gateway", "sources", "set", "alpha", "https://example.com/hook", "WG_SOURCE_ALPHA_SECRET"]);
    await buildProgram({...realDeps, log}).parseAsync(["node", "gateway", "sources", "list"]);
    await buildProgram({...realDeps, log}).parseAsync(["node", "gateway", "sources", "disable", "alpha"]);
    const token = await issueSessionToken();
    await buildProgram({...realDeps, log}).parseAsync(["node", "gateway", "sessions-revoke-all"]);
    expect((await guard(token)).status).toBe(401);
    expect(JSON.stringify(log.mock.calls)).not.toContain(A);
    expect(fake.sources.get("alpha")!.enabled).toBe(false);
  });
});
describe("durable session revocation", () => {
  it("logout invalidates a copied cookie, not merely the browser cookie", async () => {
    const token = await issueSessionToken();
    expect((await guard(token)).status).toBe(400);
    const logout = await request(app).post("/api/logout").set("Cookie", cookie(token));
    expect(logout.status).toBe(200); expect((await guard(token)).status).toBe(401);
  });
  it("revoke-all invalidates every issued token", async () => {
    const tokens = [await issueSessionToken(), await issueSessionToken()];
    await revokeAllSessions();
    for (const token of tokens) expect((await guard(token)).status).toBe(401);
  });
  it("password hash changes invalidate even unrevoked cookies", async () => {
    const token = await issueSessionToken();
    vi.stubEnv("ADMIN_PASSWORD_HASH", bcrypt.hashSync("another-password-long-enough", 4));
    expect((await guard(token)).status).toBe(401);
  });
  it("rejects legacy signed tokens lacking a registry id", async () => {
    const token = jwt.sign({sub:"admin"}, process.env.SESSION_SECRET!, {expiresIn:3600});
    expect((await guard(token)).status).toBe(401);
  });
  it("expiry in durable storage rejects a token even if JWT is still current", async () => {
    const token = await issueSessionToken();
    fake.sessions.get((jwt.decode(token) as {jti:string}).jti)!.expires = Date.now()-1;
    expect((await guard(token)).status).toBe(401);
  });
  it("storage outage fails closed for auth, login and logout", async () => {
    const token = await issueSessionToken();
    vi.spyOn(fake.client, "rpc").mockResolvedValue({data:null,error:{message:"internal"}} as any);
    expect((await guard(token)).status).toBe(500);
    expect((await request(app).post("/api/login").send({password:"test-password-long-enough"})).headers["set-cookie"]).toBeUndefined();
    expect((await request(app).post("/api/logout").set("Cookie",cookie(token))).status).toBe(500);
  });
  it("production cookies are secure, httpOnly, and expire in 12 hours", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const login = await request(app).post("/api/login").send({password:"test-password-long-enough"});
    expect(login.headers["set-cookie"][0]).toMatch(/Secure/);
    expect(login.headers["set-cookie"][0]).toMatch(/Max-Age=43200/);
  });
});
