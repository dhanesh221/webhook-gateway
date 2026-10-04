// HMAC signature verification for incoming webhooks.
//
// Without this, /webhooks/:source accepts any POST from anyone who learns the URL.
// A signature proves the request came from someone holding the shared secret, and
// that the body wasn't altered in transit.
//
// This is a custom protocol, not a native Stripe or GitHub signature adapter: the
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

// v2 also covers the Idempotency-Key. Without that, a captured signed request
// could be resent with a different key and be stored as a new event. The fields
// are newline-delimited (a header value cannot contain a newline, and the
// timestamp is digits only), with a version prefix so a v2 MAC can never be
// confused with a v1 MAC.
export function signPayloadV2(
  secret: string,
  timestampSeconds: number,
  idempotencyKey: string,
  rawBody: string
): string {
  return createHmac("sha256", secret)
    .update(`v2\n${timestampSeconds}\n${idempotencyKey}\n${rawBody}`)
    .digest("hex");
}

// Builds the full header value a sender would send.
export function buildSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
  idempotencyKey?: string | null
): string {
  if (idempotencyKey) {
    return `t=${timestampSeconds},v2=${signPayloadV2(secret, timestampSeconds, idempotencyKey, rawBody)}`;
  }
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}

function parseHeader(header: string): { t?: string; v1?: string; v2?: string } {
  const parts: { t?: string; v1?: string; v2?: string } = {};
  for (const segment of header.split(",")) {
    const index = segment.indexOf("=");
    if (index === -1) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key === "t") { if (parts.t !== undefined) return {}; parts.t = value; }
    if (key === "v1") { if (parts.v1 !== undefined) return {}; parts.v1 = value; }
    if (key === "v2") { if (parts.v2 !== undefined) return {}; parts.v2 = value; }
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
  idempotencyKey?: string | null;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const {
    secret,
    header,
    rawBody,
    idempotencyKey = null,
    nowSeconds = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = opts;

  if (!header) return { ok: false, reason: "missing signature header" };

  const { t, v1, v2 } = parseHeader(header);
  // A request carrying an Idempotency-Key must use v2, so the key is signed.
  // v1 is accepted only for requests with no key.
  const mac = idempotencyKey ? v2 : (v2 ?? v1);
  if (!t || !mac) return { ok: false, reason: "malformed signature header" };

  const timestamp = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "malformed signature timestamp" };
  }

  // Math.abs covers both directions: an old captured request, and one dated in
  // the future by a sender with a badly skewed clock.
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "signature timestamp outside tolerance" };
  }

  const useV2 = idempotencyKey ? true : v2 !== undefined;
  const expected = useV2
    ? signPayloadV2(secret, timestamp, idempotencyKey ?? "", rawBody)
    : signPayload(secret, timestamp, rawBody);
  if (!/^[0-9a-fA-F]{64}$/.test(mac) || !safeEqualHex(expected, mac)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}
