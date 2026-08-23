import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBackoffDelay, MAX_ATTEMPTS } from "./backoff";

// Shape returned by the claim_pending_webhook_events RPC.
export interface ClaimedWebhookEvent {
  id: string;
  source: string;
  attempts: number;
  payload: unknown;
  destination_url: string | null;
}

export type DeliverResult = { ok: boolean; status?: number };
export type DeliverFn = (url: string, payload: unknown) => Promise<DeliverResult>;

const DELIVERY_TIMEOUT_MS = 10_000;

// Real HTTP delivery. Injectable so tests can point it at a local server, or
// (for the backoff-only cases) skip real network calls entirely.
const defaultDeliver: DeliverFn = async (url, payload) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
};

export type BatchOutcome = {
  id: string;
  outcome: "delivered" | "retry" | "dead_lettered" | "skipped";
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
  deliver: DeliverFn = defaultDeliver
): Promise<BatchOutcome[]> {
  const { data, error } = await supabase.rpc("claim_pending_webhook_events");

  if (error) {
    console.error(`[worker] failed to claim pending events: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as ClaimedWebhookEvent[];
  const results: BatchOutcome[] = [];

  for (const row of rows) {
    const attemptNumber = row.attempts + 1;

    if (!row.destination_url) {
      console.log(
        `[worker] event ${row.id} attempt ${attemptNumber}: no destination_url set, treating as failure`
      );
      results.push(await retryOrDeadLetter(supabase, row, attemptNumber));
      continue;
    }

    const breaker = await getCircuitBreakerState(supabase, row.destination_url);

    if (breaker.state === "open") {
      const probeDue =
        !breaker.next_probe_at || Date.parse(breaker.next_probe_at) <= Date.now();

      if (!probeDue) {
        const { error: skipError } = await supabase.rpc("mark_webhook_event_skipped", {
          p_id: row.id,
          p_next_attempt_at: breaker.next_probe_at,
        });
        if (skipError) {
          console.error(`[worker] event ${row.id}: failed to mark skipped (${skipError.message})`);
        }
        console.log(
          `[worker] circuit open for ${row.destination_url}, skipping event ${row.id} until ${breaker.next_probe_at}`
        );
        results.push({ id: row.id, outcome: "skipped", attempt: row.attempts });
        continue;
      }

      console.log(
        `[worker] circuit open for ${row.destination_url} but cooldown elapsed, attempting probe delivery for event ${row.id}`
      );
    }

    let result: DeliverResult;
    try {
      result = await deliver(row.destination_url, row.payload);
    } catch (err) {
      result = { ok: false };
      console.log(
        `[worker] event ${row.id} attempt ${attemptNumber}: request error (${(err as Error).message})`
      );
    }

    if (result.ok) {
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
      results.push(await retryOrDeadLetter(supabase, row, attemptNumber));
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

  return results;
}

async function retryOrDeadLetter(
  supabase: SupabaseClient,
  row: ClaimedWebhookEvent,
  attemptNumber: number
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
  console.log(
    outcome === "dead_lettered"
      ? `[worker] event ${row.id} attempt ${attemptNumber}: exceeded ${MAX_ATTEMPTS} attempts, dead-lettered`
      : `[worker] event ${row.id} attempt ${attemptNumber}: will retry in ${delayMs}ms`
  );

  return { id: row.id, outcome, attempt: attemptNumber };
}
