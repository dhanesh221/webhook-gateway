import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// processPendingBatch is replaced with a stub whose completion each test controls,
// so a batch can be held "in flight" for as long as the test needs. Timers are
// faked so the poll cadence is driven explicitly rather than waited on.
const mocks = vi.hoisted(() => ({
  processPendingBatch: vi.fn(),
}));

vi.mock("../src/deliveryWorker", () => ({
  processPendingBatch: mocks.processPendingBatch,
}));

vi.mock("../src/supabase", () => ({
  getSupabase: () => ({}),
}));

const retention = vi.hoisted(() => ({ runRetention: vi.fn() }));
vi.mock("../src/retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/retention")>()),
  runRetention: retention.runRetention,
}));

import { startWorker } from "../src/runtime";
import { RETENTION_INTERVAL_MS } from "../src/retention";

interface Batch {
  release(): void;
}

// Records every batch the worker starts and how many were running at once.
function trackBatches() {
  const batches: Batch[] = [];
  let running = 0;
  let maxConcurrent = 0;

  mocks.processPendingBatch.mockImplementation(
    () =>
      new Promise<unknown[]>((resolve) => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        batches.push({
          release: () => {
            running -= 1;
            resolve([]);
          },
        });
      })
  );

  return {
    batches,
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.processPendingBatch.mockReset();
  retention.runRetention.mockReset();
  retention.runRetention.mockResolvedValue({ deliveredDeleted: 0, deadLetteredDeleted: 0, sessionsDeleted: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startWorker", () => {
  it("never starts a second poll while one is still running", async () => {
    const tracker = trackBatches();
    const worker = startWorker(100);

    // Many intervals pass while the first batch is stuck in flight.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.processPendingBatch).toHaveBeenCalledTimes(1);

    // Once it completes, the next poll waits a full interval of idle time.
    tracker.batches[0].release();
    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.processPendingBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.processPendingBatch).toHaveBeenCalledTimes(2);

    expect(tracker.maxConcurrent).toBe(1);

    tracker.batches[1].release();
    await worker.close();
  });

  it("close() waits for an in-progress slow batch before resolving", async () => {
    const tracker = trackBatches();
    const worker = startWorker(100);

    // Let several intervals elapse with the first batch still running, so any
    // overlapping polls would have started and finished in the meantime.
    mocks.processPendingBatch.mockImplementation(async () => []);
    await vi.advanceTimersByTimeAsync(500);

    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toBe(false);

    tracker.batches[0].release();
    await closing;
    expect(closed).toBe(true);

    // Nothing is scheduled after shutdown.
    const callsAtClose = mocks.processPendingBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.processPendingBatch).toHaveBeenCalledTimes(callsAtClose);
  });

  it("runs retention after the first poll and then once an hour, never alongside a batch", async () => {
    mocks.processPendingBatch.mockImplementation(async () => []);
    const worker = startWorker(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(retention.runRetention).toHaveBeenCalledTimes(1);

    // Many polls, well under an hour: no second run.
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS - 1_000);
    expect(retention.runRetention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(retention.runRetention).toHaveBeenCalledTimes(2);
    expect(mocks.processPendingBatch.mock.calls.length).toBeGreaterThan(100);
    await worker.close();
  });

  it("a retention failure is logged and deliveries continue", async () => {
    mocks.processPendingBatch.mockImplementation(async () => []);
    retention.runRetention.mockRejectedValue(new Error("function purge_webhook_events does not exist"));
    const worker = startWorker(100);
    await vi.advanceTimersByTimeAsync(350);
    expect(mocks.processPendingBatch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => String(c[0]).includes("retention failed"))).toBe(true);
    await worker.close();
  });

  it("close() between polls resolves without starting another batch", async () => {
    const tracker = trackBatches();
    const worker = startWorker(100);

    tracker.batches[0].release();
    await vi.advanceTimersByTimeAsync(50);

    await worker.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.processPendingBatch).toHaveBeenCalledTimes(1);
  });
});


describe("worker rate configuration", () => {
  it("rejects invalid configuration before polling", async () => {
    vi.resetModules();
    vi.stubEnv("WG_DELIVERY_RATE_RPS", "0");
    try {
      const { startWorker: freshStartWorker } = await import("../src/runtime");
      expect(() => freshStartWorker()).toThrow("Delivery rate");
      expect(mocks.processPendingBatch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
