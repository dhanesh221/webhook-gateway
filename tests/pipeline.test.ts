// End-to-end pipeline tests: the real Express app, the real delivery worker, and
// the real DLQ CLI functions all wired to ONE shared fake Supabase, plus a real
// local HTTP server standing in for the downstream destination.
//
// The other test files exercise each piece in isolation. These exercise the
// seams between them — an ingested event actually being claimed and delivered,
// a dead-letter and a tripped breaker happening off the same failures, and a
// replayed event actually going back out on a later poll.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import request, { TEST_SOURCE_SECRET } from "./signedRequest";
import bcrypt from "bcryptjs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { processPendingBatch } from "../src/deliveryWorker";
import { makeFakeSupabase } from "./fakeSupabase";

// One mutable holder, set per test, because each test needs its own fake table.
const mocks = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("../src/supabase", () => ({
  getSupabase: () => mocks.client,
}));

// Imported after the mock is registered, so both pick up the fake client.
import { app } from "../src/app";
import { list, replay } from "../src/dlq";

interface Received {
  url: string | undefined;
  body: unknown;
}

describe("full pipeline", () => {
  let server: http.Server | undefined;
  let received: Received[] = [];
  const originalDestination = process.env.DESTINATION_URL;

  beforeEach(() => {
    received = [];
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    vi.useRealTimers();
    if (originalDestination === undefined) {
      delete process.env.DESTINATION_URL;
    } else {
      process.env.DESTINATION_URL = originalDestination;
    }
  });

  // Starts a real receiver and returns its base URL. `respond` decides the
  // status code per request, so a test can flip a destination from down to up.
  async function startReceiver(respond: () => number): Promise<string> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        received.push({
          url: req.url,
          body: raw ? JSON.parse(raw) : null,
        });
        res.writeHead(respond());
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}/receive`;
  }

  it("delivers an event ingested through POST /webhooks/:source on the next worker poll", async () => {
    const destinationUrl = await startReceiver(() => 200);
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([]);
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const payload = { event: "payment.succeeded", amount: 500 };
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_pipeline_1")
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    const id = res.body.id as string;

    // The row exists and is waiting, but nothing has been delivered yet — the
    // ingest endpoint must never call the destination itself.
    expect(table.get(id)!.status).toBe("pending");
    expect(received).toHaveLength(0);

    const outcomes = await processPendingBatch(client);

    expect(outcomes).toEqual([{ id, outcome: "delivered", attempt: 1 }]);
    expect(table.get(id)!.status).toBe("delivered");
    // The destination received the original payload verbatim, exactly once.
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual(payload);
  });

  it("does not deliver a duplicate twice: the second ingest is deduped before the worker ever sees it", async () => {
    const destinationUrl = await startReceiver(() => 200);
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([]);
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const payload = { event: "invoice.paid" };
    const first = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_dupe")
      .send(payload);
    const second = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_dupe")
      .send(payload);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
    expect(table.size).toBe(1);

    await processPendingBatch(client);

    // The whole point of idempotency: one downstream side effect, not two.
    expect(received).toHaveLength(1);
  });

  it("dead-letters the event AND trips the destination's breaker off the same run of failures", async () => {
    const destinationUrl = await startReceiver(() => 500);
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, breakers, sources } = makeFakeSupabase([], { cooldownMs: 60_000 });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_doomed")
      .send({ event: "charge.failed" });
    const id = res.body.id as string;

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const batch = await processPendingBatch(client);
      outcomes.push(batch[0].outcome);
    }

    // Per-event state: five real attempts, then dead-lettered.
    expect(outcomes).toEqual(["retry", "retry", "retry", "retry", "dead_lettered"]);
    expect(table.get(id)!.status).toBe("dead_lettered");
    expect(table.get(id)!.attempts).toBe(5);
    expect(received).toHaveLength(5);

    // Per-destination state, tracked independently of the event's own retry
    // budget: five consecutive failures at one destination opened the breaker,
    // with a cooldown in the future.
    const breaker = breakers.get(destinationUrl)!;
    expect(breaker.state).toBe("open");
    expect(breaker.consecutiveFailures).toBe(5);
    expect(Date.parse(breaker.nextProbeAt!)).toBeGreaterThan(Date.now());

    // A brand-new event to the same destination is now skipped without a
    // request, even though its own attempts budget is untouched.
    const fresh = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_after_trip")
      .send({ event: "charge.failed" });
    const freshOutcomes = await processPendingBatch(client);

    expect(freshOutcomes).toEqual([
      { id: fresh.body.id, outcome: "skipped", attempt: 0 },
    ]);
    expect(received).toHaveLength(5);
  });

  it("delivers a dead-lettered event that was replayed through the DLQ CLI, once the destination recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const COOLDOWN_MS = 5_000;
    let destinationUp = false;
    const destinationUrl = await startReceiver(() => (destinationUp ? 200 : 500));
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([], { cooldownMs: COOLDOWN_MS });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const res = await request(app)
      .post("/webhooks/github")
      .set("Idempotency-Key", "evt_replayable")
      .send({ event: "push", ref: "refs/heads/main" });
    const id = res.body.id as string;

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }
    expect(table.get(id)!.status).toBe("dead_lettered");

    // The operator sees it in the dead-letter queue...
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await list();
    expect(logSpy.mock.calls.flat().join("\n")).toContain(id);

    // ...fixes the destination, waits out the breaker cooldown, and replays.
    destinationUp = true;
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1_000));

    await replay(id);
    logSpy.mockRestore();

    expect(table.get(id)!.status).toBe("pending");
    expect(table.get(id)!.attempts).toBe(0); // replay resets the retry budget
    const deliveriesBeforeReplayPoll = received.length;

    // Next poll picks it back up and actually delivers it.
    const outcomes = await processPendingBatch(client);

    expect(outcomes).toEqual([{ id, outcome: "delivered", attempt: 1 }]);
    expect(table.get(id)!.status).toBe("delivered");
    expect(received).toHaveLength(deliveriesBeforeReplayPoll + 1);
    expect(received[received.length - 1].body).toEqual({
      event: "push",
      ref: "refs/heads/main",
    });
  });
});

// The block above proves the CLI replay path. This one proves the *other* way an
// operator reaches the same button — a browser session against the dashboard API
// — and does it through the whole chain in one test: log in, ingest, watch the
// event fail its way to dead-lettered, find it through GET /api/events, replay it
// with POST /api/events/:id/replay, and confirm the next worker poll delivers it.
// Phases 1, 2, 3, 4, 5 and the worker all participate.
describe("full pipeline through the dashboard API", () => {
  let server: http.Server | undefined;
  let received: Received[] = [];
  const originalDestination = process.env.DESTINATION_URL;

  const TEST_SECRET = "test-session-secret";
  const TEST_PASSWORD = "correct-horse-battery-staple";
  // Cost 4, not the production 12 — same reasoning as tests/auth.test.ts.
  const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

  beforeEach(() => {
    received = [];
    vi.stubEnv("SESSION_SECRET", TEST_SECRET);
    vi.stubEnv("ADMIN_PASSWORD_HASH", TEST_HASH);
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (originalDestination === undefined) {
      delete process.env.DESTINATION_URL;
    } else {
      process.env.DESTINATION_URL = originalDestination;
    }
  });

  async function startReceiver(respond: () => number): Promise<string> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        received.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
        res.writeHead(respond());
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}/receive`;
  }

  // Logs in for real (bcrypt compare + issued JWT) and returns the Set-Cookie
  // value, so the rest of the test is exercising a genuine session rather than a
  // hand-forged token.
  async function login(): Promise<string> {
    const res = await request(app).post("/api/login").send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"][0].split(";")[0];
    return cookie;
  }

  it("ingests, dead-letters, replays through POST /api/events/:id/replay, and delivers on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const COOLDOWN_MS = 5_000;
    let destinationUp = false;
    const destinationUrl = await startReceiver(() => (destinationUp ? 200 : 500));
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([], { cooldownMs: COOLDOWN_MS });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const cookie = await login();

    // Phase 2: ingest.
    const ingest = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_api_replay")
      .send({ event: "payout.failed", amount: 900 });
    expect(ingest.status).toBe(202);
    const id = ingest.body.id as string;

    // Phase 3 + 4: five failed attempts take it to dead-lettered.
    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }
    expect(table.get(id)!.status).toBe("dead_lettered");
    expect(received).toHaveLength(5);

    // Phase 5: the operator finds it in the dashboard's filtered list.
    const listed = await request(app)
      .get("/api/events?status=dead_lettered")
      .set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.events.map((e: { id: string }) => e.id)).toContain(id);
    // The projection still holds on this path: no payload/headers leak.
    expect(listed.body.events[0]).not.toHaveProperty("payload");
    expect(listed.body.events[0]).not.toHaveProperty("headers");

    // Destination comes back up; breaker cooldown elapses.
    destinationUp = true;
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1_000));

    // Phase 5: replay through the API, not the CLI.
    const replayRes = await request(app)
      .post(`/api/events/${id}/replay`)
      .set("Cookie", cookie);
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.status).toBe("replayed");
    expect(table.get(id)!.status).toBe("pending");
    expect(table.get(id)!.attempts).toBe(0);

    // Phase 3: the next poll actually redelivers it.
    const outcomes = await processPendingBatch(client);
    expect(outcomes).toEqual([{ id, outcome: "delivered", attempt: 1 }]);
    expect(table.get(id)!.status).toBe("delivered");
    expect(received).toHaveLength(6);
    expect(received[5].body).toEqual({ event: "payout.failed", amount: 900 });
  });

  it("replaying the same event twice through the API returns 409 the second time and does not redeliver twice", async () => {
    const destinationUrl = await startReceiver(() => 500);
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([], { cooldownMs: 0 });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const cookie = await login();

    const ingest = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_double_replay")
      .send({ event: "charge.failed" });
    const id = ingest.body.id as string;

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }
    expect(table.get(id)!.status).toBe("dead_lettered");

    const first = await request(app).post(`/api/events/${id}/replay`).set("Cookie", cookie);
    const second = await request(app).post(`/api/events/${id}/replay`).set("Cookie", cookie);

    expect(first.status).toBe(200);
    // Already back to pending, so it is no longer in the dead-lettered list —
    // the endpoint says so plainly instead of reporting a second success.
    expect(second.status).toBe(409);
    expect(table.get(id)!.attempts).toBe(0);
  });

  it("an unauthenticated caller cannot replay a dead-lettered event", async () => {
    const destinationUrl = await startReceiver(() => 500);
    process.env.DESTINATION_URL = destinationUrl;

    const { client, table, sources } = makeFakeSupabase([], { cooldownMs: 0 });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET);
    for (const name of ["stripe", "github"]) sources.set(name, {name, destination_url: process.env.DESTINATION_URL!, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true});
    mocks.client = client;

    const ingest = await request(app)
      .post("/webhooks/stripe")
      .set("Idempotency-Key", "evt_unauth_replay")
      .send({ event: "charge.failed" });
    const id = ingest.body.id as string;

    for (let i = 0; i < 5; i++) {
      await processPendingBatch(client);
    }

    const res = await request(app).post(`/api/events/${id}/replay`);

    expect(res.status).toBe(401);
    // The gate is real, not cosmetic: the row is untouched.
    expect(table.get(id)!.status).toBe("dead_lettered");
    expect(table.get(id)!.attempts).toBe(5);
  });
});
