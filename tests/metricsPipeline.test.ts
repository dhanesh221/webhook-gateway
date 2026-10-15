import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import signedRequest, { TEST_SOURCE_SECRET } from "./signedRequest";
import { makeFakeSupabase } from "./fakeSupabase";
const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock("../src/supabase", () => ({ getSupabase: () => holder.client }));
import { app } from "../src/app";
import { processPendingBatch } from "../src/deliveryWorker";
import { TokenBuckets } from "../src/rateLimit";
import { gatewayMetrics, metricLabel, MAX_METRIC_ROUTES } from "../src/metrics";
const total = (text: string, kind: string) => BigInt(text.match(new RegExp(`^webhook_events_${kind}_total (\\d+)$`, "m"))![1]);
let receiver: http.Server | undefined;
afterEach(async () => { if (receiver) await new Promise<void>((resolve, reject) => receiver!.close(e => e ? reject(e) : resolve())); receiver = undefined; vi.unstubAllEnvs(); });

describe("metrics real HTTP pipeline and worst-cap scrapes", () => {
  it("tracks signed ingest, duplicate, two real HTTP failures then success, and scrape", async () => {
    let calls = 0; const bodies: string[] = [];
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => { bodies.push(Buffer.concat(chunks).toString()); calls++; res.writeHead(calls < 3 ? 503 : 200); res.end(); });
    });
    await new Promise<void>(resolve => receiver!.listen(0, "127.0.0.1", resolve));
    const destination = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/private?token=never-print`;
    const db = makeFakeSupabase([], { failureThreshold: 100 }); holder.client = db.client;
    db.sources.set("test", { name: "test", destination_url: destination, secret_env: "WG_SOURCE_TEST_SECRET", enabled: true });
    vi.stubEnv("WG_SOURCE_TEST_SECRET", TEST_SOURCE_SECRET); vi.stubEnv("NODE_ENV", "test");
    const token = "real-http-probe-scrape-token-at-least-32-bytes"; vi.stubEnv("WG_METRICS_TOKEN", token);
    const before = gatewayMetrics.render(); const raw = '{"id":9007199254740993,"secret":"payload-private"}';
    for (const expected of [202, 200]) expect((await signedRequest(app).post("/webhooks/test").set("Idempotency-Key", "same").set("Content-Type", "application/json").send(raw)).status).toBe(expected);
    const limiter = new TokenBuckets({ rps: 100, burst: 100 });
    for (let i = 0; i < 4; i++) await processPendingBatch(db.client, undefined, limiter);
    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200); expect(calls).toBe(3); expect(bodies).toEqual([raw, raw, raw]);
    for (const [kind, delta] of [["received",1n],["delivered",1n],["failed",2n],["retried",2n],["dead_lettered",0n]] as const) expect(total(res.text,kind)-total(before,kind)).toBe(delta);
    expect(res.text).toContain(`source_id="${metricLabel("test")}",destination_id="${metricLabel(destination)}"`);
    for (const secret of ["payload-private", "never-print", "9007199254740993"]) expect(res.text).not.toContain(secret);
  });
  it("serves 50 concurrent worst-cap scrapes while counters remain stable", async () => {
    vi.stubEnv("WG_METRICS_TOKEN", "load-test-scrape-token-at-least-32-characters");
    for (let i = 0; i < MAX_METRIC_ROUTES + 100; i++) gatewayMetrics.increment("received", `src-${i}`, `https://host/${i}`);
    const expected = gatewayMetrics.render(); const started = performance.now();
    const responses = await Promise.all(Array.from({ length: 50 }, () => request(app).get("/metrics").set("Authorization", "Bearer load-test-scrape-token-at-least-32-characters")));
    expect(responses.every(r => r.status === 200 && r.text === expected)).toBe(true);
    console.log(`Worst-cap 50 concurrent scrapes: ${Buffer.byteLength(expected)} bytes each, ${(performance.now()-started).toFixed(1)} ms total on this machine`);
  });
});
