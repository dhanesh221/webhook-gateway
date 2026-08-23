// Standalone worker entry point, run via `npm run worker`. Still supported for
// running the worker on its own (a second machine, a separate container), but
// `npm run gateway -- start` runs the server and this same loop together in one
// process and is the usual way in.
//
// The loop itself lives in src/runtime.ts so both entry points share exactly one
// implementation, and so the claim/deliver/mark logic in deliveryWorker.ts stays
// directly testable without waiting on real timers.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { startWorker, DEFAULT_POLL_INTERVAL_MS } from "./runtime";

console.log(`[worker] starting, polling every ${DEFAULT_POLL_INTERVAL_MS}ms`);
const worker = startWorker(DEFAULT_POLL_INTERVAL_MS);

const stop = () => {
  worker
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
