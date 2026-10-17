import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBackoffDelay, MAX_ATTEMPTS } from "./backoff";
import { defaultDeliveryLimiter, type DeliveryLimiter } from "./rateLimit";

import { gatewayMetrics, type GatewayMetrics } from "./metrics";

// Shape returned by the claim_pending_webhook_events RPC.
export interface ClaimedWebhookEvent {
  id: string;
  source: string;
  attempts: number;
  payload: unknown;
  destination_url: string | null;
}

export type DeliverResult = { ok: boolean; status?: number };
// rawBody is the exact bytes the sender posted, when stored. Delivering it avoids
// the JSON.parse/stringify round trip, which rounds integers beyond 2^53.
export type DeliverFn = (url: string, payload: unknown, rawBody?: string | null) => Promise<DeliverResult>;

// An event claimed (in_progress) for longer than this is assumed abandoned by a
// crashed worker and returned to pending. Must exceed the longest plausible
// batch: rows are delivered one at a time, each bounded by DELIVERY_TIMEOUT_MS.
export const STALE_CLAIM_SECONDS = 10 * 60;

const DELIVERY_TIMEOUT_MS = 10_000;

// How long one worker holds the exclusive right to probe an open breaker. Must
// cover a full delivery attempt (DELIVERY_TIMEOUT_MS) plus recording its result;
// if the prober dies, the lease lapses and the next due poll takes over.
export const PROBE_LEASE_SECONDS = 30;

// Real HTTP delivery. Injectable so tests can point it at a local server, or
// (for the backoff-only cases) skip real network calls entirely.
const defaultDeliver: DeliverFn = async (url, payload, rawBody) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody ?? JSON.stringify(payload),
      // A redirect would send the payload somewhere the registry never approved.
      // A 3xx is reported as a failed delivery instead.
      redirect: "manual",
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
};

export type BatchOutcome = {
  id: string;
  outcome: "delivered" | "retry" | "dead_lettered" | "skipped" | "released" | "rate_limited";
  attempt: number;
};

type CircuitState = "closed" | "open";

interface CircuitBreakerState {
  state: CircuitState;
  next_probe_at: string | null;
}

// get_circuit_breaker_state always returns exactly one row (even for a
// destination with no breaker row yet, it synthesizes {closed, null}), as a
// single-element array — confirmed empirically against the live RPC.
async function getCircuitBreakerState(
  supabase: SupabaseClient,
  destinationUrl: string
): Promise<CircuitBreakerState> {
  const { data, error } = await supabase.rpc("get_circuit_breaker_state", {
    p_destination_url: destinationUrl,
  });

  if (error) {
    console.error(
      `[worker] failed to read circuit breaker state for ${destinationUrl}: ${error.message}`
    );
    return { state: "closed", next_probe_at: null };
  }

  const row = (Array.isArray(data) ? data[0] : data) as CircuitBreakerState | undefined;
  return row ?? { state: "closed", next_probe_at: null };
}

