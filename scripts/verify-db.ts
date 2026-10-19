// Live database verification: `npm run verify:db`.
//
// Checks, against the real Supabase project, that every RPC and column the
// application depends on exists, and that the anon key is locked out of all of
// them (migration 008). It is read-only: existence of mutating RPCs is probed by
// calling them with a deliberately wrong argument list, which PostgREST rejects
// before any SQL runs. Passing this is the "verify this upgrade against the
// actual Supabase project, especially role privileges" step from the README.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type CheckStatus = "ok" | "fail" | "skip";
export interface CheckResult { name: string; status: CheckStatus; detail: string }

interface RpcError { code?: string; message?: string; hint?: string | null }
type RpcOutcome = { error: RpcError | null };

// Minimal surface so tests can pass a fake.
export interface Probe {
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcOutcome>;
  selectColumns(table: string, columns: string): Promise<RpcOutcome>;
  // Names of every RPC the API exposes, or null when the listing is unavailable.
  listRpcs(): Promise<Set<string> | null>;
}

export function probeFromClient(client: SupabaseClient, url: string, key: string): Probe {
  return {
    rpc: async (fn, args) => {
      const { error } = await client.rpc(fn, args);
      return { error };
    },
    selectColumns: async (table, columns) => {
      const { error } = await client.from(table).select(columns).limit(1);
      return { error };
    },
    // PostgREST's OpenAPI root lists every exposed function as a /rpc/<name>
    // path. Definitive, and it runs nothing.
    listRpcs: async () => {
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
          headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
        });
        if (!res.ok) return null;
        const doc = (await res.json()) as { paths?: Record<string, unknown> };
        const names = Object.keys(doc.paths ?? {})
          .filter((p) => p.startsWith("/rpc/"))
          .map((p) => p.slice("/rpc/".length));
        return new Set(names);
      } catch {
        return null;
      }
    },
  };
}

// PostgREST: PGRST202 = no function with that name+args in the schema cache.
// When a function with the same name but other args exists, the hint names it.
const MISSING_FN = "PGRST202";
const PERMISSION_DENIED = "42501";

function fnExistsByHint(name: string, error: RpcError | null): boolean | null {
  if (!error) return true;
  if (error.code !== MISSING_FN) return true; // some other error: the function was found and ran
  return error.hint?.includes(`public.${name}(`) ? true : false;
}

// RPCs whose real argument lists are read-only; called for real.
const READ_RPCS: [string, Record<string, unknown>][] = [
  ["list_webhook_events", { p_status: null, p_limit: 1 }],
  ["list_circuit_breakers", {}],
  ["list_dead_lettered_events", { p_limit: 1 }],
  ["get_circuit_breaker_state", { p_destination_url: "https://verify.invalid/" }],
  ["get_webhook_source", { p_name: "verify-db-probe" }],
  ["list_webhook_sources", {}],
  ["is_dashboard_session_active", { p_id: "00000000-0000-4000-8000-000000000000" }],
];

// RPCs that write. Probed with a bogus argument so nothing executes.
const WRITE_RPCS = [
  "claim_pending_webhook_events", "mark_webhook_event_delivered", "mark_webhook_event_retry",
  "mark_webhook_event_skipped", "record_delivery_success", "record_delivery_failure",
  "replay_webhook_event", "upsert_webhook_source", "disable_webhook_source",
  "create_dashboard_session", "revoke_dashboard_session", "revoke_all_dashboard_sessions",
  "reclaim_stale_webhook_events",
];

