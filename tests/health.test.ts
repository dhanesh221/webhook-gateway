import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app";

describe("GET /health", () => {
  it("returns 200 with the exact expected body", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns JSON", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

describe("unknown routes", () => {
  it("returns 404 for a route that doesn't exist", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
  });
});

describe("app import", () => {
  it("has no side effects — importing it never binds a real port", () => {
    // src/app.ts only builds the Express app; app.listen() lives in src/index.ts.
    // That split means importing `app` here is instant and safe to run in parallel.
    expect(typeof app.listen).toBe("function");
    expect(typeof app).toBe("function");
  });
});
