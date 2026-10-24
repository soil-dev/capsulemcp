/**
 * The rate-limit window Capsule has announced for this process's token
 * (see `doFetch` in ./client.ts). Kept in its own dependency-free module
 * so the test setup can reset it without importing the HTTP client —
 * importing client.ts from a vitest setup file would load the real
 * `undici` ahead of each test file's `vi.mock("undici")`.
 */

let rateLimitedUntil = 0;

/** Milliseconds left in the announced window; 0 or less when none is open. */
export function rateLimitWindowLeft(now: number = Date.now()): number {
  return rateLimitedUntil - now;
}

/** Record that Capsule rejects this token's requests until `untilMs` (epoch ms). */
export function openRateLimitWindow(untilMs: number): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, untilMs);
}

/** Test hook: forget a remembered rate-limit window. */
export function _resetRateLimitStateForTests(): void {
  rateLimitedUntil = 0;
}
