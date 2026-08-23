import { describe, it, expect } from "vitest";
import {
  verifySignature,
  signPayload,
  buildSignatureHeader,
  DEFAULT_TOLERANCE_SECONDS,
} from "../src/signature";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ event: "payment.succeeded", amount: 500 });
const NOW = 1_800_000_000;

function verify(header: string | undefined, rawBody = BODY, nowSeconds = NOW) {
  return verifySignature({ secret: SECRET, header, rawBody, nowSeconds });
}

describe("signPayload", () => {
  it("is deterministic for the same inputs", () => {
    expect(signPayload(SECRET, NOW, BODY)).toBe(signPayload(SECRET, NOW, BODY));
  });

  it("changes when the body changes", () => {
    expect(signPayload(SECRET, NOW, BODY)).not.toBe(
      signPayload(SECRET, NOW, BODY + " ")
    );
  });

  it("changes when the timestamp changes", () => {
    // This is what makes a captured request expire rather than stay valid forever.
    expect(signPayload(SECRET, NOW, BODY)).not.toBe(
      signPayload(SECRET, NOW + 1, BODY)
    );
  });

  it("changes when the secret changes", () => {
    expect(signPayload(SECRET, NOW, BODY)).not.toBe(
      signPayload("other-secret", NOW, BODY)
    );
  });
});

describe("verifySignature", () => {
  it("accepts a correctly signed payload", () => {
    expect(verify(buildSignatureHeader(SECRET, NOW, BODY))).toEqual({ ok: true });
  });

  it("rejects a missing header", () => {
    expect(verify(undefined)).toEqual({
      ok: false,
      reason: "missing signature header",
    });
  });

  it.each([
    ["no key=value pairs", "garbage"],
    ["timestamp only", "t=1800000000"],
    ["signature only", "v1=abc123"],
    ["empty string", ""],
  ])("rejects a malformed header (%s)", (_label, header) => {
    const result = verify(header);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verify(`t=not-a-number,v1=${signPayload(SECRET, NOW, BODY)}`)).toEqual({
      ok: false,
      reason: "malformed signature timestamp",
    });
  });

  it("rejects a body altered after signing", () => {
    const header = buildSignatureHeader(SECRET, NOW, BODY);
    const tampered = JSON.stringify({ event: "payment.succeeded", amount: 999999 });

    expect(verify(header, tampered)).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verify(buildSignatureHeader("wrong", NOW, BODY))).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("accepts a timestamp just inside the tolerance window", () => {
    const t = NOW - (DEFAULT_TOLERANCE_SECONDS - 1);
    expect(verify(buildSignatureHeader(SECRET, t, BODY))).toEqual({ ok: true });
  });

  it("rejects a timestamp just outside the tolerance window", () => {
    const t = NOW - (DEFAULT_TOLERANCE_SECONDS + 1);
    expect(verify(buildSignatureHeader(SECRET, t, BODY))).toEqual({
      ok: false,
      reason: "signature timestamp outside tolerance",
    });
  });

  it("rejects a timestamp too far in the future", () => {
    // A badly skewed sender clock, or an attacker post-dating a capture.
    const t = NOW + (DEFAULT_TOLERANCE_SECONDS + 1);
    expect(verify(buildSignatureHeader(SECRET, t, BODY))).toEqual({
      ok: false,
      reason: "signature timestamp outside tolerance",
    });
  });

  it("rejects non-hex and wrong-length signatures without throwing", () => {
    // timingSafeEqual throws on a length mismatch; these must return a clean
    // false rather than becoming a 500.
    for (const v1 of ["zzzz", "abc", "", "a".repeat(63), "a".repeat(65)]) {
      expect(() => verify(`t=${NOW},v1=${v1}`)).not.toThrow();
      expect(verify(`t=${NOW},v1=${v1}`).ok).toBe(false);
    }
  });

  it("rejects an empty signature that would otherwise compare equal", () => {
    expect(verify(`t=${NOW},v1=`).ok).toBe(false);
  });
});