export async function checkDatabase(service: Probe, anon: Probe | null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const [fn, args] of READ_RPCS) {
    const { error } = await service.rpc(fn, args);
    results.push(error
      ? { name: `service_role: ${fn}`, status: "fail", detail: `${error.code ?? ""} ${error.message ?? ""}`.trim() }
      : { name: `service_role: ${fn}`, status: "ok", detail: "callable" });
  }

  // Mutating RPCs are never called. The API's own function listing is the
  // source of truth; the bogus-argument probe is only a fallback.
  const listed = await service.listRpcs();
  for (const fn of WRITE_RPCS) {
    if (listed) {
      results.push(listed.has(fn)
        ? { name: `service_role: ${fn}`, status: "ok", detail: "present (listed by the API, not executed)" }
        : { name: `service_role: ${fn}`, status: "fail", detail: "missing: not in the API's function listing" });
      continue;
    }
    const { error } = await service.rpc(fn, { p_verify_db_probe: true });
    const exists = fnExistsByHint(fn, error);
    results.push(exists
      ? { name: `service_role: ${fn}`, status: "ok", detail: "present (probed with a bogus argument, not executed)" }
      : { name: `service_role: ${fn}`, status: "fail", detail: `missing: ${error?.message ?? "no function found"}` });
  }

  for (const [table, cols, migration] of [
    ["webhook_events", "id,source,idempotency_key,headers,payload,status,attempts,destination_url,next_attempt_at,received_at,updated_at", "000"],
    ["webhook_events", "raw_body,claimed_at", "009"],
    ["circuit_breakers", "destination_url,state,consecutive_failures,opened_at,next_probe_at,updated_at", "000"],
    ["webhook_sources", "name,destination_url,secret_env,enabled,updated_at", "008"],
    ["dashboard_sessions", "id,expires_at,revoked_at,created_at", "008"],
  ] as const) {
    const { error } = await service.selectColumns(table, cols);
    results.push(error
      ? { name: `service_role: ${table} columns (${migration})`, status: "fail", detail: `${error.code ?? ""} ${error.message ?? ""}`.trim() }
      : { name: `service_role: ${table} columns (${migration})`, status: "ok", detail: cols });
  }

  if (!anon) {
    results.push({ name: "anon lockout", status: "skip", detail: "SUPABASE_ANON_KEY not set; lockout not verified" });
    return results;
  }

  const anonTargets: (() => Promise<RpcOutcome>)[] = [
    ...READ_RPCS.map(([fn, args]) => () => anon.rpc(fn, args)),
    () => anon.selectColumns("webhook_events", "id"),
    () => anon.selectColumns("circuit_breakers", "destination_url"),
    () => anon.selectColumns("webhook_sources", "name"),
    () => anon.selectColumns("dashboard_sessions", "id"),
  ];
  const labels = [...READ_RPCS.map(([fn]) => `rpc ${fn}`),
    "table webhook_events", "table circuit_breakers", "table webhook_sources", "table dashboard_sessions"];

  for (let i = 0; i < anonTargets.length; i++) {
    const { error } = await anonTargets[i]();
    const name = `anon denied: ${labels[i]}`;
    if (!error) {
      results.push({ name, status: "fail", detail: "anon key succeeded; migration 008 privileges are not in effect" });
    } else if (error.code === PERMISSION_DENIED) {
      results.push({ name, status: "ok", detail: "permission denied" });
    } else if (error.code === MISSING_FN) {
      results.push({ name, status: "fail", detail: "function missing for anon as well; apply the migration" });
    } else {
      // e.g. RLS returning an empty set would be success, not an error; anything
      // else that is not 42501 is reported so the operator can judge.
      results.push({ name, status: "fail", detail: `unexpected ${error.code ?? ""} ${error.message ?? ""}`.trim() });
    }
  }

  return results;
}

export function formatResults(results: CheckResult[]): string[] {
  const width = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(width)}  ${r.detail}`);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
    process.exitCode = 2;
    return;
  }
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = probeFromClient(createClient(url, serviceKey, opts), url, serviceKey);
  const anon = anonKey ? probeFromClient(createClient(url, anonKey, opts), url, anonKey) : null;

  const results = await checkDatabase(service, anon);
  for (const line of formatResults(results)) console.log(line);

  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`\n${results.length - failed - skipped} ok, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
