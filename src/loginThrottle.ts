// Basic brute-force limit for the dashboard login. In memory and per process:
// enough to stop a script guessing at bcrypt speed, not a distributed defence.
// Failed attempts are counted per client address and across all addresses; a
// successful login clears that address's count.
export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_CLIENT = 5;
export const MAX_FAILURES_GLOBAL = 50;

const perClient = new Map<string, number[]>();
let global: number[] = [];

function recent(list: number[] | undefined, now: number): number[] {
  return (list ?? []).filter((t) => now - t < WINDOW_MS);
}

// Returns seconds to wait if the caller is blocked, otherwise 0.
export function loginRetryAfterSeconds(client: string, now = Date.now()): number {
  const mine = recent(perClient.get(client), now);
  const all = recent(global, now);
  let oldest = 0;
  if (mine.length >= MAX_FAILURES_PER_CLIENT) oldest = Math.max(oldest, mine[0]);
  if (all.length >= MAX_FAILURES_GLOBAL) oldest = Math.max(oldest, all[0]);
  return oldest === 0 ? 0 : Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

export function recordLoginFailure(client: string, now = Date.now()): void {
  const mine = recent(perClient.get(client), now);
  mine.push(now);
  perClient.set(client, mine);
  global = recent(global, now);
  global.push(now);
  // Bound memory: drop idle clients.
  if (perClient.size > 10_000) {
    for (const [k, v] of perClient) if (recent(v, now).length === 0) perClient.delete(k);
  }
}

export function recordLoginSuccess(client: string): void {
  perClient.delete(client);
}

export function resetLoginThrottle(): void {
  perClient.clear();
  global = [];
}
