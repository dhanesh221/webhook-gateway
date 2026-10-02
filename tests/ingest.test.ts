import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import unsignedRequest from "supertest";
import request, { TEST_SOURCE_SECRET } from "./signedRequest";

// Stand-in for the Supabase call chain: from(...).insert(...)
// vi.hoisted runs before vi.mock, which vitest lifts above the imports.
const mocks = vi.hoisted(() => {
  const insert = vi.fn();
  const from = vi.fn(() => ({ insert }));
  const rpc = vi.fn(async () => ({ data: [{ name: "stripe", destination_url: "http://localhost:4000/receive", secret_env: "WG_SOURCE_TEST_SECRET", enabled: true }], error: null }));
  return { insert, from, rpc };
});

vi.mock("../src/supabase", () => ({
  getSupabase: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

import { app, MAX_BODY_BYTES } from "../src/app";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
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

  it("snapshots destination_url from the registered source, ignoring the global fallback", async () => {
    mocks.insert.mockResolvedValue({ error: null });
    vi.stubEnv("DESTINATION_URL", "https://wrong.example/receive");
    await request(app).post("/webhooks/stripe").send({ a: 1 });
    const inserted = mocks.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.destination_url).toBe("http://localhost:4000/receive");
  });

  it("returns 400 on an empty body and never touches the database", async () => {
    const res = await request(app).post("/webhooks/stripe").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns a clean JSON 413 with no stack trace for an oversized body", async () => {
    // Oversizing is derived from the exported limit rather than hardcoded, so
    // this test keeps testing the boundary if the limit is ever retuned.
    // Previously this fell through to Express's default HTML error handler and
    // leaked a stack trace with absolute filesystem paths. See
    // Failures/error-handler-leaks-stack-trace.md.
    const oversized = { data: "x".repeat(MAX_BODY_BYTES + 1024) };

    const res = await request(app).post("/webhooks/stripe").send(oversized);

    expect(res.status).toBe(413);
    expect(res.type).toBe("application/json");
    expect(res.body).toEqual({ error: "Payload too large" });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/at \w+ \(/); // stack frame shape
    expect(raw).not.toContain(process.cwd());
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("source validation", () => {
  beforeEach(() => {
    mocks.insert.mockResolvedValue({ error: null });
  });

  // Live probing in Phase 2 showed %2E%2E%2F… decoded to `../../etc` and was
  // stored verbatim. Inert then, but `source` is half the idempotency identity
  // and appears in dashboard URLs.
  it.each([
    ["encoded traversal", "%2E%2E%2F%2E%2E%2Fetc"],
    ["encoded slash", "stripe%2Fevil"],
    ["empty-ish", "%20"],
    ["too long", "s".repeat(65)],
  ])("rejects %s with 400 and never inserts", async (_label, source) => {
    const res = await request(app).post(`/webhooks/${source}`).send({ a: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each(["stripe", "github-events", "my_source", "s".repeat(64)])(
    "accepts %s",
    async (source) => {
      const res = await request(app).post(`/webhooks/${source}`).send({ a: 1 });
      expect(res.status).toBe(202);
    }
  );
});

describe("signature verification", () => {
  const SECRET = TEST_SOURCE_SECRET;
  const BODY = JSON.stringify({ event: "payment.succeeded", amount: 500 });

  beforeEach(() => {
    mocks.insert.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function post(rawBody: string, header?: string) {
    const req = unsignedRequest(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json");
    if (header) req.set(SIGNATURE_HEADER, header);
    return req.send(rawBody);
  }

  it("rejects unsigned requests with no global secret configured", async () => {
    const res = await post(BODY);

    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request when a secret is configured", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);
    const now = Math.floor(Date.now() / 1000);

    const res = await post(BODY, buildSignatureHeader(SECRET, now, BODY));

    expect(res.status).toBe(202);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsigned request once a secret is configured", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);

    const res = await post(BODY);

    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with after signing", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);
    const now = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(SECRET, now, BODY);

    // Same signature, different body — the amount has been altered in transit.
    const tampered = JSON.stringify({ event: "payment.succeeded", amount: 999999 });
    const res = await post(tampered, header);

    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a signature signed with the wrong secret", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);
    const now = Math.floor(Date.now() / 1000);

    const res = await post(BODY, buildSignatureHeader("wrong-secret", now, BODY));

    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a replayed request whose timestamp is outside tolerance", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);
    // Correctly signed, but captured an hour ago.
    const old = Math.floor(Date.now() / 1000) - 3600;

    const res = await post(BODY, buildSignatureHeader(SECRET, old, BODY));

    expect(res.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("never tells the caller why the signature failed", async () => {
    vi.stubEnv("WG_SOURCE_TEST_SECRET", SECRET);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await post(BODY, "t=1,v1=deadbeef");

    // A specific reason would help an attacker iterate toward a forgery.
    expect(res.body).toEqual({ error: "Invalid signature" });
  });
});
