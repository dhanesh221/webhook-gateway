import { validateDestination } from "./sources";

// Content-based routing rules, read from the WG_ROUTING_RULES environment
// variable (operator-controlled JSON). Rules match on fields of the signed JSON
// body only. Headers are never matchable: they are not covered by the signature.
//
// Shape:
//   { "rules": [ { "source": "stripe",
//                  "match": { "type": "invoice.paid", "data.object.livemode": true },
//                  "destinations": ["https://a.example/hook", "https://b.example/hook"] } ] }
//
// Every predicate in a rule must hold (AND). All matching rules for a source
// contribute their destinations (union, de-duplicated, in rule order).
export const ROUTING_ENV = "WG_ROUTING_RULES";
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_RULES = 100;
export const MAX_PATH_DEPTH = 16;
export const MAX_DESTINATIONS_PER_SOURCE = 32;

export type Scalar = string | number | boolean | null;
export interface RoutingRule {
  source: string;
  match: Array<{ path: string[]; value: Scalar }>;
  destinations: string[];
}
export interface RoutingConfig { rules: RoutingRule[] }

export class RoutingConfigError extends Error {}

const SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(msg: string): never { throw new RoutingConfigError(`Invalid ${ROUTING_ENV}: ${msg}`); }

function exactKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (/^headers?$/i.test(key)) fail(`${where} may not match on headers`);
    if (!allowed.includes(key)) fail(`${where} has unknown field "${key}"`);
  }
}

function parsePath(raw: string, where: string): string[] {
  if (raw.length === 0) fail(`${where} has an empty path`);
  if (/^headers?(\.|$)/i.test(raw)) fail(`${where} may not match on headers`);
  const parts = raw.split(".");
  if (parts.length > MAX_PATH_DEPTH) fail(`${where} path is deeper than ${MAX_PATH_DEPTH}`);
  if (parts.some((p) => p.length === 0)) fail(`${where} path has an empty segment`);
  return parts;
}

// Returns null when the variable is unset or blank: no routing configured, so
// the legacy single-destination path applies unchanged. Anything else that does
// not validate throws, and callers must fail closed.
export function parseRoutingRules(raw: string | undefined): RoutingConfig | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) fail(`larger than ${MAX_CONFIG_BYTES} bytes`);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { fail("not valid JSON"); }
  if (!isPlainObject(json)) fail("must be a JSON object");
  exactKeys(json, ["rules"], "config");
  const list = json.rules;
  if (!Array.isArray(list)) fail("rules must be an array");
  if (list.length > MAX_RULES) fail(`more than ${MAX_RULES} rules`);

  const perSource = new Map<string, Set<string>>();
  const rules: RoutingRule[] = list.map((entry, i) => {
    const where = `rule ${i}`;
    if (!isPlainObject(entry)) fail(`${where} must be an object`);
    exactKeys(entry, ["source", "match", "destinations"], where);
    const { source, match, destinations } = entry;
    if (typeof source !== "string" || !SOURCE_RE.test(source)) fail(`${where} has an invalid source`);
    if (!isPlainObject(match) || Object.keys(match).length === 0) fail(`${where} needs a non-empty match object`);
    if (!Array.isArray(destinations) || destinations.length === 0) fail(`${where} needs at least one destination`);

    const predicates = Object.entries(match).map(([key, value]) => {
      const path = parsePath(key, where);
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
          !(typeof value === "number" && Number.isFinite(value))) {
        fail(`${where} predicate "${key}" must be a string, number, boolean or null`);
      }
      return { path, value: value as Scalar };
    });

    const seen = perSource.get(source) ?? new Set<string>();
    perSource.set(source, seen);
    const canonical: string[] = [];
    for (const d of destinations) {
      if (typeof d !== "string") fail(`${where} destinations must be strings`);
      let url: string;
      try { url = validateDestination(d); } catch (e) { fail(`${where} destination rejected: ${(e as Error).message}`); }
      if (!canonical.includes(url)) canonical.push(url);
      seen.add(url);
    }
    if (seen.size > MAX_DESTINATIONS_PER_SOURCE) fail(`source "${source}" has more than ${MAX_DESTINATIONS_PER_SOURCE} unique destinations`);
    return { source, match: predicates, destinations: canonical };
  });
  return { rules };
}

// Own-property traversal only: no prototype chain, no getters, no inherited keys.
function lookup(body: unknown, path: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = body;
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return { found: false };
    const desc = Object.getOwnPropertyDescriptor(cur, seg);
    if (!desc || !("value" in desc)) return { found: false };
    cur = desc.value;
  }
  return { found: true, value: cur };
}

// Exact scalar equality, no coercion ("1" does not match 1, null only matches null).
export function matchDestinations(config: RoutingConfig, source: string, body: unknown): string[] {
  const out: string[] = [];
  for (const rule of config.rules) {
    if (rule.source !== source) continue;
    const ok = rule.match.every((p) => {
      const r = lookup(body, p.path);
      return r.found && r.value === p.value;
    });
    if (!ok) continue;
    for (const d of rule.destinations) if (!out.includes(d)) out.push(d);
  }
  return out;
}

// Parsed config cached by raw text, so ingest re-validates cheaply but still
// notices a changed environment variable.
let cache: { raw: string | undefined; config: RoutingConfig | null } | undefined;
export function loadRoutingRules(): RoutingConfig | null {
  const raw = process.env[ROUTING_ENV];
  if (cache && cache.raw === raw) return cache.config;
  const config = parseRoutingRules(raw);
  cache = { raw, config };
  return config;
}
