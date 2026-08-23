import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Stand-in for the Supabase call chain: from(...).insert(...)
// vi.hoisted runs before vi.mock, which vitest lifts above the imports.
const mocks = vi.hoisted(() => {
  const insert = vi.fn();
  const from = vi.fn(() => ({ insert }));
  return { insert, from };
});

vi.mock("../src/supabase", () => ({
  getSupabase: () => ({ from: mocks.from }),
}));

import { app } from "../src/app";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /webhooks/:source", () => {
  it("stores a valid webhook and returns 202", async () => {
    mocks.insert.mockResolvedValue({ error: null });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_abc123")
      .send({ event: "payment.succeeded", amount: 500 });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(res.body.id).toMatch(UUID_RE);

    expect(mocks.from).toHaveBeenCalledWith("webhook_events");
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    const inserted = mocks.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      source: "stripe",
      idempotency_key: "evt_abc123",
      status: "pending",
      payload: { event: "payment.succeeded", amount: 500 },
    });
    expect(inserted.headers).toBeTypeOf("object");
  });

  it("generates the id itself and returns the same one it stored", async () => {
    // Regression guard: the table is INSERT-only under RLS, so the id cannot be
    // read back from Postgres. It must be generated here and sent in the row.
    mocks.insert.mockResolvedValue({ error: null });

    const res = await request(app)
      .post("/webhooks/stripe")
      .send({ event: "ping" });

    const inserted = mocks.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.id).toMatch(UUID_RE);
    expect(res.body.id).toBe(inserted.id);
  });

  it("stores idempotency_key as null when the header is absent", async () => {
    mocks.insert.mockResolvedValue({ error: null });

    const res = await request(app).post("/webhooks/github").send({ ping: true });

    expect(res.status).toBe(202);
    const inserted = mocks.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.idempotency_key).toBeNull();
    expect(inserted.source).toBe("github");
  });

  it("returns 200 duplicate on a repeated idempotency key, without inserting twice", async () => {
    // 23505 = Postgres unique_violation, raised by the unique index on
    // (source, idempotency_key). This is a redelivery, not an error.
    mocks.insert.mockResolvedValue({
      error: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_abc123")
      .send({ event: "payment.succeeded", amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "duplicate",
      message: "already received",
    });

    // The insert was attempted once; the database rejected it and we did not retry.
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the insert fails for any other reason", async () => {
    mocks.insert.mockResolvedValue({
      error: { code: "42501", message: "row-level security policy" },
    });

    const res = await request(app).post("/webhooks/stripe").send({ a: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it("stores destination_url from DESTINATION_URL, or null when unset", async () => {
    mocks.insert.mockResolvedValue({ error: null });

    await request(app).post("/webhooks/stripe").send({ a: 1 });
    let inserted = mocks.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.destination_url).toBeNull();

    vi.stubEnv("DESTINATION_URL", "http://localhost:4000/receive");
    await request(app).post("/webhooks/stripe").send({ a: 1 });
    inserted = mocks.insert.mock.calls[1][0] as Record<string, unknown>;
    expect(inserted.destination_url).toBe("http://localhost:4000/receive");
    vi.unstubAllEnvs();
  });

  it("returns 400 on an empty body and never touches the database", async () => {
    const res = await request(app).post("/webhooks/stripe").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
