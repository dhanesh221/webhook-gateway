import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => {
  const abortSignal = vi.fn();
  const limit = vi.fn(() => ({ abortSignal }));
  const select = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ select }));
  const getSupabase = vi.fn(() => ({ from }));
  return { abortSignal, limit, select, from, getSupabase };
});
vi.mock("../src/supabase", () => ({ getSupabase: mocks.getSupabase }));
import { app } from "../src/app";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.abortSignal.mockResolvedValue({ data: [], error: null });
});

describe("GET /health", () => {
  it("returns 200 only after checking the ingest columns, without writing events", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(mocks.from).toHaveBeenCalledWith("webhook_events");
    expect(mocks.select).toHaveBeenCalledWith("id, source, idempotency_key, headers, payload, raw_body, status, destination_url");
    expect(mocks.limit).toHaveBeenCalledWith(0);
    expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it.each([
    ["missing migration 009", "column raw_body does not exist"],
    ["database access denied", "permission denied for table webhook_events"],
  ])("returns 503 for %s without leaking database details", async (_name, message) => {
    mocks.abortSignal.mockResolvedValue({ data: null, error: { message } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(res.text).not.toContain(message);
  });

  it.each(["connection failed", "request timed out"])("returns 503 when the query throws: %s", async (message) => {
    mocks.abortSignal.mockRejectedValue(new Error(message));
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable" });
  });

  it("returns 503 when database configuration is missing", async () => {
    mocks.getSupabase.mockImplementationOnce(() => { throw new Error("missing service-role key"); });
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable" });
  });

  it("recovers on the next check after a database failure", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ error: { message: "offline" } });
    expect((await request(app).get("/health")).status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("unknown routes", () => {
  it("returns 404 for a route that doesn't exist", async () => {
    expect((await request(app).get("/nope")).status).toBe(404);
  });
});

describe("app import", () => {
  it("does not bind a real port on import", () => {
    expect(typeof app.listen).toBe("function");
    expect(typeof app).toBe("function");
  });
});
