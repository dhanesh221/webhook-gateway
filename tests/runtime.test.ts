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

import { startWorker } from "../src/runtime";

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
});

afterEach(() => {
  vi.useRealTimers();
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
