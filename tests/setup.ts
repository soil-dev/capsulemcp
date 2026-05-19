/**
 * Global vitest setup — runs before every test in every file.
 *
 * Right now this exists to clear the per-process reference-data
 * cache (src/capsule/cache.ts) between tests. Without it, a cache
 * write from one test would survive into the next and cause
 * "expected 1 fetch call, got 0" failures because the second test
 * was served by the cache.
 *
 * Add more cross-cutting test concerns here as they come up.
 */

import { beforeEach } from "vitest";
import { cacheClear } from "../src/capsule/cache.js";

beforeEach(() => {
  cacheClear();
});
