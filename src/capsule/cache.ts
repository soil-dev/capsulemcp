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
 *   - Invalidation: `add_tag`, `remove_tag_by_id`, and
 *     `delete_tag_definition` mutate the tag catalogue, so they call
 *     `invalidateByPrefix("/<entity>/tags")` to drop cached
 *     `list_tags` responses before the next read sees stale data.
 *     Other cached endpoints have no write-side counterpart in our
 *     tool surface, so no invalidation is wired for them.
 */

import { readBool, readPositiveInt } from "../env.js";
import { logEvent, redactPath } from "../log.js";
import type { PagedResult, QueryParams } from "./client.js";

interface CacheEntry {
  // The Result tuple a `capsuleGet` would have returned. Stored
  // as `unknown` because the cache is shared across return types;
  // the caller asserts the type back at read time.
  result: PagedResult<unknown>;
  // Wall-clock when this entry was created. Needed for the `ageMs`
  // field on cache.hit events — `expiresAt - TTL` would be wrong
  // if the TTL env var changed between insert and read.
  storedAt: number;
  expiresAt: number;
}

/**
 * Discriminated result for cache lookups: `hit` with `ageMs` on
 * hit; `reason` ("empty" vs "expired") on miss, so the caller can
 * log why the cache didn't serve.
 */
export type CacheLookupResult<T> =
  | { hit: true; result: PagedResult<T>; ageMs: number }
  | { hit: false; reason: "empty" | "expired" };

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
 * the module. The TTL governs cached-entry lifetime when caching
 * is enabled; setting it to `0` is also honoured as a back-compat
 * shortcut for "disable caching entirely". The canonical opt-out
 * is `CAPSULE_MCP_CACHE_DISABLED=1` — separates "how long to keep
 * entries" from "should we cache at all".
 */
export function getCacheTtlMs(): number {
  // Cache uses `min=0` because a TTL of 0 is the back-compat
  // "disable caching" shortcut. The shared readPositiveInt uses
  // `min=1` by default, so we override here.
  return readPositiveInt("CAPSULE_MCP_CACHE_TTL_MS", DEFAULT_TTL_MS, 0);
}

/**
 * True when the operator has explicitly disabled caching via
 * `CAPSULE_MCP_CACHE_DISABLED`. Accepts the standard truthy
 * spellings (`1` / `true` / `yes` / `on`, case-insensitive).
 * Anything else (including unset) leaves the cache enabled.
 */
function explicitlyDisabled(): boolean {
  return readBool("CAPSULE_MCP_CACHE_DISABLED");
}

/**
 * Cache disabled at the env level. Either the explicit opt-out flag
 * (`CAPSULE_MCP_CACHE_DISABLED=1`) or the back-compat shortcut
 * (`CAPSULE_MCP_CACHE_TTL_MS=0`) bypasses the cache. The flag is the
 * canonical, more readable choice — the TTL knob should stay
 * focused on "how long to keep entries when we ARE caching".
 */
export function cacheDisabled(): boolean {
  return explicitlyDisabled() || getCacheTtlMs() === 0;
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

/**
 * Rich lookup returning a discriminated result (`hit` with `ageMs`
 * on hit; `reason` on miss). Used by `capsuleGetCached` so it can
 * emit cache.hit / cache.miss events with the right reason.
 */
export function cacheLookup<T>(key: string): CacheLookupResult<T> {
  const entry = cache.get(key);
  if (!entry) return { hit: false, reason: "empty" };
  const now = Date.now();
  if (entry.expiresAt < now) {
    cache.delete(key);
    return { hit: false, reason: "expired" };
  }
  return { hit: true, result: entry.result as PagedResult<T>, ageMs: now - entry.storedAt };
}

export function cacheSet<T>(key: string, result: PagedResult<T>): void {
  if (cacheDisabled()) return;
  const ttl = getCacheTtlMs();
  // Evict the oldest entries until we're under the cap. Map
  // iteration order is insertion order, so .keys().next() yields
  // the oldest live entry. Emit an event per eviction so capacity
  // pressure is visible in the logs — under normal load this
  // should be zero.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    // `oldest` is the cache key in `GET <path>?<sorted-params>`
    // form. Redact the path (`/parties/123` → `/parties/:id`) and
    // drop the query string so we don't leak record IDs or search
    // terms into operator logs.
    const evictedKey = `GET ${redactPath(oldest.replace(/^GET /, ""))}`;
    logEvent("cache.evict", { evictedKey, cacheSize: cache.size, reason: "cap" });
  }
  const now = Date.now();
  cache.set(key, {
    result: result as PagedResult<unknown>,
    storedAt: now,
    expiresAt: now + ttl,
  });
}

/**
 * Drop every cached entry whose key starts with `GET <pathPrefix>`.
 * Used by tag mutations after a write to keep subsequent `list_tags`
 * reads consistent within the same process.
 * `trigger` identifies the caller (e.g. "add_tag") for log diagnostics.
 */
export function invalidateByPrefix(pathPrefix: string, trigger?: string): void {
  const needle = `GET ${pathPrefix}`;
  let droppedCount = 0;
  for (const k of cache.keys()) {
    if (k === needle || k.startsWith(`${needle}?`) || k.startsWith(`${needle}/`)) {
      cache.delete(k);
      droppedCount++;
    }
  }
  if (droppedCount > 0) {
    logEvent("cache.invalidate", {
      prefix: pathPrefix,
      droppedCount,
      cacheSize: cache.size,
      ...(trigger ? { trigger } : {}),
    });
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