// Claims whatever's due, attempts delivery for each, and reports the outcome for
// each row. Separated from the setInterval wrapper in worker.ts so it can be
// invoked directly in tests without waiting on real timers.
export async function processPendingBatch(
  supabase: SupabaseClient,
  deliver: DeliverFn = defaultDeliver,
  limiter: DeliveryLimiter = defaultDeliveryLimiter(),
  metrics: GatewayMetrics = gatewayMetrics
): Promise<BatchOutcome[]> {
  await reclaimStaleEvents(supabase);
  const { data, error } = await supabase.rpc("claim_pending_webhook_events");

  if (error) {
    console.error(`[worker] failed to claim pending events: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as ClaimedWebhookEvent[];
  const results: BatchOutcome[] = [];
  let rawBodies: Map<string, string | null> | undefined;
  try {
    rawBodies = await fetchRawBodies(supabase, rows.map((r) => r.id));
  } catch (err) {
    console.error(`[worker] could not read raw bodies (${(err as Error).message}); releasing batch`);
  }

  for (const row of rows) {
    try {
      // An unreadable or missing row is not a legacy NULL body. Never rebuild
      // it from parsed JSON: that can silently round the sender's large IDs.
      if (!rawBodies?.has(row.id)) throw new Error("Stored raw body unavailable");
      await processRow(supabase, deliver, row, rawBodies.get(row.id)!, results, limiter, metrics);
    } catch (err) {
      // One bad row must not strand it and every later claimed row in
      // in_progress. Hand it back to pending without spending an attempt.
      console.error(`[worker] event ${row.id}: unexpected error (${(err as Error).message}), releasing`);
      try {
        const { error: relError } = await supabase.rpc("mark_webhook_event_skipped", {
          p_id: row.id,
          p_next_attempt_at: new Date(Date.now() + 5_000).toISOString(),
        });
        if (relError) throw new Error(relError.message);
      } catch (relErr) {
        console.error(
          `[worker] event ${row.id}: release failed (${(relErr as Error).message}); stale-claim recovery will return it`
        );
      }
      results.push({ id: row.id, outcome: "released", attempt: row.attempts });
    }
  }

  return results;
}

async function processRow(
  supabase: SupabaseClient,
  deliver: DeliverFn,
  row: ClaimedWebhookEvent,
  rawBody: string | null,
  results: BatchOutcome[],
  limiter: DeliveryLimiter,
  metrics: GatewayMetrics
): Promise<void> {
    const attemptNumber = row.attempts + 1;

    if (!row.destination_url) {
      console.log(
        `[worker] event ${row.id} attempt ${attemptNumber}: no destination_url set, treating as failure`
      );
      metrics.increment("failed", row.source, row.destination_url);
      results.push(await retryOrDeadLetter(supabase, row, attemptNumber, metrics));
      return;
    }

    const breaker = await getCircuitBreakerState(supabase, row.destination_url);

    if (breaker.state === "open") {
      const probeDue =
        !breaker.next_probe_at || Date.parse(breaker.next_probe_at) <= Date.now();

      if (!probeDue) {
        results.push(await skipUntil(supabase, row, breaker.next_probe_at, "circuit open"));
        return;
      }

    }

    // The delivery token is taken before any probe lease: an empty bucket must
    // defer the event without consuming the lease, or nobody would probe until
    // the lease lapsed.
    const waitMs = limiter.take(row.destination_url);
    if (waitMs > 0) {
      const { error } = await supabase.rpc("mark_webhook_event_skipped", {
        p_id: row.id,
        p_next_attempt_at: new Date(Date.now() + waitMs).toISOString(),
      });
      if (error) throw new Error("Failed to defer rate-limited event");
      results.push({ id: row.id, outcome: "rate_limited", attempt: row.attempts });
      return;
    }

    if (breaker.state === "open") {
      // Every worker polling right now sees the same due probe. Only the one that
      // wins the lease sends it; the rest wait for the lease (or the probe's own
      // outcome) rather than piling onto a destination that is still recovering.
      const lease = await claimProbe(supabase, row.destination_url);
      if (lease === "taken") {
        const current = await getCircuitBreakerState(supabase, row.destination_url);
        const until =
          current.next_probe_at ?? new Date(Date.now() + PROBE_LEASE_SECONDS * 1000).toISOString();
        results.push(await skipUntil(supabase, row, until, "probe already in flight elsewhere"));
        return;
      }

      console.log(
        `[worker] circuit open for ${row.destination_url} but cooldown elapsed, attempting probe delivery for event ${row.id}`
      );
    }

    let result: DeliverResult;
    try {
      result = await deliver(row.destination_url, row.payload, rawBody);
    } catch (err) {
      result = { ok: false };
      console.log(
        `[worker] event ${row.id} attempt ${attemptNumber}: request error (${(err as Error).message})`
      );
    }

    if (result.ok) {
      metrics.increment("delivered", row.source, row.destination_url);
      const { error: markError } = await supabase.rpc("mark_webhook_event_delivered", {
        p_id: row.id,
      });
      if (markError) {
        console.error(`[worker] event ${row.id}: failed to mark delivered (${markError.message})`);
      }
      const { error: successError } = await supabase.rpc("record_delivery_success", {
        p_destination_url: row.destination_url,
      });
      if (successError) {
        console.error(
          `[worker] failed to record delivery success for ${row.destination_url}: ${successError.message}`
        );
      }
      console.log(`[worker] event ${row.id} attempt ${attemptNumber}: delivered`);
      results.push({ id: row.id, outcome: "delivered", attempt: attemptNumber });
    } else {
      if (result.status !== undefined) {
        console.log(
          `[worker] event ${row.id} attempt ${attemptNumber}: destination responded ${result.status}`
        );
      }
      metrics.increment("failed", row.source, row.destination_url);
      results.push(await retryOrDeadLetter(supabase, row, attemptNumber, metrics));
      const { error: failureError } = await supabase.rpc("record_delivery_failure", {
        p_destination_url: row.destination_url,
      });
      if (failureError) {
        console.error(
          `[worker] failed to record delivery failure for ${row.destination_url}: ${failureError.message}`
        );
      }
    }
}

// Returns a claimed row to pending without spending an attempt, due again at
// `until`. Used for breaker skips of both kinds.
async function skipUntil(
  supabase: SupabaseClient,
  row: ClaimedWebhookEvent,
  until: string | null,
  reason: string
): Promise<BatchOutcome> {
  const { error } = await supabase.rpc("mark_webhook_event_skipped", {
    p_id: row.id,
    p_next_attempt_at: until,
  });
  if (error) {
    console.error(`[worker] event ${row.id}: failed to mark skipped (${error.message})`);
  }
  console.log(`[worker] ${reason} for ${row.destination_url}, skipping event ${row.id} until ${until}`);
  return { id: row.id, outcome: "skipped", attempt: row.attempts };
}

let probeLeaseUnavailableLogged = false;

// Atomically takes the right to probe an open breaker (migration 010). "won"
// means probe now; "taken" means another worker got there first; "unavailable"
// means the RPC is missing or failed, in which case the caller probes anyway,
// exactly as every worker did before 010.
async function claimProbe(
  supabase: SupabaseClient,
  destinationUrl: string
): Promise<"won" | "taken" | "unavailable"> {
  try {
    const { data, error } = await supabase.rpc("claim_circuit_probe", {
      p_destination_url: destinationUrl,
      p_lease_seconds: PROBE_LEASE_SECONDS,
    });
    if (error) throw new Error(error.message);
    return data === true ? "won" : "taken";
  } catch (err) {
    if (!probeLeaseUnavailableLogged) {
      probeLeaseUnavailableLogged = true;
      console.error(
        `[worker] probe lease unavailable (${(err as Error).message}); probing without one. Apply migrations/010`
      );
    }
    return "unavailable";
  }
}

// The claim RPC's column list lives in the database, so raw_body is read with a
// separate query. Only an explicit NULL permits legacy JSON re-serialization.
async function fetchRawBodies(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase.from("webhook_events").select("id, raw_body").in("id", ids);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as { id: string; raw_body: string | null }[]) {
    if (r.raw_body === null || typeof r.raw_body === "string") out.set(r.id, r.raw_body);
  }
  return out;
}

let reclaimUnavailableLogged = false;

// Returns events stuck in in_progress (worker crashed after claiming) to pending.
// Needs reclaim_stale_webhook_events from migrations/009; absent, it logs once.
export async function reclaimStaleEvents(supabase: SupabaseClient): Promise<void> {
  try {
    const { error } = await supabase.rpc("reclaim_stale_webhook_events", {
      p_stale_after_seconds: STALE_CLAIM_SECONDS,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    if (!reclaimUnavailableLogged) {
      reclaimUnavailableLogged = true;
      console.error(`[worker] stale-claim recovery unavailable (${(err as Error).message}); apply migrations/009`);
    }
  }
}

async function retryOrDeadLetter(
  supabase: SupabaseClient,
  row: ClaimedWebhookEvent,
  attemptNumber: number,
  metrics: GatewayMetrics
): Promise<BatchOutcome> {
  // computeBackoffDelay takes attempts-already-made (0-indexed), i.e. the count
  // before this failed attempt is recorded.
  const delayMs = computeBackoffDelay(row.attempts);
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

  const { error } = await supabase.rpc("mark_webhook_event_retry", {
    p_id: row.id,
    p_next_attempt_at: nextAttemptAt,
    p_max_attempts: MAX_ATTEMPTS,
  });

  if (error) {
    console.error(`[worker] event ${row.id}: failed to mark retry (${error.message})`);
  }

  const outcome = attemptNumber >= MAX_ATTEMPTS ? "dead_lettered" : "retry";
  if (!error) metrics.increment(outcome === "retry" ? "retried" : "dead_lettered", row.source, row.destination_url);
  console.log(
    outcome === "dead_lettered"
      ? `[worker] event ${row.id} attempt ${attemptNumber}: exceeded ${MAX_ATTEMPTS} attempts, dead-lettered`
      : `[worker] event ${row.id} attempt ${attemptNumber}: will retry in ${delayMs}ms`
  );

  return { id: row.id, outcome, attempt: attemptNumber };
}
