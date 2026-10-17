import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "./fakeSupabase";
import {
  runRetention, retentionPolicyFromEnv, describeRetention, PURGE_BATCH,
  DEFAULT_DELIVERED_DAYS, DEFAULT_DEAD_LETTERED_DAYS,
} from "../src/retention";
import { buildProgram, realDeps } from "../src/cli";

const DAY = 24 * 60 * 60 * 1000;

function seed(fake: ReturnType<typeof makeFakeSupabase>, id: string, status: string, ageDays: number) {
  fake.table.set(id, { id, source: "s", attempts: 0, payload: {}, destination_url: "https://d.invalid/",
    status, updated_at: Date.now() - ageDays * DAY });
}

describe("retention policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to 30 days delivered, 90 days dead-lettered", () => {
    expect(retentionPolicyFromEnv()).toEqual({ deliveredDays: DEFAULT_DELIVERED_DAYS, deadLetteredDays: DEFAULT_DEAD_LETTERED_DAYS });
  });
  it("reads the environment, allows fractions and 0, and ignores garbage", () => {
    vi.stubEnv("WG_RETAIN_DELIVERED_DAYS", "0.5");
    vi.stubEnv("WG_RETAIN_DEAD_LETTERED_DAYS", "0");
    expect(retentionPolicyFromEnv()).toEqual({ deliveredDays: 0.5, deadLetteredDays: 0 });
    vi.stubEnv("WG_RETAIN_DELIVERED_DAYS", "-3");
    vi.stubEnv("WG_RETAIN_DEAD_LETTERED_DAYS", "soon");
    expect(retentionPolicyFromEnv()).toEqual({ deliveredDays: DEFAULT_DELIVERED_DAYS, deadLetteredDays: DEFAULT_DEAD_LETTERED_DAYS });
  });
});

describe("runRetention", () => {
  let fake: ReturnType<typeof makeFakeSupabase>;
  beforeEach(() => { fake = makeFakeSupabase([]); });

  it("purges only finished events past their age, never queued work", async () => {
    seed(fake, "old-delivered", "delivered", 31);
    seed(fake, "new-delivered", "delivered", 29);
    seed(fake, "old-dead", "dead_lettered", 91);
    seed(fake, "new-dead", "dead_lettered", 89);
    seed(fake, "old-pending", "pending", 400);
    seed(fake, "old-in-progress", "in_progress", 400);
    seed(fake, "old-failed", "failed", 400);

    const result = await runRetention(fake.client, { deliveredDays: 30, deadLetteredDays: 90 });
    expect(result).toEqual({ deliveredDeleted: 1, deadLetteredDeleted: 1, sessionsDeleted: 0 });
    expect([...fake.table.keys()].sort()).toEqual(["new-dead", "new-delivered", "old-failed", "old-in-progress", "old-pending"]);
  });

  it("0 keeps a status forever", async () => {
    seed(fake, "d", "delivered", 1000);
    seed(fake, "x", "dead_lettered", 1000);
    expect(await runRetention(fake.client, { deliveredDays: 0, deadLetteredDays: 90 }))
      .toMatchObject({ deliveredDeleted: 0, deadLetteredDeleted: 1 });
    expect(fake.table.has("d")).toBe(true);
    const rpc = vi.spyOn(fake.client, "rpc");
    await runRetention(fake.client, { deliveredDays: 0, deadLetteredDays: 0 });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["purge_dashboard_sessions"]); // events RPC skipped entirely
  });

  it("keeps purging in batches until a pass comes back short", async () => {
    for (let i = 0; i < PURGE_BATCH + 7; i++) seed(fake, `d-${i}`, "delivered", 40);
    const rpc = vi.spyOn(fake.client, "rpc");
    const result = await runRetention(fake.client, { deliveredDays: 30, deadLetteredDays: 90 });
    expect(result.deliveredDeleted).toBe(PURGE_BATCH + 7);
    expect(rpc.mock.calls.filter((c) => c[0] === "purge_webhook_events")).toHaveLength(2);
    expect(fake.table.size).toBe(0);
  });

  it("removes expired and revoked sessions", async () => {
    fake.sessions.set("live", { expires: Date.now() + 1000, revoked: false });
    fake.sessions.set("expired", { expires: Date.now() - 1000, revoked: false });
    fake.sessions.set("revoked", { expires: Date.now() + 1000, revoked: true });
    const result = await runRetention(fake.client, { deliveredDays: 0, deadLetteredDays: 0 });
    expect(result.sessionsDeleted).toBe(2);
    expect([...fake.sessions.keys()]).toEqual(["live"]);
  });

  it("surfaces a database error instead of reporting success", async () => {
    vi.spyOn(fake.client, "rpc").mockResolvedValue({ data: null, error: { message: "function does not exist" } } as never);
    await expect(runRetention(fake.client, { deliveredDays: 30, deadLetteredDays: 90 })).rejects.toThrow(/purge_webhook_events failed/);
  });

  it("describes the outcome for logs", () => {
    expect(describeRetention({ deliveredDays: 30, deadLetteredDays: 0 }, { deliveredDeleted: 2, deadLetteredDeleted: 0, sessionsDeleted: 1 }))
      .toBe("retention: delivered kept 30d (2 purged), dead-lettered kept forever (0 purged), 1 stale sessions removed");
  });
});

describe("gateway retention purge", () => {
  it("uses the environment policy, overridden by flags, and reports the result", async () => {
    const log = vi.fn();
    const runRetentionMock = vi.fn(async () => ({ deliveredDeleted: 3, deadLetteredDeleted: 0, sessionsDeleted: 0 }));
    vi.stubEnv("WG_RETAIN_DELIVERED_DAYS", "7");
    await buildProgram({ ...realDeps, log, runRetention: runRetentionMock })
      .parseAsync(["node", "gateway", "retention", "purge", "--dead-lettered-days", "0"]);
    expect(runRetentionMock).toHaveBeenCalledWith({ deliveredDays: 7, deadLetteredDays: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("delivered kept 7d (3 purged)"));
    vi.unstubAllEnvs();
  });

  it("rejects a negative or non-numeric age", async () => {
    const program = buildProgram({ ...realDeps, log: vi.fn(), error: vi.fn(), runRetention: vi.fn() });
    program.configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(["node", "gateway", "retention", "purge", "--delivered-days", "-1"])).rejects.toThrow();
  });
});
