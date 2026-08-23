// Standalone entry point, run via `npm run worker`. Separate from deliveryWorker.ts
// so the actual claim/deliver/mark logic can be tested directly without waiting on
// real timers (see tests/deliveryWorker.test.ts).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getSupabase } from "./supabase";
import { processPendingBatch } from "./deliveryWorker";

const POLL_INTERVAL_MS = 2000;

async function tick() {
  try {
    await processPendingBatch(getSupabase());
  } catch (err) {
    console.error(`[worker] unexpected error during poll: ${(err as Error).message}`);
  }
}

console.log(`[worker] starting, polling every ${POLL_INTERVAL_MS}ms`);
tick();
setInterval(tick, POLL_INTERVAL_MS);
