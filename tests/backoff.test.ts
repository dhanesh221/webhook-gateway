import { describe, it, expect } from "vitest";
import { computeBackoffDelay, BASE_DELAY_MS, MAX_DELAY_MS } from "../src/backoff";

describe("computeBackoffDelay", () => {
  it("returns 0 when random() returns 0, for any attempt", () => {
    expect(computeBackoffDelay(0, () => 0)).toBe(0);
    expect(computeBackoffDelay(4, () => 0)).toBe(0);
  });

  it("stays within [0, baseDelay * 2^attempt] before the cap kicks in", () => {
    for (const attempt of [0, 1, 2, 3]) {
      const cap = BASE_DELAY_MS * 2 ** attempt;
      const delay = computeBackoffDelay(attempt, () => 0.9999);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });

  it("grows with the attempt number", () => {
    const d0 = computeBackoffDelay(0, () => 1);
    const d1 = computeBackoffDelay(1, () => 1);
    const d2 = computeBackoffDelay(2, () => 1);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it("caps the delay at MAX_DELAY_MS for large attempt numbers", () => {
    const delay = computeBackoffDelay(20, () => 1);
    expect(delay).toBe(MAX_DELAY_MS);
  });

  it("never exceeds MAX_DELAY_MS even with an unlucky random draw", () => {
    for (const attempt of [10, 15, 30]) {
      const delay = computeBackoffDelay(attempt, () => 0.999999);
      expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });
});
