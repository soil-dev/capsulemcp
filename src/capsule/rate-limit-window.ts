/**
 * The rate-limit window Capsule has announced for this process's token
 * (see `doFetch` in ./client.ts). Kept in its own dependency-free module
 * so the test setup can reset it without importing the HTTP client —
 * importing client.ts from a vitest setup file would load the real
 * `undici` ahead of each test file's `vi.mock("undici")`.
 *
 * The state lives on `globalThis` under a registered symbol so every
 * copy of this module shares it: test suites that call
 * `vi.resetModules()` get fresh module instances, and per-instance state
 * would let a window opened in one test leak past the global reset.
 */

/** Capsule's quota window is one hour; no honest wait is longer. */
export const RATE_LIMIT_WINDOW_CAP_MS = 61 * 60_000;

const STATE_KEY = Symbol.for("capsulemcp.rateLimitWindow");
type WindowState = { until: number; openedAt: number };

function state(): WindowState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: WindowState };
  g[STATE_KEY] ??= { until: 0, openedAt: 0 };
  return g[STATE_KEY];
}

/**
 * Milliseconds left in the announced window; 0 or less when none is
 * open. If the wall clock has stepped backwards so far that more than
 * the cap appears to be left, the deadline itself is pulled in — so the
 * window can never last longer than the cap from now.
 */
export function rateLimitWindowLeft(now: number = Date.now()): number {
  const s = state();
  if (s.until - now > RATE_LIMIT_WINDOW_CAP_MS) s.until = now + RATE_LIMIT_WINDOW_CAP_MS;
  return s.until - now;
}

/** Record that Capsule rejects this token's requests until `untilMs` (epoch ms). */
export function openRateLimitWindow(untilMs: number, now: number = Date.now()): void {
  const s = state();
  if (untilMs > s.until) {
    s.until = untilMs;
    s.openedAt = now;
  }
}

/**
 * Capsule served a request that was SENT at `sentAt`: a window opened
 * before then is over. A window opened after the request left (e.g. a
 * tool call's 429 while a slow health probe was in flight) stays — the
 * success says nothing about the quota after it was served.
 */
export function closeRateLimitWindow(sentAt: number = Number.POSITIVE_INFINITY): void {
  const s = state();
  if (s.openedAt <= sentAt) s.until = 0;
}

/** Test hook: forget a remembered rate-limit window. */
export function _resetRateLimitStateForTests(): void {
  const s = state();
  s.until = 0;
  s.openedAt = 0;
}
