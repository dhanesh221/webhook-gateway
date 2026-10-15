import { describe, it, expect } from "vitest";
import {
  parseRoutingRules, matchDestinations, RoutingConfigError,
  MAX_CONFIG_BYTES, MAX_RULES, MAX_PATH_DEPTH, MAX_DESTINATIONS_PER_SOURCE,
} from "../src/routing";

const rule = (over: Record<string, unknown> = {}) => ({
  source: "stripe", match: { type: "invoice.paid" }, destinations: ["https://a.example/hook"], ...over,
});
const cfg = (rules: unknown[]) => JSON.stringify({ rules });
const parse = (rules: unknown[]) => parseRoutingRules(cfg(rules))!;

describe("parseRoutingRules", () => {
  it("returns null when unset or blank (legacy path)", () => {
    expect(parseRoutingRules(undefined)).toBeNull();
    expect(parseRoutingRules("")).toBeNull();
    expect(parseRoutingRules("   ")).toBeNull();
  });

  it("parses a valid rule", () => {
    const c = parse([rule()]);
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].match[0]).toEqual({ path: ["type"], value: "invoice.paid" });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
    ["unknown top-level field", '{"rules":[],"extra":1}'],
    ["rules not an array", '{"rules":{}}'],
  ])("rejects %s", (_n, raw) => {
    expect(() => parseRoutingRules(raw)).toThrow(RoutingConfigError);
  });

  it("rejects configs over 64KB", () => {
    const big = JSON.stringify({ rules: [], pad: "x".repeat(MAX_CONFIG_BYTES) });
    expect(() => parseRoutingRules(big)).toThrow(/larger than/);
  });

  it("allows exactly 100 rules and rejects 101", () => {
    expect(parse(Array.from({ length: MAX_RULES }, () => rule()))).toBeTruthy();
    expect(() => parse(Array.from({ length: MAX_RULES + 1 }, () => rule()))).toThrow(/more than 100 rules/);
  });

  it("limits path depth to 16", () => {
    const ok = Array(MAX_PATH_DEPTH).fill("a").join(".");
    const bad = Array(MAX_PATH_DEPTH + 1).fill("a").join(".");
    expect(parse([rule({ match: { [ok]: 1 } })])).toBeTruthy();
    expect(() => parse([rule({ match: { [bad]: 1 } })])).toThrow(/deeper/);
  });

  it("limits unique destinations per source to 32, counting across rules", () => {
    const dests = (n: number, off = 0) => Array.from({ length: n }, (_, i) => `https://h${i + off}.example/x`);
    expect(parse([rule({ destinations: dests(MAX_DESTINATIONS_PER_SOURCE) })])).toBeTruthy();
    expect(() => parse([rule({ destinations: dests(32) }), rule({ destinations: dests(1, 100) })])).toThrow(/more than 32/);
    // another source has its own budget
    expect(parse([rule({ destinations: dests(32) }), rule({ source: "github", destinations: dests(32, 100) })])).toBeTruthy();
  });

  it("canonicalizes and dedupes destination URLs", () => {
    const c = parse([rule({ destinations: ["https://A.example", "https://a.example/", "https://a.example:443/"] })]);
    expect(c.rules[0].destinations).toEqual(["https://a.example/"]);
  });

  it("dedupe does not count toward the unique limit", () => {
    const same = Array.from({ length: 40 }, () => "https://a.example/x");
    expect(parse([rule({ destinations: same })]).rules[0].destinations).toHaveLength(1);
  });

  it.each([
    ["http non-loopback", "http://a.example/x"],
    ["credentials", "https://u:p@a.example/x"],
    ["fragment", "https://a.example/x#f"],
    ["not a URL", "nope"],
  ])("rejects destination: %s", (_n, d) => {
    expect(() => parse([rule({ destinations: [d] })])).toThrow(RoutingConfigError);
  });

  it("rejects header predicates in any form", () => {
    expect(() => parse([rule({ headers: { a: "b" } })])).toThrow(/headers/);
    expect(() => parse([rule({ header: { a: "b" } })])).toThrow(/headers/);
    expect(() => parse([rule({ match: { "headers.x-event": "a" } })])).toThrow(/headers/);
    expect(() => parse([rule({ match: { header: "a" } })])).toThrow(/headers/);
  });

  it.each([
    ["unknown rule field", { extra: 1 }],
    ["bad source", { source: "a/b" }],
    ["empty match", { match: {} }],
    ["array match", { match: [] }],
    ["object predicate value", { match: { a: { b: 1 } } }],
    ["array predicate value", { match: { a: [1] } }],
    ["empty destinations", { destinations: [] }],
    ["non-string destination", { destinations: [5] }],
    ["empty path segment", { match: { "a..b": 1 } }],
    ["empty path", { match: { "": 1 } }],
  ])("rejects %s", (_n, over) => {
    expect(() => parse([rule(over)])).toThrow(RoutingConfigError);
  });

  it("rejects non-object rules", () => {
    expect(() => parse(["x"])).toThrow(RoutingConfigError);
    expect(() => parse([null])).toThrow(RoutingConfigError);
  });

  it("accepts null, boolean and number predicates", () => {
    expect(parse([rule({ match: { a: null, b: true, c: 1.5 } })]).rules[0].match).toHaveLength(3);
  });
});

