import { describe, it, expect } from "vitest";
import { checkDatabase, formatResults, type Probe } from "../scripts/verify-db";

type Err = { code?: string; message?: string; hint?: string | null } | null;

// A fake PostgREST: `present` functions answer the real read calls with no error
// and the bogus-argument probe with PGRST202 plus the hint PostgREST adds when a
// same-named function exists. Missing functions get PGRST202 and no hint.
function fakeProbe(opts: {
  present: Set<string>;
  columns?: Record<string, string[]>;
  denyAll?: boolean;
  noListing?: boolean;
}): Probe {
  return {
    listRpcs: async () => (opts.noListing ? null : new Set(opts.present)),
    rpc: async (fn, args) => {
      if (opts.denyAll) return { error: { code: "42501", message: "permission denied for function " + fn } as Err };
      if (!opts.present.has(fn)) {
        return { error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache`, hint: null } };
      }
      if (args && "p_verify_db_probe" in args) {
        return { error: { code: "PGRST202", message: `Could not find the function public.${fn}(p_verify_db_probe)`,
          hint: `Perhaps you meant to call the function public.${fn}(p_id)` } };
      }
      return { error: null };
    },
    selectColumns: async (table, columns) => {
      if (opts.denyAll) return { error: { code: "42501", message: "permission denied for table " + table } };
      const have = opts.columns?.[table];
      if (!have) return { error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      const missing = columns.split(",").filter((c) => !have.includes(c));
      if (missing.length) return { error: { code: "42703", message: `column ${table}.${missing[0]} does not exist` } };
      return { error: null };
    },
  };
}

const ALL_FNS = new Set([
  "list_webhook_events", "list_circuit_breakers", "list_dead_lettered_events", "get_circuit_breaker_state",
  "get_webhook_source", "list_webhook_sources", "is_dashboard_session_active",
  "claim_pending_webhook_events", "mark_webhook_event_delivered", "mark_webhook_event_retry",
  "mark_webhook_event_skipped", "record_delivery_success", "record_delivery_failure",
  "replay_webhook_event", "upsert_webhook_source", "disable_webhook_source",
  "create_dashboard_session", "revoke_dashboard_session", "revoke_all_dashboard_sessions",
  "reclaim_stale_webhook_events",
]);

const ALL_COLUMNS = {
  webhook_events: ["id", "source", "idempotency_key", "headers", "payload", "status", "attempts", "destination_url",
    "next_attempt_at", "received_at", "updated_at", "raw_body", "claimed_at"],
  circuit_breakers: ["destination_url", "state", "consecutive_failures", "opened_at", "next_probe_at", "updated_at"],
  webhook_sources: ["name", "destination_url", "secret_env", "enabled", "updated_at"],
  dashboard_sessions: ["id", "expires_at", "revoked_at", "created_at"],
};

describe("verify-db", () => {
  it("passes a fully migrated database with anon locked out", async () => {
    const service = fakeProbe({ present: ALL_FNS, columns: ALL_COLUMNS });
    const anon = fakeProbe({ present: ALL_FNS, columns: ALL_COLUMNS, denyAll: true });
    const results = await checkDatabase(service, anon);
    expect(results.filter((r) => r.status !== "ok")).toEqual([]);
    expect(results.find((r) => r.name === "service_role: claim_pending_webhook_events")?.detail).toMatch(/listed by the API/);
    expect(results.some((r) => r.name.startsWith("anon denied: table dashboard_sessions"))).toBe(true);
  });

  it("falls back to the bogus-argument probe when the API listing is unavailable", async () => {
    const present = new Set(ALL_FNS);
    present.delete("replay_webhook_event");
    const results = await checkDatabase(fakeProbe({ present, columns: ALL_COLUMNS, noListing: true }), null);
    expect(results.find((r) => r.name === "service_role: replay_webhook_event")?.status).toBe("fail");
    expect(results.find((r) => r.name === "service_role: claim_pending_webhook_events")?.detail).toMatch(/bogus argument/);
  });

  it("reports a missing 009 RPC and column without touching data", async () => {
    const present = new Set(ALL_FNS);
    present.delete("reclaim_stale_webhook_events");
    const columns = { ...ALL_COLUMNS, webhook_events: ALL_COLUMNS.webhook_events.filter((c) => c !== "claimed_at") };
    const results = await checkDatabase(fakeProbe({ present, columns }), null);
    const failed = results.filter((r) => r.status === "fail").map((r) => r.name);
    expect(failed).toEqual([
      "service_role: reclaim_stale_webhook_events",
      "service_role: webhook_events columns (009)",
    ]);
    expect(results.find((r) => r.status === "skip")?.name).toBe("anon lockout");
  });

  it("fails when the anon key can still read gateway data", async () => {
    const service = fakeProbe({ present: ALL_FNS, columns: ALL_COLUMNS });
    const anonOpen = fakeProbe({ present: ALL_FNS, columns: ALL_COLUMNS });
    const results = await checkDatabase(service, anonOpen);
    const anonResults = results.filter((r) => r.name.startsWith("anon denied"));
    expect(anonResults.length).toBeGreaterThan(0);
    expect(anonResults.every((r) => r.status === "fail")).toBe(true);
    expect(anonResults[0].detail).toMatch(/migration 008/);
  });

  it("formats one aligned line per check", async () => {
    const results = await checkDatabase(fakeProbe({ present: ALL_FNS, columns: ALL_COLUMNS }), null);
    const lines = formatResults(results);
    expect(lines).toHaveLength(results.length);
    expect(lines[0]).toMatch(/^OK {3}service_role: list_webhook_events/);
  });
});
