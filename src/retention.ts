// Retention: delete finished events once they are old enough (migration 012).
//
// Delivered events are evidence that something happened; dead-lettered events
// are work an operator may still replay. Both are kept for a configurable
// number of days and then purged, together with expired or revoked dashboard
// sessions. Pending, in-progress and failed events are never purged.
//
// The worker runs this once an hour (src/runtime.ts); `gateway retention purge`
// runs it on demand. Both read the policy from the environment unless given one.
import type { SupabaseClient } from "@supabase/supabase-js";
import { gatewayMetrics } from "./metrics";

export const DEFAULT_DELIVERED_DAYS = 30;
export const DEFAULT_DEAD_LETTERED_DAYS = 90;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
// Rows deleted per status per RPC call; the worker's hourly run repeats until a
// call deletes fewer than this, so a backlog drains in bounded steps.
export const PURGE_BATCH = 5000;

export interface RetentionPolicy {
  // 0 means keep forever.
  deliveredDays: number;
  deadLetteredDays: number;
}

export interface RetentionResult {
  deliveredDeleted: number;
  deadLetteredDeleted: number;
  sessionsDeleted: number;
}

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function retentionPolicyFromEnv(): RetentionPolicy {
  return {
    deliveredDays: envDays("WG_RETAIN_DELIVERED_DAYS", DEFAULT_DELIVERED_DAYS),
    deadLetteredDays: envDays("WG_RETAIN_DEAD_LETTERED_DAYS", DEFAULT_DEAD_LETTERED_DAYS),
  };
}

const daysToSeconds = (days: number) => Math.round(days * 24 * 60 * 60);

// Purges until a pass deletes less than a full batch of each status, so a long
// backlog is removed in PURGE_BATCH-sized steps rather than one giant delete.
// Throws on database error; callers decide whether that is fatal.
export async function runRetention(
  supabase: SupabaseClient,
  policy: RetentionPolicy = retentionPolicyFromEnv(),
  maxPasses = 20
): Promise<RetentionResult> {
  const result: RetentionResult = { deliveredDeleted: 0, deadLetteredDeleted: 0, sessionsDeleted: 0 };

  if (policy.deliveredDays > 0 || policy.deadLetteredDays > 0) {
    for (let pass = 0; pass < maxPasses; pass++) {
      const { data, error } = await supabase.rpc("purge_webhook_events", {
        p_delivered_after_seconds: policy.deliveredDays > 0 ? daysToSeconds(policy.deliveredDays) : null,
        p_dead_lettered_after_seconds: policy.deadLetteredDays > 0 ? daysToSeconds(policy.deadLetteredDays) : null,
        p_batch: PURGE_BATCH,
      });
      if (error) throw new Error(`purge_webhook_events failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        { delivered_deleted: number; dead_lettered_deleted: number } | undefined;
      const delivered = row?.delivered_deleted ?? 0;
      const dead = row?.dead_lettered_deleted ?? 0;
      result.deliveredDeleted += delivered;
      result.deadLetteredDeleted += dead;
      if (delivered < PURGE_BATCH && dead < PURGE_BATCH) break;
    }
  }

  const { data: sessions, error: sessionsError } = await supabase.rpc("purge_dashboard_sessions");
  if (sessionsError) throw new Error(`purge_dashboard_sessions failed: ${sessionsError.message}`);
  result.sessionsDeleted = typeof sessions === "number" ? sessions : 0;

  if (result.deliveredDeleted) gatewayMetrics.count("webhook_retention_purged_total", "delivered", BigInt(result.deliveredDeleted));
  if (result.deadLetteredDeleted) gatewayMetrics.count("webhook_retention_purged_total", "dead_lettered", BigInt(result.deadLetteredDeleted));
  if (result.sessionsDeleted) gatewayMetrics.count("webhook_retention_purged_total", "sessions", BigInt(result.sessionsDeleted));

  return result;
}

export function describeRetention(policy: RetentionPolicy, result: RetentionResult): string {
  const keep = (days: number) => (days > 0 ? `${days}d` : "forever");
  return `retention: delivered kept ${keep(policy.deliveredDays)} (${result.deliveredDeleted} purged), ` +
    `dead-lettered kept ${keep(policy.deadLetteredDays)} (${result.deadLetteredDeleted} purged), ` +
    `${result.sessionsDeleted} stale sessions removed`;
}
