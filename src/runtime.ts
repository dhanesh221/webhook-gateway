// Startable/stoppable handles for the two long-running pieces of the gateway:
// the Express ingest server and the delivery worker's poll loop.
//
// Both are expressed as "start returns something with a close()" so the CLI can
// run them together in ONE process and shut both down deterministically. Running
// them as child processes would have been the other option, and it is exactly the
// option this project has been burned by twice — `npm run` / `npx` wrappers spawn
// a child that survives a kill on the parent, leaving an orphan holding port 3000.
// See Failures/orphaned-dev-server-on-port-3000.md. One process has no parent/child
// gap to leak through: when it exits, everything it owned is gone.
import type { Server } from "node:http";
import { app } from "./app";
import { getSupabase } from "./supabase";
import { processPendingBatch } from "./deliveryWorker";

export const DEFAULT_PORT = 3000;
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface WorkerHandle {
  close(): Promise<void>;
}

// Resolves only once the port is actually bound, and rejects on EADDRINUSE
// rather than leaving a half-started gateway whose tunnel points at nothing.
export function startServer(port: number): Promise<ServerHandle> {
  // Warned about here rather than inside app.ts, which must stay free of
  // import-time side effects so tests can import it cheaply.
  if (!process.env.WEBHOOK_SIGNING_SECRET) {
    console.warn(
      "[server] WEBHOOK_SIGNING_SECRET is not set — /webhooks/:source will accept " +
        "UNSIGNED requests from anyone who knows the URL. Fine locally; set it before " +
        "exposing this to the internet."
    );
  }

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(port);

    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
  });
}

// Same poll loop src/worker.ts has always run, wrapped so it can be stopped.
// Polls run strictly one at a time: the next is scheduled only after the previous
// one settles, with intervalMs as the idle gap between them. close() awaits any
// in-flight poll so shutdown doesn't cut a delivery attempt off between "HTTP
// request sent" and "outcome recorded in the database".
export function startWorker(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await processPendingBatch(getSupabase());
    } catch (err) {
      console.error(`[worker] unexpected error during poll: ${(err as Error).message}`);
    }
  }

  let inFlight: Promise<void> = Promise.resolve();
  function poll(): void {
    inFlight = tick().then(() => {
      if (!stopped) timer = setTimeout(poll, intervalMs);
    });
  }
  poll();

  return {
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
