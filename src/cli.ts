// Unified CLI: `npm run gateway -- <command>`.
//
// Everything that touches the outside world (binding a port, opening a tunnel,
// calling Supabase) arrives through the `CliDeps` object rather than being
// imported directly by the command handlers. That is what lets the test suite
// exercise the real subcommand routing without binding a real port or opening a
// real tunnel — those would make the suite slow, flaky, and dependent on a
// third-party service being up.
import dotenv from "dotenv";
// quiet: this is an operator-facing CLI, and dotenv's banner is noise above the
// startup output that actually matters.
dotenv.config({ path: ".env.local", quiet: true });

import { saveSource, listSources, disableSource } from "./sources";
import { revokeAllSessions } from "./auth";
import { Command, CommanderError } from "commander";
import {
  startServer,
  startWorker,
  DEFAULT_PORT,
  DEFAULT_POLL_INTERVAL_MS,
  type ServerHandle,
  type WorkerHandle,
} from "./runtime";
import { openTunnel, type TunnelHandle } from "./tunnel";
import { list as dlqList, replay as dlqReplay } from "./dlq";

export interface CliDeps {
  startServer(port: number): Promise<ServerHandle>;
  startWorker(intervalMs: number): WorkerHandle;
  openTunnel(port: number): Promise<TunnelHandle>;
  dlqList(): Promise<void>;
  dlqReplay(id: string | undefined): Promise<void>;
  saveSource?: typeof saveSource;
  listSources?: typeof listSources;
  disableSource?: typeof disableSource;
  revokeAllSessions?: typeof revokeAllSessions;
  log(message: string): void;
  error(message: string): void;
  /**
   * Wires Ctrl+C / SIGTERM to the handle's shutdown. Injected rather than called
   * directly so that a test exercising the `start` subcommand doesn't attach real
   * signal handlers to the test process.
   */
  registerShutdown(handle: GatewayHandle): void;
}

export const realDeps: CliDeps = {
  startServer,
  startWorker,
  openTunnel,
  saveSource, listSources, disableSource, revokeAllSessions,
  dlqList: () => dlqList(),
  dlqReplay: (id) => dlqReplay(id),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  registerShutdown: (handle) => installShutdownHandlers(handle, realDeps),
};

export interface StartOptions {
  port: number;
  tunnel: boolean;
  pollInterval: number;
}

export interface GatewayHandle {
  port: number;
  /** null when --no-tunnel was passed, or when opening the tunnel failed. */
  publicUrl: string | null;
  shutdown(): Promise<void>;
}

// Pure: takes the facts, returns the lines. Kept separate from runStart so the
// exact operator-facing wording can be asserted in a test without starting
// anything.
export function formatStartupBanner(port: number, publicUrl: string | null): string[] {
  const lines: string[] = [];

  if (publicUrl) {
    lines.push(`Your gateway is live at: ${publicUrl}`);
    lines.push(
      `Point a sender using the gateway HMAC protocol at ${publicUrl}/webhooks/<source>`
    );
    lines.push(`  e.g. ${publicUrl}/webhooks/stripe`);
  } else {
    lines.push(`Your gateway is live at: http://localhost:${port} (local only — no public tunnel)`);
    lines.push(
      `External senders cannot reach this. Drop --no-tunnel to expose it publicly.`
    );
  }

  lines.push("");
  lines.push(`Dashboard: http://localhost:${port}/dashboard.html`);
  lines.push(`  Admin password hash lives in .env.local (set by \`npm run setup:auth\`).`);
  lines.push("");
  lines.push("Delivery worker is running in this same process. Press Ctrl+C to stop both.");

  return lines;
}

