import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Command } from "commander";
import {
  buildProgram,
  runStart,
  formatStartupBanner,
  type CliDeps,
  type GatewayHandle,
} from "../src/cli";

// Nothing here binds a port, opens a tunnel, or talks to Supabase. The tunnel in
// particular is a third-party network service — starting a real one in the suite
// would make it slow, flaky, and dependent on loca.lt being up. Every outside
// edge arrives through CliDeps, so the real subcommand routing runs against fakes.

interface Recorder {
  deps: CliDeps;
  serverClose: ReturnType<typeof vi.fn>;
  workerClose: ReturnType<typeof vi.fn>;
  tunnelClose: ReturnType<typeof vi.fn>;
  logs: string[];
  errors: string[];
  registered: GatewayHandle[];
}

function makeDeps(overrides: Partial<CliDeps> = {}): Recorder {
  const serverClose = vi.fn(async () => {});
  const workerClose = vi.fn(async () => {});
  const tunnelClose = vi.fn(async () => {});
  const logs: string[] = [];
  const errors: string[] = [];
  const registered: GatewayHandle[] = [];

  const deps: CliDeps = {
    startServer: vi.fn(async (port: number) => ({ port, close: serverClose })),
    startWorker: vi.fn(() => ({ close: workerClose })),
    openTunnel: vi.fn(async () => ({
      url: "https://fake-tunnel.loca.lt",
      close: tunnelClose,
    })),
    dlqList: vi.fn(async () => {}),
    dlqReplay: vi.fn(async () => {}),
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    registerShutdown: (h) => registered.push(h),
    ...overrides,
  };

  return { deps, serverClose, workerClose, tunnelClose, logs, errors, registered };
}

// Commander's `from: "user"` means "these are the args after the program name",
// i.e. exactly what follows `npm run gateway --`.
// Output is captured rather than let through, so error paths (which print the
// full help) don't spray commander's usage text across the test report.
function run(deps: CliDeps, args: string[]) {
  return captureOutput(deps).program.parseAsync(args, { from: "user" });
}

// Subcommands copy the parent's output configuration when they are created, so
// configuring only the root after buildProgram would leave `dlq --help` writing
// to the real stdout. Walk the tree instead.
function captureOutput(deps: CliDeps): { program: Command; out: string[] } {
  const out: string[] = [];
  const program = buildProgram(deps);

  const apply = (cmd: Command) => {
    cmd.configureOutput({
      writeOut: (s) => out.push(s),
      writeErr: (s) => out.push(s),
    });
    cmd.commands.forEach(apply);
  };
  apply(program);

  return { program, out };
}

let rec: Recorder;

beforeEach(() => {
  rec = makeDeps();
});

