// Phase 5 dashboard API. Mounted at /api by src/app.ts.
//
// Database RPCs are restricted to the server-only service role by Phase A.
import express from "express";
import { asyncRoute } from "./asyncRoute";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  issueSessionToken,
  requireAuth,
  sessionCookieOptions,
  verifyPassword,
  revokeSession,
} from "./auth";
import { getSupabase } from "./supabase";

export const dashboardRouter = express.Router();

// Mirrors the `webhook_events.status` check constraint. Filtering here rather
// than passing an arbitrary string through means a typo in a hand-edited URL
// gets a clear 400 instead of an empty list that looks like "nothing matched".
const VALID_STATUSES = [
  "pending",
  "in_progress",
  "delivered",
  "failed",
  "dead_lettered",
] as const;

const EVENT_LIST_LIMIT = 100;

// Large enough that the replay existence check below isn't fooled by list
// truncation — same constant and same reasoning as the DLQ CLI's.
const LIST_ALL_LIMIT = 10_000;

interface WebhookEventRow {
  id: string;
  source: string;
  status: string;
  attempts: number;
  received_at: string;
  updated_at: string;
  destination_url: string | null;
  next_attempt_at: string | null;
}

// The RPC returns full rows, payload and headers included. Those are never
// displayed and a single payload can be ~100 KB, so 100 of them would make a
// multi-megabyte response for a table that shows none of it. Project the
// columns the dashboard actually renders instead.
function projectEvent(row: Record<string, unknown>): WebhookEventRow {
  return {
    id: row.id as string,
    source: row.source as string,
    status: row.status as string,
    attempts: row.attempts as number,
    received_at: row.received_at as string,
    updated_at: row.updated_at as string,
    destination_url: (row.destination_url ?? null) as string | null,
    next_attempt_at: (row.next_attempt_at ?? null) as string | null,
  };
}

// --- Public routes ---------------------------------------------------------

dashboardRouter.post("/login", asyncRoute(async (req, res) => {
  const password = req.body?.password;

  // A wrong password, a missing password, and a non-string password all get the
  // same answer. Anything more specific tells an attacker which half of the
  // guess was wrong.
  if (typeof password !== "string" || !(await verifyPassword(password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.cookie(SESSION_COOKIE, await issueSessionToken(), {
    ...sessionCookieOptions(),
    maxAge: SESSION_TTL_SECONDS * 1000,
  });

  return res.json({ status: "ok" });
}));

// Not behind requireAuth: clearing a cookie that's already invalid should still
// work, and there's nothing to protect.
dashboardRouter.post("/logout", asyncRoute(async (req, res) => {
  await revokeSession(req);
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  return res.json({ status: "ok" });
}));

// --- Everything below this line requires a valid session -------------------

dashboardRouter.use(requireAuth);

dashboardRouter.get("/events", asyncRoute(async (req, res) => {
  const status = req.query.status;

  if (status !== undefined && status !== "") {
    if (
      typeof status !== "string" ||
      !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])
    ) {
      return res.status(400).json({
        error: `Unknown status. Expected one of: ${VALID_STATUSES.join(", ")}`,
      });
    }
  }

  const { data, error } = await getSupabase().rpc("list_webhook_events", {
    p_status: status ? status : null,
    p_limit: EVENT_LIST_LIMIT,
  });

  if (error) {
    console.error("list_webhook_events failed:", error);
    return res.status(500).json({ error: "Failed to list events" });
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  return res.json({ events: rows.map(projectEvent) });
}));

dashboardRouter.get("/circuit-breakers", asyncRoute(async (_req, res) => {
  const { data, error } = await getSupabase().rpc("list_circuit_breakers");

  if (error) {
    console.error("list_circuit_breakers failed:", error);
    return res.status(500).json({ error: "Failed to list circuit breakers" });
  }

  return res.json({ breakers: data ?? [] });
}));

dashboardRouter.post("/events/:id/replay", asyncRoute(async (req, res) => {
  const id = req.params.id;

  // replay_webhook_event returns { data: null, error: null } whether it replayed
  // a row or matched nothing (confirmed empirically in Phase 4). So, exactly as
  // the DLQ CLI does, check that the event really is dead-lettered first —
  // otherwise every replay would report success, including replays of ids that
  // don't exist or are still pending.
  const { data, error } = await getSupabase().rpc("list_webhook_events", {
    p_status: "dead_lettered",
    p_limit: LIST_ALL_LIMIT,
  });

  if (error) {
    console.error("list_webhook_events failed during replay:", error);
    return res.status(500).json({ error: "Failed to look up event" });
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.some((row) => row.id === id)) {
    return res.status(409).json({
      error: `Event ${id} is not dead-lettered (not found, or already replayed).`,
    });
  }

  const { error: replayError } = await getSupabase().rpc("replay_webhook_event", {
    p_id: id,
  });

  if (replayError) {
    console.error("replay_webhook_event failed:", replayError);
    return res.status(500).json({ error: "Failed to replay event" });
  }

  return res.json({
    status: "replayed",
    id,
    message: "Reset to pending, attempts=0.",
  });
}));
