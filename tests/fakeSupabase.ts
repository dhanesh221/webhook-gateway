import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedWebhookEvent } from "../src/deliveryWorker";

// Shared in-memory stand-in for the RPCs the delivery worker and DLQ CLI call,
// modeling the real behavior verified live against Supabase (see the Phase 3
// and Phase 4 session notes for the empirical checks this is based on):
//
// - claim_pending_webhook_events: returns pending rows, flips them in_progress.
//   Timing (next_attempt_at) is intentionally ignored — the real DB enforces
//   that gate; tests only need to drive processPendingBatch call-by-call.
// - mark_webhook_event_retry: increments attempts, dead-letters at p_max_attempts.
// - mark_webhook_event_skipped: puts a row back to pending WITHOUT incrementing
//   attempts (used when a circuit breaker is open and not yet due for a probe).
// - get_circuit_breaker_state / record_delivery_success / record_delivery_failure:
//   model the circuit_breakers table. The real RPCs return no success/failure
//   signal on record_delivery_success/failure (confirmed empirically), so
//   callers never depend on their return value beyond `error`.
// - list_dead_lettered_events / replay_webhook_event: model the DLQ RPCs.
//   replay_webhook_event also returns no signal either way (confirmed
//   empirically against a real dead-lettered row and a nonexistent id) — the
//   DLQ CLI checks list_dead_lettered_events itself to report not-found.
//
// It also models the one non-RPC call the ingest endpoint makes,
// `.from("webhook_events").insert(row)`, including the unique index on
// (source, idempotency_key) that surfaces as Postgres error 23505. That lets a
// single fake back the whole pipeline at once — the real Express app writing
// into the same table the real worker later claims from.

export interface FakeRow extends ClaimedWebhookEvent {
  status: string;
  idempotency_key?: string | null;
  raw_body?: string | null;
  claimed_at?: number | null;
}

interface FakeBreaker {
  state: "closed" | "open";
  consecutiveFailures: number;
  nextProbeAt: string | null;
}

