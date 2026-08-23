import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import express from "express";
import cookieParser from "cookie-parser";
import { SESSION_COOKIE, requireAuth } from "../src/auth";

// Nothing in these tests touches Supabase — but importing app.ts pulls in the
// dashboard router, which imports supabase.ts. Stub it so no client is built.
vi.mock("../src/supabase", () => ({
  getSupabase: () => {
    throw new Error("getSupabase should not be called in auth tests");
  },
}));

import { app } from "../src/app";

const TEST_SECRET = "test-session-secret";
const TEST_PASSWORD = "correct-horse-battery-staple";

// Cost 4 rather than the production 12: these tests hash and compare on every
// run, and the cost factor is what makes bcrypt slow on purpose.
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("ADMIN_PASSWORD_HASH", TEST_HASH);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAuth middleware", () => {
  // A tiny app rather than the real one, so the middleware is tested in
  // isolation from what any particular route happens to do.
  const guarded = express();
  guarded.use(cookieParser());
  guarded.get("/guarded", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  it("rejects a request with no cookie at all", async () => {
    const res = await request(guarded).get("/guarded");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "admin" }, "not-the-real-secret", {
      expiresIn: 3600,
    });

    const res = await request(guarded)
      .get("/guarded")
      .set("Cookie", cookieHeader(forged));

    expect(res.status).toBe(401);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const valid = jwt.sign({ sub: "admin" }, TEST_SECRET, { expiresIn: 3600 });
    const [header, , signature] = valid.split(".");
    const swappedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");

    const res = await request(guarded)
      .get("/guarded")
      .set("Cookie", cookieHeader(`${header}.${swappedPayload}.${signature}`));

    // The signature no longer matches the payload it's supposed to cover.
    expect(res.status).toBe(401);
  });

  it("rejects a validly-signed but expired token", async () => {
    const expired = jwt.sign({ sub: "admin" }, TEST_SECRET, { expiresIn: -60 });

    const res = await request(guarded)
      .get("/guarded")
      .set("Cookie", cookieHeader(expired));

    expect(res.status).toBe(401);
  });

  it("rejects a cookie that isn't a JWT at all", async () => {
    const res = await request(guarded)
      .get("/guarded")
      .set("Cookie", cookieHeader("not-a-jwt"));

    expect(res.status).toBe(401);
  });

  it("accepts a validly-signed, unexpired token", async () => {
    const good = jwt.sign({ sub: "admin" }, TEST_SECRET, { expiresIn: 3600 });

    const res = await request(guarded)
      .get("/guarded")
      .set("Cookie", cookieHeader(good));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("POST /api/login", () => {
  it("rejects a wrong password with 401 and a generic message", async () => {
    const res = await request(app)
      .post("/api/login")
      .send({ password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("gives a near-miss password the exact same answer as a wildly wrong one", async () => {
    // The message must not hint that the guess was close — that's a free
    // oracle for anyone brute-forcing.
    const nearMiss = await request(app)
      .post("/api/login")
      .send({ password: `${TEST_PASSWORD}x` });
    const wayOff = await request(app).post("/api/login").send({ password: "a" });

    expect(nearMiss.status).toBe(wayOff.status);
    expect(nearMiss.body).toEqual(wayOff.body);
  });

  it("rejects a missing or non-string password the same way", async () => {
    const missing = await request(app).post("/api/login").send({});
    const wrongType = await request(app)
      .post("/api/login")
      .send({ password: { toString: "nope" } });

    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: "Invalid credentials" });
    expect(wrongType.status).toBe(401);
    expect(wrongType.body).toEqual({ error: "Invalid credentials" });
  });

  it("accepts the right password and sets an httpOnly session cookie", async () => {
    const res = await request(app)
      .post("/api/login")
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const session = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));

    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
  });

  it("issues a cookie that the auth middleware then accepts", async () => {
    // End-to-end on the credential itself: the token login hands out is a token
    // requireAuth will honour. A signing/verifying mismatch would pass every
    // test above and still lock every real user out.
    const login = await request(app)
      .post("/api/login")
      .send({ password: TEST_PASSWORD });

    const setCookie = login.headers["set-cookie"] as unknown as string[];

    // A deliberately invalid status: the handler rejects it with a 400 during
    // validation, before any database call. So a 400 (rather than a 401) proves
    // the cookie got past requireAuth, without this test needing Supabase.
    const res = await request(app)
      .get("/api/events?status=definitely-not-a-status")
      .set("Cookie", setCookie);

    expect(res.status).toBe(400);
  });

  it("never reveals the password hash in any response", async () => {
    const res = await request(app).post("/api/login").send({ password: "nope" });

    expect(JSON.stringify(res.body)).not.toContain(TEST_HASH);
    expect(JSON.stringify(res.body)).not.toContain("$2");
  });
});

describe("POST /api/logout", () => {
  it("clears the session cookie", async () => {
    const res = await request(app).post("/api/logout");

    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const cleared = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));

    expect(cleared).toBeDefined();
    // Express clears by setting an empty value with an expiry in the past.
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it("works without a session, rather than 401-ing", async () => {
    // Logging out of an already-expired session should not be an error — the
    // browser is trying to reach the state we want it in anyway.
    const res = await request(app).post("/api/logout");
    expect(res.status).toBe(200);
  });
});

describe("GET /", () => {
  it("sends an unauthenticated browser to the login page", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
  });

  it("sends an authenticated browser to the dashboard", async () => {
    const good = jwt.sign({ sub: "admin" }, TEST_SECRET, { expiresIn: 3600 });

    const res = await request(app).get("/").set("Cookie", cookieHeader(good));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard.html");
  });
});

describe("static dashboard files", () => {
  it("serves the login page unauthenticated", async () => {
    const res = await request(app).get("/login.html");

    expect(res.status).toBe(200);
    expect(res.text).toContain("/api/login");
  });

  it("serves the dashboard HTML unauthenticated (the data behind it is what's gated)", async () => {
    const res = await request(app).get("/dashboard.html");

    expect(res.status).toBe(200);
    expect(res.text).toContain("/api/events");
  });
});

describe("pre-existing routes still work with auth in place", () => {
  it("leaves /health public", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