describe("matchDestinations", () => {
  const A = "https://a.example/hook";
  const B = "https://b.example/hook";
  const config = parse([
    rule({ match: { type: "invoice.paid", "data.livemode": true }, destinations: [A] }),
    rule({ match: { type: "invoice.paid" }, destinations: [B, A] }),
    rule({ source: "github", match: { type: "invoice.paid" }, destinations: ["https://g.example/x"] }),
  ]);

  it("unions destinations of all matching rules, in order, deduped", () => {
    expect(matchDestinations(config, "stripe", { type: "invoice.paid", data: { livemode: true } }))
      .toEqual([A, "https://b.example/hook"]);
  });

  it("requires every predicate", () => {
    expect(matchDestinations(config, "stripe", { type: "invoice.paid", data: { livemode: false } })).toEqual([B, A]);
  });

  it("returns nothing when no rule matches or source differs", () => {
    expect(matchDestinations(config, "stripe", { type: "other" })).toEqual([]);
    expect(matchDestinations(config, "unknown", { type: "invoice.paid" })).toEqual([]);
  });

  it("uses exact equality without coercion", () => {
    const c = parse([rule({ match: { n: 1 } }), rule({ match: { z: null }, destinations: [B] })]);
    expect(matchDestinations(c, "stripe", { n: "1" })).toEqual([]);
    expect(matchDestinations(c, "stripe", { n: true })).toEqual([]);
    expect(matchDestinations(c, "stripe", { n: 1 })).toEqual([A]);
    expect(matchDestinations(c, "stripe", { z: 0 })).toEqual([]);
    expect(matchDestinations(c, "stripe", { z: "" })).toEqual([]);
    expect(matchDestinations(c, "stripe", {})).toEqual([]);
    expect(matchDestinations(c, "stripe", { z: null })).toEqual([B]);
  });

  it("does not match objects or arrays against scalars", () => {
    const c = parse([rule({ match: { n: "1" } })]);
    expect(matchDestinations(c, "stripe", { n: ["1"] })).toEqual([]);
  });

  it("traverses own properties only", () => {
    const c = parse([rule({ match: { "constructor.name": "Object" } }), rule({ match: { "a.toString": "x" }, destinations: [B] })]);
    expect(matchDestinations(c, "stripe", {})).toEqual([]);
    expect(matchDestinations(c, "stripe", { a: {} })).toEqual([]);
  });

  it("ignores inherited keys and getters", () => {
    const c = parse([rule({ match: { inherited: "yes" } }), rule({ match: { g: "yes" }, destinations: [B] })]);
    const proto = { inherited: "yes" };
    expect(matchDestinations(c, "stripe", Object.create(proto))).toEqual([]);
    const withGetter = Object.defineProperty({}, "g", { get: () => "yes", enumerable: true });
    expect(matchDestinations(c, "stripe", withGetter)).toEqual([]);
  });

  it("treats a __proto__ path as an ordinary own key", () => {
    const c = parse([rule({ match: { "__proto__.x": 1 } })]);
    expect(matchDestinations(c, "stripe", { x: 1 })).toEqual([]);
    expect(matchDestinations(c, "stripe", JSON.parse('{"__proto__":{"x":1}}'))).toEqual([A]);
  });

  it("reads array elements by index and stops at non-objects", () => {
    const c = parse([rule({ match: { "items.1.id": "b" } }), rule({ match: { "a.b": 1 }, destinations: [B] })]);
    expect(matchDestinations(c, "stripe", { items: [{ id: "a" }, { id: "b" }] })).toEqual([A]);
    expect(matchDestinations(c, "stripe", { a: "str" })).toEqual([]);
    expect(matchDestinations(c, "stripe", { a: null })).toEqual([]);
  });

  it("has no state between calls", () => {
    const body = { type: "invoice.paid" };
    expect(matchDestinations(config, "stripe", body)).toEqual(matchDestinations(config, "stripe", body));
  });
});