describe("gateway --help", () => {
  it("lists every subcommand", async () => {
    const { program, out } = captureOutput(rec.deps);

    // exitOverride turns --help into a throw with exitCode 0 instead of exiting.
    await expect(program.parseAsync(["--help"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });

    const help = out.join("");
    expect(help).toContain("start");
    expect(help).toContain("dlq");
    expect(help).toContain("gateway");
  });

  it("shows the dlq subcommands under `dlq --help`", async () => {
    const { program, out } = captureOutput(rec.deps);

    await expect(
      program.parseAsync(["dlq", "--help"], { from: "user" })
    ).rejects.toMatchObject({ exitCode: 0 });

    const help = out.join("");
    expect(help).toContain("list");
    expect(help).toContain("replay");
  });
});

describe("gateway start — routing", () => {
  it("starts server, worker and tunnel with defaults", async () => {
    await run(rec.deps, ["start"]);

    expect(rec.deps.startServer).toHaveBeenCalledWith(3000);
    expect(rec.deps.startWorker).toHaveBeenCalledWith(2000);
    expect(rec.deps.openTunnel).toHaveBeenCalledWith(3000);
    expect(rec.registered).toHaveLength(1);
    expect(rec.registered[0].publicUrl).toBe("https://fake-tunnel.loca.lt");
  });

  it("honours --port for both the server and the tunnel", async () => {
    await run(rec.deps, ["start", "--port", "4100"]);

    expect(rec.deps.startServer).toHaveBeenCalledWith(4100);
    // The tunnel must point at the port the server actually bound, not the default.
    expect(rec.deps.openTunnel).toHaveBeenCalledWith(4100);
  });

  it("honours --poll-interval", async () => {
    await run(rec.deps, ["start", "--poll-interval", "500"]);
    expect(rec.deps.startWorker).toHaveBeenCalledWith(500);
  });

  it("skips the tunnel entirely with --no-tunnel", async () => {
    await run(rec.deps, ["start", "--no-tunnel"]);

    expect(rec.deps.startServer).toHaveBeenCalledWith(3000);
    expect(rec.deps.startWorker).toHaveBeenCalled();
    expect(rec.deps.openTunnel).not.toHaveBeenCalled();
    expect(rec.registered[0].publicUrl).toBeNull();
  });

  it("rejects a non-numeric --port instead of silently binding NaN", async () => {
    await expect(run(rec.deps, ["start", "--port", "abc"])).rejects.toThrow(/positive integer/);
    expect(rec.deps.startServer).not.toHaveBeenCalled();
  });

  it("rejects a zero or negative --port", async () => {
    await expect(run(rec.deps, ["start", "--port", "0"])).rejects.toThrow(/positive integer/);
    expect(rec.deps.startServer).not.toHaveBeenCalled();
  });
});

describe("gateway dlq — routing", () => {
  it("routes `dlq list` to the list command only", async () => {
    await run(rec.deps, ["dlq", "list"]);

    expect(rec.deps.dlqList).toHaveBeenCalledTimes(1);
    expect(rec.deps.dlqReplay).not.toHaveBeenCalled();
    // Routing to a DLQ command must never start the gateway.
    expect(rec.deps.startServer).not.toHaveBeenCalled();
    expect(rec.deps.openTunnel).not.toHaveBeenCalled();
  });

  it("routes `dlq replay <id>` with the id intact", async () => {
    await run(rec.deps, ["dlq", "replay", "6f1c9f8e-0000-4000-8000-000000000001"]);

    expect(rec.deps.dlqReplay).toHaveBeenCalledWith("6f1c9f8e-0000-4000-8000-000000000001");
    expect(rec.deps.dlqList).not.toHaveBeenCalled();
  });

  it("errors on `dlq replay` with no id instead of replaying nothing", async () => {
    await expect(run(rec.deps, ["dlq", "replay"])).rejects.toMatchObject({
      exitCode: expect.any(Number),
    });
    expect(rec.deps.dlqReplay).not.toHaveBeenCalled();
  });

  it("errors on an unknown subcommand", async () => {
    await expect(run(rec.deps, ["dlq", "nuke"])).rejects.toThrow();
    expect(rec.deps.dlqList).not.toHaveBeenCalled();
    expect(rec.deps.dlqReplay).not.toHaveBeenCalled();
  });

  it("errors on an unknown top-level command", async () => {
    await expect(run(rec.deps, ["frobnicate"])).rejects.toThrow();
    expect(rec.deps.startServer).not.toHaveBeenCalled();
  });
});

describe("runStart — tunnel failure", () => {
  it("keeps serving locally when the tunnel fails to open", async () => {
    const failing = makeDeps({
      openTunnel: vi.fn(async () => {
        throw new Error("loca.lt unreachable");
      }),
    });

    const handle = await runStart(
      { port: 3000, tunnel: true, pollInterval: 2000 },
      failing.deps
    );

    // The gateway is up; only external reachability was lost.
    expect(failing.deps.startServer).toHaveBeenCalled();
    expect(failing.deps.startWorker).toHaveBeenCalled();
    expect(handle.publicUrl).toBeNull();
    expect(failing.errors.join("\n")).toContain("loca.lt unreachable");
    expect(failing.errors.join("\n")).toContain("still serving locally");

    await handle.shutdown();
  });
});

describe("runStart — shutdown", () => {
  it("closes tunnel, server and worker", async () => {
    const handle = await runStart({ port: 3000, tunnel: true, pollInterval: 2000 }, rec.deps);

    await handle.shutdown();

    expect(rec.tunnelClose).toHaveBeenCalledTimes(1);
    expect(rec.serverClose).toHaveBeenCalledTimes(1);
    expect(rec.workerClose).toHaveBeenCalledTimes(1);
  });

  it("is idempotent, so a double Ctrl+C doesn't double-close", async () => {
    const handle = await runStart({ port: 3000, tunnel: true, pollInterval: 2000 }, rec.deps);

    await handle.shutdown();
    await handle.shutdown();

    expect(rec.tunnelClose).toHaveBeenCalledTimes(1);
    expect(rec.serverClose).toHaveBeenCalledTimes(1);
    expect(rec.workerClose).toHaveBeenCalledTimes(1);
  });

  it("still closes the server and worker when the tunnel refuses to close", async () => {
    const workerClose = vi.fn(async () => {});
    const serverClose = vi.fn(async () => {});
    const broken = makeDeps({
      startServer: vi.fn(async (port: number) => ({ port, close: serverClose })),
      startWorker: vi.fn(() => ({ close: workerClose })),
      openTunnel: vi.fn(async () => ({
        url: "https://fake-tunnel.loca.lt",
        close: vi.fn(async () => {
          throw new Error("tunnel already gone");
        }),
      })),
    });

    const handle = await runStart({ port: 3000, tunnel: true, pollInterval: 2000 }, broken.deps);
    await handle.shutdown();

    // This is the orphaned-process failure mode: one stubborn resource must not
    // leave the port bound. See Failures/orphaned-dev-server-on-port-3000.md.
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(broken.errors.join("\n")).toContain("tunnel already gone");
  });

  it("closes the server and worker when there is no tunnel at all", async () => {
    const handle = await runStart({ port: 3000, tunnel: false, pollInterval: 2000 }, rec.deps);
    await handle.shutdown();

    expect(rec.serverClose).toHaveBeenCalledTimes(1);
    expect(rec.workerClose).toHaveBeenCalledTimes(1);
    expect(rec.tunnelClose).not.toHaveBeenCalled();
  });
});

describe("formatStartupBanner", () => {
  it("shows the public URL and the exact path a sender should be pointed at", () => {
    const banner = formatStartupBanner(3000, "https://xyz.loca.lt").join("\n");

    expect(banner).toContain("Your gateway is live at: https://xyz.loca.lt");
    expect(banner).toContain("https://xyz.loca.lt/webhooks/<source>");
    expect(banner).toContain("http://localhost:3000/dashboard.html");
    expect(banner).toContain(".env.local");
  });

  it("says plainly that external senders can't reach a local-only run", () => {
    const banner = formatStartupBanner(4100, null).join("\n");

    expect(banner).toContain("http://localhost:4100");
    expect(banner).toContain("local only");
    expect(banner).toContain("External senders cannot reach this");
    // Still points at the right dashboard port.
    expect(banner).toContain("http://localhost:4100/dashboard.html");
  });
});
