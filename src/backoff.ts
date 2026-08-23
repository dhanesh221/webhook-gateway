// Exponential backoff with full jitter (AWS's term for this formula): the delay is
// chosen uniformly at random between 0 and the exponentially-growing cap, rather than
// always using the cap itself. That spreads retries out in time instead of letting
// every failed event hammer the destination at the exact same moment.
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

// `attempt` is 0-indexed: the number of attempts already made before this one.
// `random` defaults to Math.random but accepts an override for deterministic tests.
export function computeBackoffDelay(
  attempt: number,
  random: () => number = Math.random
): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * cap);
}
