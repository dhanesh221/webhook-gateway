// DLQ commands. The primary entry point is the unified CLI
// (`npm run gateway -- dlq list` / `npm run gateway -- dlq replay <event-id>`),
// which imports list() and replay() from here. The standalone `npm run dlq`
// entry point below is kept as a working alias so existing habits and any
// scripts written against it don't break.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import { getSupabase } from "./supabase";

interface DeadLetteredEvent {
  id: string;
  source: string;
  attempts: number;
  updated_at: string;
}

// Large enough that a real not-found lookup isn't hidden behind list truncation.
const LIST_ALL_LIMIT = 10_000;

const ID_WIDTH = 36;
const SOURCE_WIDTH = 16;
const ATTEMPTS_WIDTH = 8;

// padEnd sets a *minimum* width and never truncates, so a source longer than its
// column shifted every column to its right — making ATTEMPTS ambiguous in the one
// tool an operator reads during an incident. fit() enforces the width in both
// directions, so every row is exactly as wide as its header.
export function fit(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  // Reserve the final character for the ellipsis so the column width stays exact
  // and it's visible that the value was cut rather than being genuinely short.
  return value.slice(0, width - 1) + "…";
}

export async function list(limit = 50): Promise<void> {
  const { data, error } = await getSupabase().rpc("list_dead_lettered_events", {
    p_limit: limit,
  });

  if (error) {
    console.error(`Failed to list dead-lettered events: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as DeadLetteredEvent[];

  if (rows.length === 0) {
    console.log("No dead-lettered events.");
    return;
  }

  console.log(
    `${fit("ID", ID_WIDTH)} ${fit("SOURCE", SOURCE_WIDTH)} ${fit("ATTEMPTS", ATTEMPTS_WIDTH)} UPDATED_AT`
  );
  for (const row of rows) {
    console.log(
      `${fit(row.id, ID_WIDTH)} ${fit(row.source, SOURCE_WIDTH)} ` +
        `${fit(String(row.attempts), ATTEMPTS_WIDTH)} ${row.updated_at}`
    );
  }
}

export async function replay(id: string | undefined): Promise<void> {
  if (!id) {
    console.error("Usage: npm run gateway -- dlq replay <event-id>");
    process.exitCode = 1;
    return;
  }

  // replay_webhook_event returns no signal either way (confirmed empirically:
  // it returns { data: null, error: null } whether it replayed a row or
  // matched nothing) — see README's DLQ CLI section. So existence is checked
  // against the dead-letter list first, both to give a clear message and to
  // avoid calling replay on an id that isn't actually dead-lettered.
  const { data, error } = await getSupabase().rpc("list_dead_lettered_events", {
    p_limit: LIST_ALL_LIMIT,
  });

  if (error) {
    console.error(`Failed to look up event ${id}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as DeadLetteredEvent[];
  const found = rows.some((row) => row.id === id);

  if (!found) {
    console.error(`Event ${id} is not dead-lettered (not found, or already replayed).`);
    process.exitCode = 1;
    return;
  }

  const { error: replayError } = await getSupabase().rpc("replay_webhook_event", {
    p_id: id,
  });

  if (replayError) {
    console.error(`Failed to replay event ${id}: ${replayError.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Event ${id} replayed: reset to pending, attempts=0.`);
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  if (command === "list") {
    await list();
  } else if (command === "replay") {
    await replay(arg);
  } else {
    console.error("Usage: npm run gateway -- dlq list");
    console.error("       npm run gateway -- dlq replay <event-id>");
    process.exitCode = 1;
  }
}

// Only run the CLI when executed directly, not when imported by tests.
if (require.main === module) {
  main();
}
