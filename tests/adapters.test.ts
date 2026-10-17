import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeFakeSupabase } from "./fakeSupabase";
import {
  verifyIngest, buildGithubSignatureHeader, buildStripeSignatureHeader,
  GITHUB_SIGNATURE_HEADER, GITHUB_DELIVERY_HEADER, STRIPE_SIGNATURE_HEADER,
} from "../src/adapters";
import { buildSignatureHeader, SIGNATURE_HEADER } from "../src/signature";
import { saveSource, sourceScheme } from "../src/sources";
import { buildProgram, realDeps } from "../src/cli";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";

const SECRET = "github-or-stripe-secret-with-at-least-32-bytes";
const OTHER = "a-different-secret-that-is-also-32-bytes-long";
const body = '{"id":"evt_123","type":"payment_intent.succeeded","n":1}';
const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];
const now = 1_700_000_000;

describe("GitHub adapter", () => {
  const good = { scheme: "github" as const, secret: SECRET, rawBody: body, payload: JSON.parse(body) };

  it("accepts sha256=<hmac of body> and dedupes on X-GitHub-Delivery", () => {
    const r = verifyIngest({ ...good, header: headers({
      [GITHUB_SIGNATURE_HEADER]: buildGithubSignatureHeader(SECRET, body),
      [GITHUB_DELIVERY_HEADER]: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    }) });
    expect(r).toEqual({ ok: true, idempotencyKey: "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
  });

  it("falls back to Idempotency-Key, then to no key", () => {
    const sig = buildGithubSignatureHeader(SECRET, body);
    expect(verifyIngest({ ...good, header: headers({ [GITHUB_SIGNATURE_HEADER]: sig, "idempotency-key": "k" }) }))
      .toEqual({ ok: true, idempotencyKey: "k" });
    expect(verifyIngest({ ...good, header: headers({ [GITHUB_SIGNATURE_HEADER]: sig }) }))
      .toEqual({ ok: true, idempotencyKey: null });
  });

  it.each([
    ["missing header", {}],
    ["wrong prefix", { [GITHUB_SIGNATURE_HEADER]: "sha1=" + "a".repeat(40) }],
    ["wrong secret", { [GITHUB_SIGNATURE_HEADER]: buildGithubSignatureHeader(OTHER, body) }],
    ["tampered body", { [GITHUB_SIGNATURE_HEADER]: buildGithubSignatureHeader(SECRET, body.replace('"n":1', '"n":2')) }],
    ["short mac", { [GITHUB_SIGNATURE_HEADER]: "sha256=abcd" }],
    ["non-hex mac", { [GITHUB_SIGNATURE_HEADER]: "sha256=" + "z".repeat(64) }],
    ["gateway header instead", { [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, now, body) }],
  ])("rejects %s", (_label, h) => {
    expect(verifyIngest({ ...good, header: headers(h as Record<string, string>) }).ok).toBe(false);
  });
});

describe("Stripe adapter", () => {
  const good = { scheme: "stripe" as const, secret: SECRET, rawBody: body, payload: JSON.parse(body), nowSeconds: now };

  it("accepts t=,v1= over 't.body' and dedupes on the event id", () => {
    const r = verifyIngest({ ...good, header: headers({ [STRIPE_SIGNATURE_HEADER]: buildStripeSignatureHeader(SECRET, now, body) }) });
    expect(r).toEqual({ ok: true, idempotencyKey: "evt_123" });
  });

  it("accepts any one of several v1 values (secret rotation)", () => {
    const valid = buildStripeSignatureHeader(SECRET, now, body).split(",v1=")[1];
    const h = `t=${now},v1=${"0".repeat(64)},v1=${valid}`;
    expect(verifyIngest({ ...good, header: headers({ [STRIPE_SIGNATURE_HEADER]: h }) }).ok).toBe(true);
  });

  it("uses Idempotency-Key when the body has no string id", () => {
    const raw = '{"object":"event"}';
    const h = buildStripeSignatureHeader(SECRET, now, raw);
    expect(verifyIngest({ ...good, rawBody: raw, payload: JSON.parse(raw), header: headers({ [STRIPE_SIGNATURE_HEADER]: h, "idempotency-key": "k" }) }))
      .toEqual({ ok: true, idempotencyKey: "k" });
    expect(verifyIngest({ ...good, rawBody: raw, payload: JSON.parse(raw), header: headers({ [STRIPE_SIGNATURE_HEADER]: h }) }))
      .toEqual({ ok: true, idempotencyKey: null });
  });

  it.each([
    ["missing header", {}],
    ["no v1", { [STRIPE_SIGNATURE_HEADER]: `t=${now}` }],
    ["no t", { [STRIPE_SIGNATURE_HEADER]: `v1=${"a".repeat(64)}` }],
    ["duplicate t", { [STRIPE_SIGNATURE_HEADER]: `t=${now},t=${now},v1=${"a".repeat(64)}` }],
    ["non-numeric t", { [STRIPE_SIGNATURE_HEADER]: `t=abc,v1=${"a".repeat(64)}` }],
    ["wrong secret", { [STRIPE_SIGNATURE_HEADER]: buildStripeSignatureHeader(OTHER, now, body) }],
    ["tampered body", { [STRIPE_SIGNATURE_HEADER]: buildStripeSignatureHeader(SECRET, now, body + " ") }],
    ["stale timestamp", { [STRIPE_SIGNATURE_HEADER]: buildStripeSignatureHeader(SECRET, now - 301, body) }],
    ["future timestamp", { [STRIPE_SIGNATURE_HEADER]: buildStripeSignatureHeader(SECRET, now + 301, body) }],
    ["gateway header instead", { [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, now, body) }],
  ])("rejects %s", (_label, h) => {
    expect(verifyIngest({ ...good, header: headers(h as Record<string, string>) }).ok).toBe(false);
  });

  it("rejects a timestamp signed with a different one", () => {
    const sig = buildStripeSignatureHeader(SECRET, now, body).split(",v1=")[1];
    expect(verifyIngest({ ...good, header: headers({ [STRIPE_SIGNATURE_HEADER]: `t=${now - 10},v1=${sig}` }) }).ok).toBe(false);
  });
});

describe("gateway scheme through the adapter", () => {
  it("still requires v2 when an Idempotency-Key is present", () => {
    const h = headers({ [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, now, body), "idempotency-key": "k" });
    expect(verifyIngest({ scheme: "gateway", secret: SECRET, rawBody: body, payload: {}, header: h, nowSeconds: now }).ok).toBe(false);
    const h2 = headers({ [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, now, body, "k"), "idempotency-key": "k" });
    expect(verifyIngest({ scheme: "gateway", secret: SECRET, rawBody: body, payload: {}, header: h2, nowSeconds: now }))
      .toEqual({ ok: true, idempotencyKey: "k" });
  });
});

describe("sourceScheme", () => {
  const base = { name: "s", destination_url: "https://x.invalid/", secret_env: "WG_SOURCE_S_SECRET", enabled: true };
  it("defaults rows without a scheme (pre-011) to gateway", () => {
    expect(sourceScheme(base)).toBe("gateway");
    expect(sourceScheme({ ...base, signature_scheme: null })).toBe("gateway");
  });
  it("rejects unknown schemes rather than weakening the check", () => {
    expect(() => sourceScheme({ ...base, signature_scheme: "none" })).toThrow();
  });
});

describe("ingest with provider schemes", () => {
  let fake: ReturnType<typeof makeFakeSupabase>;
  beforeEach(() => {
    fake = makeFakeSupabase([]); holder.client = fake.client;
    vi.stubEnv("WG_SOURCE_GH_SECRET", SECRET);
    vi.stubEnv("WG_SOURCE_STRIPE_SECRET", SECRET);
    vi.stubEnv("WG_SOURCE_PLAIN_SECRET", SECRET);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const post = (source: string, h: Record<string, string>, raw = body) => {
    const r = request(app).post(`/webhooks/${source}`).set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(h)) r.set(k, v);
    return r.send(raw);
  };

  it("accepts a GitHub-signed delivery, dedupes a redelivery, and drops the signature from stored headers", async () => {
    await saveSource("gh", "https://gh.example/hook", "WG_SOURCE_GH_SECRET", "github");
    const h = { "X-Hub-Signature-256": buildGithubSignatureHeader(SECRET, body), "X-GitHub-Delivery": "d-1", "X-GitHub-Event": "push" };
    const first = await post("gh", h);
    expect(first.status).toBe(202);
    const row = fake.table.get(first.body.id)!;
    expect(row.idempotency_key).toBe("d-1");
    expect(row.headers).toHaveProperty("x-github-event", "push");
    expect(row.headers).not.toHaveProperty("x-hub-signature-256");
    expect((await post("gh", h)).status).toBe(200); // GitHub redelivery, same delivery id
    expect((await post("gh", { ...h, "X-GitHub-Delivery": "d-2" })).status).toBe(202); // a new delivery
    expect(fake.table.size).toBe(2);
  });

  it("accepts a Stripe-signed event and dedupes on the event id", async () => {
    await saveSource("stripe", "https://s.example/hook", "WG_SOURCE_STRIPE_SECRET", "stripe");
    const ts = Math.floor(Date.now() / 1000);
    const h = { "Stripe-Signature": buildStripeSignatureHeader(SECRET, ts, body) };
    const first = await post("stripe", h);
    expect(first.status).toBe(202);
    expect(fake.table.get(first.body.id)!.idempotency_key).toBe("evt_123");
    expect((await post("stripe", h)).status).toBe(200);
    expect((await post("stripe", { "Stripe-Signature": buildStripeSignatureHeader(SECRET, ts - 400, body) })).status).toBe(401);
  });

  it("does not accept a provider header on a gateway source, nor a gateway header on a provider source", async () => {
    await saveSource("plain", "https://p.example/hook", "WG_SOURCE_PLAIN_SECRET");
    await saveSource("gh", "https://gh.example/hook", "WG_SOURCE_GH_SECRET", "github");
    expect((await post("plain", { "X-Hub-Signature-256": buildGithubSignatureHeader(SECRET, body) })).status).toBe(401);
    expect((await post("gh", { [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, Math.floor(Date.now() / 1000), body) })).status).toBe(401);
    expect(fake.table.size).toBe(0);
  });

  it("answers 503 for a source whose stored scheme is unknown", async () => {
    await saveSource("gh", "https://gh.example/hook", "WG_SOURCE_GH_SECRET", "github");
    fake.sources.get("gh")!.signature_scheme = "none";
    expect((await post("gh", { "X-Hub-Signature-256": buildGithubSignatureHeader(SECRET, body) })).status).toBe(503);
  });

  it("CLI registers a scheme and lists it, and refuses an unknown one", async () => {
    const log = vi.fn();
    await buildProgram({ ...realDeps, log }).parseAsync(["node", "gateway", "sources", "set", "gh", "https://gh.example/hook", "WG_SOURCE_GH_SECRET", "--scheme", "github"]);
    expect(fake.sources.get("gh")!.signature_scheme).toBe("github");
    await buildProgram({ ...realDeps, log }).parseAsync(["node", "gateway", "sources", "list"]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/^gh enabled github https:\/\/gh\.example\/hook WG_SOURCE_GH_SECRET$/m);
    await expect(saveSource("x", "https://x.example/", "WG_SOURCE_GH_SECRET", "paypal")).rejects.toThrow(/Invalid signature scheme/);
  });
});
