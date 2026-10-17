import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeFakeSupabase } from "./fakeSupabase";

const holder = vi.hoisted(() => ({ client: null as unknown, throwOnGet: false }));
vi.mock("../src/supabase", () => ({
  getSupabase: () => { if (holder.throwOnGet) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"); return holder.client; },
}));
import { app } from "../src/app";

describe("GET /ready", () => {
  let fake: ReturnType<typeof makeFakeSupabase>;
  beforeEach(() => { fake = makeFakeSupabase([]); holder.client = fake.client; holder.throwOnGet = false; vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("is 200 when the database answers", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
  });

  it("is 503 when the RPC fails, and /health stays 200", async () => {
    vi.spyOn(fake.client, "rpc").mockResolvedValue({ data: null, error: { message: "permission denied" } } as never);
    expect((await request(app).get("/ready")).status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("is 503, not 500, when credentials are not configured at all", async () => {
    holder.throwOnGet = true;
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready" });
  });

  it("does not require a session cookie", async () => {
    expect((await request(app).get("/ready").set("Cookie", "wg_session=garbage")).status).toBe(200);
  });
});
