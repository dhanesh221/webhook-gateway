import { describe, it, expect, vi, afterEach } from "vitest";
import { processPendingBatch } from "../src/deliveryWorker";
import { makeFakeSupabase } from "./fakeSupabase";

const raw = '{ "id":12345678901234567890 }';
const row = (id: string) => ({ id, source: "s", attempts: 2, payload: JSON.parse(raw), destination_url: "https://d.example/h" });
afterEach(() => vi.restoreAllMocks());

describe("raw-body read failures", () => {
  it.each(["database error", "thrown connection error"])("releases the entire batch without delivering on %s, then retries exact bytes", async (failure) => {
    const f = makeFakeSupabase([row("one"), row("two")]);
    for (const r of f.table.values()) r.raw_body = raw;
    const read = vi.spyOn(f.client, "from").mockImplementationOnce(() => ({
      select: () => ({ in: async () => {
        if (failure === "thrown connection error") throw new Error("ECONNRESET");
        return { data: null, error: { message: "read failed" } };
      } }),
    }) as never);
    const rpc = vi.spyOn(f.client, "rpc");
    const deliver = vi.fn(async (_url: string, _payload: unknown, _rawBody?: string | null) => ({ ok: true }));
    const out = await processPendingBatch(f.client, deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(out).toEqual(["one", "two"].map(id => ({ id, outcome: "released", attempt: 2 })));
    for (const r of f.table.values()) {
      expect(r.status).toBe("pending");
      expect(r.attempts).toBe(2);
    }
    expect(rpc.mock.calls.map(c => c[0])).not.toContain("record_delivery_failure");
    expect(rpc.mock.calls.map(c => c[0])).not.toContain("mark_webhook_event_delivered");
    read.mockRestore();
    await processPendingBatch(f.client, deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith("https://d.example/h", JSON.parse(raw), raw, expect.objectContaining({ "X-Webhook-Event-Id": expect.any(String) }));
  });

  it("releases a missing read result instead of treating it as legacy NULL", async () => {
    const f = makeFakeSupabase([row("missing"), row("readable")]);
    vi.spyOn(f.client, "from").mockImplementationOnce(() => ({
      select: () => ({ in: async () => ({ data: [{ id: "readable", raw_body: raw }], error: null }) }),
    }) as never);
    const deliver = vi.fn(async (_url: string, _payload: unknown, _rawBody?: string | null) => ({ ok: true }));
    const out = await processPendingBatch(f.client, deliver);
    expect(out.map(r => r.outcome)).toEqual(["released", "delivered"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(f.table.get("missing")!.attempts).toBe(2);
    expect(f.table.get("missing")!.status).toBe("pending");
  });

  it("uses the legacy fallback only for an explicit NULL, not an absent body", async () => {
    const f = makeFakeSupabase([row("legacy"), row("absent"), row("empty")]);
    vi.spyOn(f.client, "from").mockImplementationOnce(() => ({
      select: () => ({ in: async () => ({ data: [
        { id: "legacy", raw_body: null }, { id: "absent" }, { id: "empty", raw_body: "" },
      ], error: null }) }),
    }) as never);
    const deliver = vi.fn(async (_url: string, _payload: unknown, _rawBody?: string | null) => ({ ok: true }));
    const out = await processPendingBatch(f.client, deliver);
    expect(out.map(r => r.outcome)).toEqual(["delivered", "released", "delivered"]);
    expect(deliver.mock.calls.map(c => c[2])).toEqual([null, ""]);
  });

  it("continues releasing later rows if a release fails, leaving the stuck row for stale recovery", async () => {
    const f = makeFakeSupabase([row("one"), row("two")]);
    vi.spyOn(f.client, "from").mockImplementationOnce(() => ({
      select: () => ({ in: async () => ({ data: null, error: { message: "offline" } }) }),
    }) as never);
    const orig = f.client.rpc.bind(f.client);
    vi.spyOn(f.client, "rpc").mockImplementation(((fn: string, args?: Record<string, unknown>) => {
      if (fn === "mark_webhook_event_skipped" && args?.p_id === "one") return Promise.resolve({ error: { message: "release failed" } });
      return orig(fn, args);
    }) as never);
    const deliver = vi.fn(async (_url: string, _payload: unknown, _rawBody?: string | null) => ({ ok: true }));
    await processPendingBatch(f.client, deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(f.table.get("one")!.status).toBe("in_progress");
    expect(f.table.get("two")!.status).toBe("pending");
    expect(f.table.get("one")!.attempts).toBe(2);
  });
});
