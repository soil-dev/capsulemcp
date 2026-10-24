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
type WindowState = { until: number };

function state(): WindowState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: WindowState };
  g[STATE_KEY] ??= { until: 0 };
  return g[STATE_KEY];
}

/**
 * Milliseconds left in the announced window; 0 or less when none is
 * open. Clamped to the cap on read, so a wall-clock step backwards
 * cannot stretch the window past an hour.
 */
export function rateLimitWindowLeft(now: number = Date.now()): number {
  return Math.min(state().until - now, RATE_LIMIT_WINDOW_CAP_MS);
}

/** Record that Capsule rejects this token's requests until `untilMs` (epoch ms). */
export function openRateLimitWindow(untilMs: number): void {
  const s = state();
  s.until = Math.max(s.until, untilMs);
}

/** Capsule has answered a request successfully: whatever window we remembered is over. */
export function closeRateLimitWindow(): void {
  state().until = 0;
}

/** Test hook: forget a remembered rate-limit window. */
export function _resetRateLimitStateForTests(): void {
  closeRateLimitWindow();
}
