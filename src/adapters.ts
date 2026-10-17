// Provider-native signature adapters.
//
// A source declares a signature_scheme (migration 011). Ingest verifies the
// request the way that provider signs it and derives the idempotency key from
// where that provider puts a stable delivery id, so a redelivery is answered
// 200 "duplicate" without the sender having to know about Idempotency-Key.
//
// Each adapter verifies over the raw bytes received, compares in constant time,
// and never reveals which part failed to the caller (the reason is logged only).
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifySignature, SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS } from "./signature";

export const SIGNATURE_SCHEMES = ["gateway", "github", "stripe"] as const;
export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];
export const DEFAULT_SIGNATURE_SCHEME: SignatureScheme = "gateway";

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

// Authentication material that must not be retained in stored event headers.
export const AUTH_HEADERS = [
  SIGNATURE_HEADER, GITHUB_SIGNATURE_HEADER, "x-hub-signature", STRIPE_SIGNATURE_HEADER,
  "authorization", "cookie",
];

export function isSignatureScheme(value: unknown): value is SignatureScheme {
  return typeof value === "string" && (SIGNATURE_SCHEMES as readonly string[]).includes(value);
}

export type IngestAuthResult =
  | { ok: true; idempotencyKey: string | null }
  | { ok: false; reason: string };

export interface IngestAuthInput {
  scheme: SignatureScheme;
  secret: string;
  // Lower-case header lookup, as Express's req.header provides.
  header: (name: string) => string | undefined;
  rawBody: string;
  // Parsed JSON body; only Stripe reads it (for the event id).
  payload: unknown;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b) || a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

// Dedup key precedence: the provider's stable id, then an explicit
// Idempotency-Key header, then none (every request is a separate event).
function fallbackKey(header: IngestAuthInput["header"]): string | null {
  return header("idempotency-key") || null;
}

// GitHub: X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>. There is no
// timestamp in GitHub's scheme, so a captured request stays valid; the delivery
// GUID (not itself signed) dedupes an honest redelivery, nothing more.
function verifyGithub(input: IngestAuthInput): IngestAuthResult {
  const header = input.header(GITHUB_SIGNATURE_HEADER);
  if (!header) return { ok: false, reason: "missing X-Hub-Signature-256" };
  if (!header.startsWith("sha256=")) return { ok: false, reason: "malformed X-Hub-Signature-256" };
  const mac = header.slice("sha256=".length).trim();
  if (mac.length !== 64 || !safeEqualHex(hmacHex(input.secret, input.rawBody), mac)) {
    return { ok: false, reason: "GitHub signature mismatch" };
  }
  return { ok: true, idempotencyKey: input.header(GITHUB_DELIVERY_HEADER) || fallbackKey(input.header) };
}

// Stripe: Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...] where each v1
// is HMAC-SHA256 over "<t>.<body>". Several v1 values appear during secret
// rotation; any one matching is enough. Tolerance mirrors Stripe's own default.
function verifyStripe(input: IngestAuthInput): IngestAuthResult {
  const header = input.header(STRIPE_SIGNATURE_HEADER);
  if (!header) return { ok: false, reason: "missing Stripe-Signature" };

  let t: string | undefined;
  const v1s: string[] = [];
  for (const segment of header.split(",")) {
    const i = segment.indexOf("=");
    if (i === -1) continue;
    const key = segment.slice(0, i).trim();
    const value = segment.slice(i + 1).trim();
    if (key === "t") {
      if (t !== undefined) return { ok: false, reason: "malformed Stripe-Signature" };
      t = value;
    } else if (key === "v1") {
      v1s.push(value);
    }
  }
  if (!t || v1s.length === 0) return { ok: false, reason: "malformed Stripe-Signature" };
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
    return { ok: false, reason: "malformed Stripe-Signature timestamp" };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(t)) > tolerance) {
    return { ok: false, reason: "Stripe-Signature timestamp outside tolerance" };
  }
  const expected = hmacHex(input.secret, `${t}.${input.rawBody}`);
  // Check every candidate so timing does not reveal which position matched.
  let matched = false;
  for (const v1 of v1s) if (safeEqualHex(expected, v1)) matched = true;
  if (!matched) return { ok: false, reason: "Stripe signature mismatch" };

  const id = (input.payload as { id?: unknown } | null)?.id;
  return { ok: true, idempotencyKey: typeof id === "string" && id.length > 0 ? id : fallbackKey(input.header) };
}

function verifyGateway(input: IngestAuthInput): IngestAuthResult {
  const idempotencyKey = fallbackKey(input.header);
  const result = verifySignature({
    secret: input.secret,
    header: input.header(SIGNATURE_HEADER),
    rawBody: input.rawBody,
    idempotencyKey,
    nowSeconds: input.nowSeconds,
    toleranceSeconds: input.toleranceSeconds,
  });
  return result.ok ? { ok: true, idempotencyKey } : result;
}

export function verifyIngest(input: IngestAuthInput): IngestAuthResult {
  switch (input.scheme) {
    case "github": return verifyGithub(input);
    case "stripe": return verifyStripe(input);
    case "gateway": return verifyGateway(input);
  }
}

// Test and tooling helpers: build the header a real sender would send.
export function buildGithubSignatureHeader(secret: string, rawBody: string): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}
export function buildStripeSignatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${hmacHex(secret, `${timestampSeconds}.${rawBody}`)}`;
}
