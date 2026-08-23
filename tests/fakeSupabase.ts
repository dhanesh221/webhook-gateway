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

export interface FakeRow extends ClaimedWebhookEvent {
  status: string;
}

interface FakeBreaker {
  state: "closed" | "open";
  consecutiveFailures: number;
  nextProbeAt: string | null;
}

export function makeFakeSupabase(
  rows: ClaimedWebhookEvent[],
  opts: { failureThreshold?: number; cooldownMs?: number } = {}
) {
  const failureThreshold = opts.failureThreshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 60_000;

  const table = new Map<string, FakeRow>(
    rows.map((r) => [r.id, { ...r, status: "pending" }])
  );
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
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      switch (fn) {
        case "claim_pending_webhook_events": {
          const claimed: ClaimedWebhookEvent[] = [];
          for (const row of table.values()) {
            if (row.status === "pending") {
              row.status = "in_progress";
              claimed.push({ ...row });
            }
          }
          return { data: claimed, error: null };
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
            .slice(0, limit);
          return { data: deadLettered, error: null };
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

  return { client: client as unknown as SupabaseClient, table, breakers };
}
