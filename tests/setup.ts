/**
 * Global vitest setup — runs before every test in every file.
 *
 * Clears per-process state between tests: the reference-data cache
 * (src/capsule/cache.ts) and the remembered rate-limit window
 * (src/capsule/rate-limit-window.ts — shared via globalThis, so this
 * reset also reaches module copies loaded after vi.resetModules()). Without it, a cache
 * write from one test would survive into the next and cause
 * "expected 1 fetch call, got 0" failures because the second test
 * was served by the cache.
 *
 * Add more cross-cutting test concerns here as they come up.
 */

import { beforeEach } from "vitest";
import { cacheClear } from "../src/capsule/cache.js";
import { _resetRateLimitStateForTests } from "../src/capsule/rate-limit-window.js";

beforeEach(() => {
  cacheClear();
  // A far-future 429 in one test opens a fail-fast window that would
  // otherwise turn every later Capsule call in the file into a 429.
  _resetRateLimitStateForTests();
});