// Starts the server, then the worker, then the tunnel. Returns a handle whose
// shutdown() is idempotent and tears everything down in reverse order of
// exposure: tunnel first (stop new external traffic arriving), then the server,
// then the worker (so an in-flight delivery gets to finish and record itself).
export async function runStart(
  options: StartOptions,
  deps: CliDeps
): Promise<GatewayHandle> {
  const server = await deps.startServer(options.port);
  const worker = deps.startWorker(options.pollInterval);

  let tunnel: TunnelHandle | null = null;
  if (options.tunnel) {
    deps.log("Opening public tunnel...");
    try {
      tunnel = await deps.openTunnel(options.port);
    } catch (err) {
      // A tunnel failure must not take the gateway down. Everything still works
      // locally; only external reachability is lost, and the operator is told so
      // explicitly rather than being left to wonder why no webhooks arrive.
      deps.error(`Failed to open tunnel: ${(err as Error).message}`);
      deps.error("Continuing without a public URL — the gateway is still serving locally.");
    }
  }

  for (const line of formatStartupBanner(server.port, tunnel?.url ?? null)) {
    deps.log(line);
  }

  let shuttingDown = false;
  return {
    port: server.port,
    publicUrl: tunnel?.url ?? null,
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      deps.log("Shutting down...");

      // Each step is attempted regardless of whether an earlier one threw —
      // a tunnel that fails to close must not leave the port bound.
      for (const [label, close] of [
        ["tunnel", () => tunnel?.close()],
        ["server", () => server.close()],
        ["worker", () => worker.close()],
      ] as const) {
        try {
          await close();
        } catch (err) {
          deps.error(`Error stopping ${label}: ${(err as Error).message}`);
        }
      }

      deps.log("Stopped.");
    },
  };
}

function parsePositiveInt(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommanderError(1, "gateway.invalidArgument", `${label} must be a positive integer`);
  }
  return parsed;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();

  program
    .name("gateway")
    .description("webhook-gateway — ingest, deliver, and replay webhooks")
    // Throw instead of calling process.exit, so tests can observe --help and
    // bad-argument handling, and so main() controls the exit code in one place.
    .exitOverride()
    // An unknown or missing subcommand prints the full command list, not just
    // a one-line complaint.
    .showHelpAfterError();

  program
    .command("start")
    .description("Start the ingest server and delivery worker, and open a public tunnel")
    .option(
      "-p, --port <port>",
      "port for the ingest server",
      (v) => parsePositiveInt("--port", v),
      Number(process.env.PORT) || DEFAULT_PORT
    )
    .option("--no-tunnel", "run locally only, without opening a public tunnel")
    .option(
      "--poll-interval <ms>",
      "delivery worker poll interval in milliseconds",
      (v) => parsePositiveInt("--poll-interval", v),
      DEFAULT_POLL_INTERVAL_MS
    )
    .action(async (options: { port: number; tunnel: boolean; pollInterval: number }) => {
      const handle = await runStart(
        {
          port: options.port,
          tunnel: options.tunnel,
          pollInterval: options.pollInterval,
        },
        deps
      );
      deps.registerShutdown(handle);
    });

  const dlq = program
    .command("dlq")
    .description("Inspect and replay dead-lettered events");

  dlq
    .command("list")
    .description("List dead-lettered events")
    .action(async () => {
      await deps.dlqList();
    });

  dlq
    .command("replay <event-id>")
    .description("Reset a dead-lettered event to pending so the worker retries it")
    .action(async (eventId: string) => {
      await deps.dlqReplay(eventId);
    });

  const sources = program.command("sources").description("Manage operator-owned source routes");
  sources.command("set <name> <destination-url> <secret-env>")
    .description("Create/update and enable a source; pass the env variable NAME, never the secret")
    .action(async (name, destination, secretEnv) => {
      await (deps.saveSource ?? saveSource)(name, destination, secretEnv);
      deps.log(`Source ${name} saved. Previously queued events retain their destination.`);
    });
  sources.command("list").action(async () => {
    for (const row of await (deps.listSources ?? listSources)())
      deps.log(`${row.name} ${row.enabled ? "enabled" : "disabled"} ${row.destination_url} ${row.secret_env}`);
  });
  sources.command("disable <name>").action(async name => {
    await (deps.disableSource ?? disableSource)(name);
    deps.log(`Source ${name} disabled for new ingest; queued events are unchanged.`);
  });
  program.command("sessions-revoke-all").description("Revoke every dashboard session")
    .action(async () => { await (deps.revokeAllSessions ?? revokeAllSessions)(); deps.log("Dashboard sessions revoked."); });

  return program;
}

// The real implementation behind deps.registerShutdown.
export function installShutdownHandlers(handle: GatewayHandle, deps: CliDeps): void {
  const stop = () => {
    handle
      .shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        deps.error(`Shutdown failed: ${(err as Error).message}`);
        process.exit(1);
      });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram(realDeps);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const commanderError = err as CommanderError;
    // --help and --version reach here as "errors" with exit code 0; they are
    // successful runs that simply have nothing left to do.
    if (commanderError.exitCode !== undefined) {
      process.exitCode = commanderError.exitCode;
      return;
    }
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
