import { describe, it, expect } from "vitest";
import { TokenBuckets, limiterFromEnv } from "../src/rateLimit";

function clock(rps = 2, burst = 2) {
  let now = 0;
  const limiter = new TokenBuckets({ rps, burst }, new Map(), () => now);
  return { limiter, at: (n: number) => { now = n; } };
}

describe("token buckets", () => {
  it("spends the exact burst then denies at zero", () => {
    const { limiter } = clock();
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(500);
    expect(limiter.take("a")).toBe(500);
  });
  it("refills fractional tokens and permits exactly at the boundary", () => {
    const { limiter, at } = clock(2, 1);
    limiter.take("a"); at(499);
    expect(limiter.take("a")).toBe(1);
    at(500); expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(500);
  });
  it("caps refill after a long idle period", () => {
    const { limiter, at } = clock();
    limiter.take("a"); at(1e9);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(500);
  });
  it("does not mint tokens on a backwards clock or double-count recovery", () => {
    const { limiter, at } = clock(1, 1);
    at(1000); limiter.take("a"); at(0);
    expect(limiter.take("a")).toBe(1000);
    at(1000); expect(limiter.take("a")).toBe(1000);
    at(1500); expect(limiter.take("a")).toBe(500);
  });
  it("shares limits within a destination but isolates other destinations", () => {
    const { limiter } = clock(1, 1);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("b")).toBe(0);
    expect(limiter.take("a")).toBe(1000);
  });
  it("cannot double-spend in concurrent callers", async () => {
    const { limiter } = clock(1, 3);
    const waits = await Promise.all(Array.from({ length: 1000 }, () => Promise.resolve().then(() => limiter.take("a"))));
    expect(waits.filter(n => n === 0)).toHaveLength(3);
    expect(waits.filter(n => n > 0)).toHaveLength(997);
  });
  it("uses and snapshots exact destination overrides", () => {
    const rule = { rps: 0.5, burst: 1 };
    const overrides = new Map([["a", rule]]);
    const limiter = new TokenBuckets({ rps: 5, burst: 5 }, overrides, () => 0);
    rule.burst = 99; overrides.clear();
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(2000);
    for (let i = 0; i < 5; i++) expect(limiter.take("b")).toBe(0);
  });
  it("rejects non-finite clock values", () => {
    const limiter = new TokenBuckets({ rps: 1, burst: 1 }, new Map(), () => NaN);
    expect(() => limiter.take("a")).toThrow("clock");
  });
  it("bounds memory without recreating partially empty buckets", () => {
    const { limiter, at } = clock(1, 1);
    for (let i = 0; i < 10000; i++) expect(limiter.take(String(i))).toBe(0);
    expect(limiter.take("new")).toBe(1000);
    expect(limiter.take("0")).toBe(1000);
    at(1000); expect(limiter.take("new")).toBe(0);
  });
  it("never exceeds burst plus refill in an adversarial deterministic trace", () => {
    const { limiter, at } = clock(0.75, 3);
    let sends = 0, now = 0, seed = 17;
    for (let i = 0; i < 20000; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      now += seed % 23; at(now);
      if (limiter.take("a") === 0) sends++;
      expect(sends).toBeLessThanOrEqual(3 + now * 0.75 / 1000);
    }
  });
});

describe("rate config", () => {
  it("uses 10 rps / burst 10 by default", () => {
    const limiter = limiterFromEnv({});
    for (let i = 0; i < 10; i++) expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
  });
  it.each(["0", "-1", "NaN", "Infinity", "", "0.0001", "10001"])("rejects invalid rate %s", rps => {
    expect(() => limiterFromEnv({ WG_DELIVERY_RATE_RPS: rps })).toThrow();
  });
  it.each(["0", "0.5", "1.5", "-1", "Infinity", "10001", ""])("rejects invalid burst %s", burst => {
    expect(() => limiterFromEnv({ WG_DELIVERY_RATE_BURST: burst })).toThrow();
  });
  it.each(["not-json", "null", "[]", '{"https://a/":{"rps":0,"burst":1}}', '{"https://a/":{"rps":"1","burst":1}}', '{"bad":{"rps":1,"burst":1}}', '{"ftp://a/":{"rps":1,"burst":1}}', '{"https://u:p@a/":{"rps":1,"burst":1}}', '{"https://a/#x":{"rps":1,"burst":1}}'])("rejects invalid overrides %s", overrides => {
    expect(() => limiterFromEnv({ WG_DELIVERY_RATE_OVERRIDES: overrides })).toThrow();
  });
  it("loads a fractional-rate override", () => {
    const limiter = limiterFromEnv({ WG_DELIVERY_RATE_OVERRIDES: '{"https://a/hook":{"rps":0.5,"burst":1}}' });
    expect(limiter.take("https://a/hook")).toBe(0);
    expect(limiter.take("https://a/hook")).toBeGreaterThan(1900);
  });
});
