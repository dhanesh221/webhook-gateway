import express from "express";
import { randomUUID } from "node:crypto";
import { getSupabase } from "./supabase";

// Separate from index.ts so tests can import the app without starting a real server.
export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Receives a webhook from an external provider and stores it for later delivery.
// Responds immediately — actual delivery is the Phase 3 worker's job.
app.post("/webhooks/:source", async (req, res) => {
  const source = req.params.source;
  const idempotencyKey = req.header("Idempotency-Key") || null;
  const payload = req.body;

  if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
    return res
      .status(400)
      .json({ error: "Request body must be a non-empty JSON object" });
  }

  // The id is generated here rather than read back from the database. The table's
  // RLS policy grants INSERT only, and asking Postgres to RETURN the new row needs
  // SELECT rights — so `.select()` after an insert fails with 42501. Generating the
  // uuid client-side lets us report it while keeping the anon key read-blocked.
  const id = randomUUID();

  // Read at request time (not module load) so importing app.ts never requires
  // env vars — same reasoning as getSupabase()'s lazy init.
  const destinationUrl = process.env.DESTINATION_URL || null;

  const { error } = await getSupabase()
    .from("webhook_events")
    .insert({
      id,
      source,
      idempotency_key: idempotencyKey,
      headers: req.headers,
      payload,
      status: "pending",
      destination_url: destinationUrl,
    });

  if (error) {
    // 23505 is Postgres' unique_violation. Here it means the unique index on
    // (source, idempotency_key) rejected a webhook we already stored. Providers
    // redeliver routinely, so this is expected traffic, not a failure — we
    // acknowledge it so the provider stops retrying.
    if (error.code === "23505") {
      return res
        .status(200)
        .json({ status: "duplicate", message: "already received" });
    }

    return res.status(500).json({ error: "Failed to store webhook event" });
  }

  return res.status(202).json({ id, status: "pending" });
});

// Catch-all error handler. Every error ends up here — nothing falls through to
// Express's default HTML handler, which would leak a stack trace (and absolute
// filesystem paths) to the client. Full detail goes to the server log instead.
app.use(
  (
    err: Error & { status?: number; statusCode?: number },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    const status = err.status || err.statusCode || 500;
    const message =
      status === 400
        ? "Invalid JSON body"
        : status === 413
          ? "Payload too large"
          : "Internal server error";
    console.error(err);
    res.status(status).json({ error: message });
  }
);
