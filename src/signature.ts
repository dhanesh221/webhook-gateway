// HMAC signature verification for incoming webhooks.
//
// Without this, /webhooks/:source accepts any POST from anyone who learns the URL.
// A signature proves the request came from someone holding the shared secret, and
// that the body wasn't altered in transit.
//
// The scheme is the one Stripe and GitHub use, for a reason worth knowing: the
// timestamp is signed *together with* the body. Signing the body alone would let
// an attacker who captured one valid request replay it verbatim forever, since
// the signature stays valid indefinitely. Binding a timestamp into the signed
// string means a captured request expires.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-webhook-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

// The signed string is `${timestamp}.${rawBody}` — the raw bytes as received, not
// a re-serialised object. JSON.stringify(JSON.parse(body)) can reorder keys or
// change whitespace, which produces a different HMAC and rejects valid requests.
export function signPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
}

// Builds the full header value a sender would send.
export function buildSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string
): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}

function parseHeader(header: string): { t?: string; v1?: string } {
  const parts: { t?: string; v1?: string } = {};
  for (const segment of header.split(",")) {
    const index = segment.indexOf("=");
    if (index === -1) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key === "t") parts.t = value;
    if (key === "v1") parts.v1 = value;
  }
  return parts;
}

// Constant-time comparison. A plain === leaks information through how long the
// comparison takes: it returns on the first differing byte, so an attacker can
// discover a valid signature one byte at a time by measuring response times.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  // Malformed hex decodes to a shorter buffer; timingSafeEqual throws on a
  // length mismatch, so guard it rather than let it become a 500.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifySignature(opts: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const {
    secret,
    header,
    rawBody,
    nowSeconds = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = opts;

  if (!header) return { ok: false, reason: "missing signature header" };

  const { t, v1 } = parseHeader(header);
  if (!t || !v1) return { ok: false, reason: "malformed signature header" };

  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "malformed signature timestamp" };
  }

  // Math.abs covers both directions: an old captured request, and one dated in
  // the future by a sender with a badly skewed clock.
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "signature timestamp outside tolerance" };
  }

  const expected = signPayload(secret, timestamp, rawBody);
  if (!safeEqualHex(expected, v1)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}
