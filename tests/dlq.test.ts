import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("../src/supabase", () => ({
  getSupabase: () => ({ rpc: mocks.rpc }),
}));

import { list, replay } from "../src/dlq";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dlq list", () => {
  it("prints dead-lettered events", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({
      data: [
        {
          id: "evt-1",
          source: "stripe",
          attempts: 5,
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      ],
      error: null,
    });

    await list();

    expect(mocks.rpc).toHaveBeenCalledWith("list_dead_lettered_events", { p_limit: 50 });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("evt-1");
    expect(output).toContain("stripe");

    logSpy.mockRestore();
  });

  it("reports when there are no dead-lettered events", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    await list();

    expect(logSpy).toHaveBeenCalledWith("No dead-lettered events.");
    logSpy.mockRestore();
  });
});

describe("dlq replay", () => {
  it("resets a dead-lettered event to pending", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "list_dead_lettered_events") {
        return { data: [{ id: "evt-1", source: "stripe", attempts: 5, updated_at: "x" }], error: null };
      }
      if (fn === "replay_webhook_event") {
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    await replay("evt-1");

    expect(mocks.rpc).toHaveBeenCalledWith("replay_webhook_event", { p_id: "evt-1" });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Event evt-1 replayed")
    );
    logSpy.mockRestore();
  });

  it("reports a clear not-found message and never calls replay_webhook_event", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ data: [], error: null }); // nothing dead-lettered

    await replay("does-not-exist");

    expect(mocks.rpc).not.toHaveBeenCalledWith("replay_webhook_event", expect.anything());
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not dead-lettered")
    );
    errorSpy.mockRestore();
  });

  it("prints usage when no id is given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await replay(undefined);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
    errorSpy.mockRestore();
  });
});