export function makeFakeSupabase(
  rows: ClaimedWebhookEvent[],
  opts: { failureThreshold?: number; cooldownMs?: number; claimAgeMs?: number } = {}
) {
  const failureThreshold = opts.failureThreshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 60_000;

  const table = new Map<string, FakeRow>(
    rows.map((r) => [r.id, { ...r, status: "pending" }])
  );
  const sources = new Map<string, {name: string; destination_url: string; secret_env: string; enabled: boolean}>();
  const sessions = new Map<string, {expires: number; revoked: boolean}>();
  const breakers = new Map<string, FakeBreaker>();

  function breakerFor(url: string): FakeBreaker {
    let b = breakers.get(url);
    if (!b) {
      b = { state: "closed", consecutiveFailures: 0, nextProbeAt: null };
      breakers.set(url, b);
    }
    return b;
  }

  const client = {
    // Mirrors src/app.ts's only database call. The real table's unique index on
    // (source, idempotency_key) rejects a redelivery with 23505; NULL keys never
    // collide in Postgres, so an omitted Idempotency-Key never dedupes.
    from: (tableName: string) => {
      if (tableName !== "webhook_events") {
        throw new Error(`unexpected table: ${tableName}`);
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          const source = row.source as string;
          const key = (row.idempotency_key ?? null) as string | null;

          if (key !== null) {
            for (const existing of table.values()) {
              if (existing.source === source && existing.idempotency_key === key) {
                return {
                  data: null,
                  error: {
                    code: "23505",
                    message: "duplicate key value violates unique constraint",
                  },
                };
              }
            }
          }

          table.set(row.id as string, {
            id: row.id as string,
            source,
            idempotency_key: key,
            attempts: 0,
            payload: row.payload,
            destination_url: (row.destination_url ?? null) as string | null,
            raw_body: (row.raw_body ?? null) as string | null,
            status: "pending",
          });
          return { data: null, error: null };
        },
        select: (_cols: string) => ({
          in: async (_col: string, ids: string[]) => ({
            data: ids.filter((i) => table.has(i)).map((i) => ({ id: i, raw_body: table.get(i)!.raw_body ?? null })),
            error: null,
          }),
        }),
      };
    },

    rpc: async (fn: string, args?: Record<string, unknown>) => {
      switch (fn) {
        case "get_webhook_source": return { data: [sources.get(args!.p_name as string)].filter(Boolean), error: null };
        case "list_webhook_sources": return { data: [...sources.values()], error: null };
        case "upsert_webhook_source": {
          sources.set(args!.p_name as string, {name: args!.p_name as string, destination_url: args!.p_destination_url as string, secret_env: args!.p_secret_env as string, enabled: true});
          return { data: null, error: null };
        }
        case "disable_webhook_source": {
          const row = sources.get(args!.p_name as string); if (row) row.enabled = false;
          return { data: !!row, error: null };
        }
        case "create_dashboard_session": {
          sessions.set(args!.p_id as string, {expires: Date.parse(args!.p_expires_at as string), revoked: false});
          return { data: null, error: null };
        }
        case "is_dashboard_session_active": {
          const session = sessions.get(args!.p_id as string);
          return { data: !!session && !session.revoked && session.expires > Date.now(), error: null };
        }
        case "revoke_dashboard_session": {
          const session = sessions.get(args!.p_id as string); if (session) session.revoked = true;
          return { data: null, error: null };
        }
        case "revoke_all_dashboard_sessions": {
          for (const session of sessions.values()) session.revoked = true;
          return { data: null, error: null };
        }
        case "claim_pending_webhook_events": {
          const claimed: ClaimedWebhookEvent[] = [];
          for (const row of table.values()) {
            if (row.status === "pending") {
              row.status = "in_progress";
              row.claimed_at = Date.now() - (opts.claimAgeMs ?? 0);
              claimed.push({ ...row });
            }
          }
          return { data: claimed, error: null };
        }

        case "reclaim_stale_webhook_events": {
          const cutoff = Date.now() - (args!.p_stale_after_seconds as number) * 1000;
          for (const row of table.values()) {
            if (row.status === "in_progress" && (row.claimed_at ?? 0) < cutoff) row.status = "pending";
          }
          return { data: null, error: null };
        }

        case "mark_webhook_event_delivered": {
          const row = table.get(args!.p_id as string)!;
          row.status = "delivered";
          return { data: null, error: null };
        }

        case "mark_webhook_event_retry": {
          const row = table.get(args!.p_id as string)!;
          row.attempts += 1;
          const maxAttempts = (args!.p_max_attempts as number) ?? 5;
          row.status = row.attempts >= maxAttempts ? "dead_lettered" : "pending";
          return { data: null, error: null };
        }

        case "mark_webhook_event_skipped": {
          const row = table.get(args!.p_id as string)!;
          row.status = "pending";
          return { data: null, error: null };
        }

        case "get_circuit_breaker_state": {
          const b = breakerFor(args!.p_destination_url as string);
          return { data: [{ state: b.state, next_probe_at: b.nextProbeAt }], error: null };
        }

        case "record_delivery_success": {
          const b = breakerFor(args!.p_destination_url as string);
          b.state = "closed";
          b.consecutiveFailures = 0;
          b.nextProbeAt = null;
          return { data: null, error: null };
        }

        case "record_delivery_failure": {
          const b = breakerFor(args!.p_destination_url as string);
          b.consecutiveFailures += 1;
          if (b.consecutiveFailures >= failureThreshold) {
            b.state = "open";
            b.nextProbeAt = new Date(Date.now() + cooldownMs).toISOString();
          }
          return { data: null, error: null };
        }

        case "list_dead_lettered_events": {
          const limit = (args?.p_limit as number) ?? 50;
          const deadLettered = [...table.values()]
            .filter((r) => r.status === "dead_lettered")
            .slice(0, limit)
            // The real RPC returns full webhook_events rows; updated_at is the
            // only extra column the DLQ CLI actually prints.
            .map((r) => ({ ...r, updated_at: new Date().toISOString() }));
          return { data: deadLettered, error: null };
        }

        // Phase 5 dashboard reads (migration `add_dashboard_read_functions`).
        // Probed live before writing the dashboard: p_status is optional and an
        // unrecognised status simply matches nothing (no error), and the RPC
        // returns full webhook_events rows, newest first.
        case "list_webhook_events": {
          const status = (args?.p_status ?? null) as string | null;
          const limit = (args?.p_limit as number) ?? 100;
          const matching = [...table.values()]
            .filter((r) => status === null || r.status === status)
            .slice(0, limit)
            .map((r) => ({
              ...r,
              received_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              next_attempt_at: null,
            }));
          return { data: matching, error: null };
        }

        // Live shape: destination_url, state, consecutive_failures, opened_at,
        // next_probe_at, updated_at — one row per destination ever seen.
        case "list_circuit_breakers": {
          const all = [...breakers.entries()].map(([url, b]) => ({
            destination_url: url,
            state: b.state,
            consecutive_failures: b.consecutiveFailures,
            opened_at: b.state === "open" ? new Date().toISOString() : null,
            next_probe_at: b.nextProbeAt,
            updated_at: new Date().toISOString(),
          }));
          return { data: all, error: null };
        }

        case "replay_webhook_event": {
          const row = table.get(args!.p_id as string);
          if (row && row.status === "dead_lettered") {
            row.status = "pending";
            row.attempts = 0;
          }
          return { data: null, error: null };
        }

        default:
          throw new Error(`unexpected rpc call: ${fn}`);
      }
    },
  };

  return { client: client as unknown as SupabaseClient, table, breakers, sources, sessions };
}
