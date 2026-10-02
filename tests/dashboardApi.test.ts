import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { SESSION_COOKIE, issueSessionToken } from "../src/auth";
import { makeFakeSupabase } from "./fakeSupabase";

// One shared fake per test, swapped in through this holder so the module mock
// (which is hoisted above the imports) can reach whichever one is current.
const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../src/supabase", () => ({
  getSupabase: () => holder.client,
}));

import { app } from "../src/app";

const TEST_SECRET = "test-session-secret";

async function authCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSessionToken()}`;
}

const DEST = "http://localhost:4000/receive";

// A spread of statuses so filtering has something to actually filter.
function seed() {
  const fake = makeFakeSupabase([
    { id: "11111111-1111-1111-1111-111111111111", source: "stripe", attempts: 0, payload: { a: 1 }, destination_url: DEST },
    { id: "22222222-2222-2222-2222-222222222222", source: "github", attempts: 5, payload: { b: 2 }, destination_url: DEST },
    { id: "33333333-3333-3333-3333-333333333333", source: "shopify", attempts: 2, payload: { c: 3 }, destination_url: DEST },
  ]);

  fake.table.get("22222222-2222-2222-2222-222222222222")!.status = "dead_lettered";
  fake.table.get("33333333-3333-3333-3333-333333333333")!.status = "delivered";

  holder.client = fake.client;
  return fake;
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("ADMIN_PASSWORD_HASH", "$2b$04$fake-version-for-token-tests");
  seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/events", () => {
  it("401s without a session, and never queries the database", async () => {
    const rpc = vi.spyOn(holder.client as { rpc: () => unknown }, "rpc");

    const res = await request(app).get("/api/events");

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns every event when no status filter is given", async () => {
    const res = await request(app).get("/api/events").set("Cookie", await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events.map((e: { source: string }) => e.source).sort()).toEqual([
      "github",
      "shopify",
      "stripe",
    ]);
  });

  it("passes the status filter through to list_webhook_events", async () => {
    const rpc = vi.spyOn(holder.client as { rpc: () => unknown }, "rpc");

    const res = await request(app)
      .get("/api/events?status=dead_lettered")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("list_webhook_events", {
      p_status: "dead_lettered",
      p_limit: 100,
    });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].source).toBe("github");
  });

  it("sends p_status: null for an absent or empty filter", async () => {
    const rpc = vi.spyOn(holder.client as { rpc: () => unknown }, "rpc");

    await request(app).get("/api/events").set("Cookie", await authCookie());
    expect(rpc).toHaveBeenLastCalledWith("list_webhook_events", {
      p_status: null,
      p_limit: 100,
    });

    // The dashboard's "All" option submits status= with an empty value.
    await request(app).get("/api/events?status=").set("Cookie", await authCookie());
    expect(rpc).toHaveBeenLastCalledWith("list_webhook_events", {
      p_status: null,
      p_limit: 100,
    });
  });

  it("400s on an unknown status instead of silently returning nothing", async () => {
    const rpc = vi.spyOn(holder.client as { rpc: () => unknown }, "rpc");

    const res = await request(app)
      .get("/api/events?status=dead-lettered")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("dead_lettered");
    expect(rpc).not.toHaveBeenCalledWith("list_webhook_events", expect.anything());
  });

  it("omits payload and headers from the response", async () => {
    // Payloads can be ~100 KB each and none of them are rendered; sending 100
    // of them would make a multi-megabyte response for a table of five columns.
    const res = await request(app).get("/api/events").set("Cookie", await authCookie());

    for (const event of res.body.events) {
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("headers");
      expect(event).toHaveProperty("attempts");
      expect(event).toHaveProperty("received_at");
    }
  });

  it("500s with a generic message when the RPC errors", async () => {
    const cookie = await authCookie();
    const originalRpc = (holder.client as any).rpc;
    (holder.client as any).rpc = async (fn: string, args: unknown) => fn === "list_webhook_events"
      ? { data: null, error: { message: "boom: connection to db-host-7 refused" } } : originalRpc(fn, args);

    const res = await request(app).get("/api/events").set("Cookie", cookie);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to list events" });
    expect(JSON.stringify(res.body)).not.toContain("db-host-7");
  });
});

describe("GET /api/circuit-breakers", () => {
  it("401s without a session", async () => {
    const res = await request(app).get("/api/circuit-breakers");
    expect(res.status).toBe(401);
  });

  it("returns breaker rows from list_circuit_breakers", async () => {
    const fake = seed();
    // Trip a breaker the same way the worker would, so there's a row to read.
    for (let i = 0; i < 5; i++) {
      await fake.client.rpc("record_delivery_failure", { p_destination_url: DEST });
    }

    const rpc = vi.spyOn(fake.client as unknown as { rpc: () => unknown }, "rpc");

    const res = await request(app)
      .get("/api/circuit-breakers")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("list_circuit_breakers");
    expect(res.body.breakers).toHaveLength(1);
    expect(res.body.breakers[0]).toMatchObject({
      destination_url: DEST,
      state: "open",
      consecutive_failures: 5,
    });
    expect(res.body.breakers[0].next_probe_at).toBeTruthy();
  });

  it("returns an empty list rather than erroring when no breakers exist", async () => {
    const res = await request(app)
      .get("/api/circuit-breakers")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.breakers).toEqual([]);
  });
});

describe("POST /api/events/:id/replay", () => {
  const DEAD = "22222222-2222-2222-2222-222222222222";
  const PENDING = "11111111-1111-1111-1111-111111111111";

  it("401s without a session, and never calls replay_webhook_event", async () => {
    const rpc = vi.spyOn(holder.client as { rpc: () => unknown }, "rpc");

    const res = await request(app).post(`/api/events/${DEAD}/replay`);

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("replays a dead-lettered event back to pending with attempts reset", async () => {
    const fake = seed();

    const res = await request(app)
      .post(`/api/events/${DEAD}/replay`)
      .set("Cookie", await authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "replayed", id: DEAD });

    const row = fake.table.get(DEAD)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("409s on an event that is not dead-lettered, and does not call replay", async () => {
    // The important half: replay_webhook_event returns { data: null, error: null }
    // whether or not it matched anything, so calling it here would report a
    // success that never happened.
    const fake = seed();
    const rpc = vi.spyOn(fake.client as unknown as { rpc: () => unknown }, "rpc");

    const res = await request(app)
      .post(`/api/events/${PENDING}/replay`)
      .set("Cookie", await authCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("not dead-lettered");
    expect(rpc).not.toHaveBeenCalledWith("replay_webhook_event", expect.anything());
    expect(fake.table.get(PENDING)!.status).toBe("pending");
  });

  it("409s on an id that doesn't exist at all", async () => {
    const res = await request(app)
      .post("/api/events/99999999-9999-9999-9999-999999999999/replay")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("not dead-lettered");
  });

  it("409s on a non-UUID id without ever reaching Postgres with it", async () => {
    const fake = seed();
    const rpc = vi.spyOn(fake.client as unknown as { rpc: () => unknown }, "rpc");

    const res = await request(app)
      .post("/api/events/not-a-uuid/replay")
      .set("Cookie", await authCookie());

    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("replay_webhook_event", expect.anything());
  });

  it("is not repeatable — a second replay of the same event 409s", async () => {
    await request(app).post(`/api/events/${DEAD}/replay`).set("Cookie", await authCookie());

    const second = await request(app)
      .post(`/api/events/${DEAD}/replay`)
      .set("Cookie", await authCookie());

    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already replayed");
  });

  it("500s with a generic message when the lookup RPC errors", async () => {
    const cookie = await authCookie();
    const originalRpc = (holder.client as any).rpc;
    (holder.client as any).rpc = async (fn: string, args: unknown) => fn === "list_webhook_events"
      ? { data: null, error: { message: "internal detail" } } : originalRpc(fn, args);

    const res = await request(app)
      .post(`/api/events/${DEAD}/replay`)
      .set("Cookie", cookie);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to look up event" });
  });
});
