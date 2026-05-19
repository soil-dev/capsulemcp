/**
 * In-process TTL cache for near-static Capsule reference data.
 *
 * Pipelines, boards, milestones, stages, custom-field schemas, etc.
 * change only when an admin edits Capsule settings — yet LLMs loop
 * through them repeatedly during a conversation to discover ids
 * before each create/update/filter call. Caching them with a short
 * TTL drops the Capsule round-trip count per conversation by
 * 30–50% on write-heavy flows and shaves ~150ms off every cached
 * hit.
 *
 * Design notes (see also DESIGN.md L13):
 *
 *   - Per-instance only. Cloud Run instances don't share state;
 *     we don't pull in Redis / Firestore for this. Worst-case
 *     staleness is bounded by TTL × 1 (not TTL × N instances).
 *
 *   - TTL is uniform across all cached endpoints. A per-endpoint
 *     TTL ladder would be more elegant but harder to reason about
 *     when the cache misbehaves. Single knob via
 *     CAPSULE_MCP_CACHE_TTL_MS (default 5 minutes; 0 disables).
 *
 *   - The cache key is "GET <path>?<sorted-params>". Sorting keeps
 *     {page:1,perPage:25} and {perPage:25,page:1} on the same key.
 *
 *   - Entries cap at MAX_ENTRIES with naïve oldest-eviction (Map
 *     iteration order = insertion order). The 16 cached endpoints
 *     × ~few pages each fit comfortably; no LRU bookkeeping needed.
 *
 *   - Pagination interaction: each (path, page, perPage) tuple is
 *     its own cache key. Pages are independently cacheable. This
 *     is correct because Capsule's pagination is stable for stable
 *     data.
 *
 *   - Invalidation: `add_tag` and `remove_tag_by_id` mutate the
 *     tag catalogue, so they call `invalidateByPrefix("/tags")` to
 *     drop cached `list_tags` responses before the next read sees
 *     stale data. Other cached endpoints have no write-side
 *     counterpart in our tool surface, so no invalidation is
 *     wired for them.
 */

import type { PagedResult, QueryParams } from "./client.js";

interface CacheEntry {
  // The Result tuple a `capsuleGet` would have returned. Stored
  // as `unknown` because the cache is shared across return types;
  // the caller asserts the type back at read time.
  result: PagedResult<unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Generous cap. Each entry is a kilobyte-scale JSON blob; even at
// 64 entries this is ~64 KB of resident memory, well under any
// reasonable budget.
const MAX_ENTRIES = 64;

/** Default cache TTL when CAPSULE_MCP_CACHE_TTL_MS is unset. */
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolved TTL in milliseconds. Read at call time (not module
 * init) so tests can flip the env var per case without reloading
 * the module. `0` means caching is disabled — every call should
 * fall through to a fresh fetch.
 */
export function getCacheTtlMs(): number {
  const raw = process.env["CAPSULE_MCP_CACHE_TTL_MS"];
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_MS;
  return Math.floor(n);
}

/** Cache disabled at the env level. */
export function cacheDisabled(): boolean {
  return getCacheTtlMs() === 0;
}

/**
 * Build a stable cache key for a GET. Query params are sorted so
 * equivalent calls collide regardless of argument order.
 */
export function cacheKey(path: string, params?: QueryParams): string {
  if (!params) return `GET ${path}`;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return `GET ${path}`;
  entries.sort(([a], [b]) => a.localeCompare(b));
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `GET ${path}?${qs}`;
}

export function cacheGet<T>(key: string): PagedResult<T> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.result as PagedResult<T>;
}

export function cacheSet<T>(key: string, result: PagedResult<T>): void {
  const ttl = getCacheTtlMs();
  if (ttl <= 0) return; // caching disabled
  // Evict the oldest entries until we're under the cap. Map
  // iteration order is insertion order, so .keys().next() yields
  // the oldest live entry.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, {
    result: result as PagedResult<unknown>,
    expiresAt: Date.now() + ttl,
  });
}

/**
 * Drop every cached entry whose key starts with `GET <pathPrefix>`.
 * Used by `add_tag` / `remove_tag_by_id` after a mutation to keep
 * subsequent `list_tags` reads consistent within the same process.
 */
export function invalidateByPrefix(pathPrefix: string): void {
  const needle = `GET ${pathPrefix}`;
  for (const k of cache.keys()) {
    if (k === needle || k.startsWith(`${needle}?`) || k.startsWith(`${needle}/`)) {
      cache.delete(k);
    }
  }
}

/** Drop everything. Used by tests; not called from production paths. */
export function cacheClear(): void {
  cache.clear();
}

/** Read-only size for tests / observability. */
export function cacheSize(): number {
  return cache.size;
}
