/**
 * Cache layer tests. Covers the in-process TTL cache and its
 * integration with capsuleGetCached. Three concerns:
 *
 *   1. Pure cache module behaviour (hit, miss, expiry, eviction,
 *      invalidation, env-var control).
 *   2. capsuleGetCached integration — that a second call with the
 *      same path+params is served from cache and skips fetch.
 *   3. The tags-tools invalidation path — that `add_tag` and
 *      `remove_tag_by_id` drop the relevant list_tags cache entries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { mockFetch } from "./test-helpers.js";
import {
  cacheClear,
  cacheKey,
  cacheLookup,
  cacheSet,
  cacheSize,
  cacheDisabled,
  getCacheTtlMs,
  invalidateByPrefix,
} from "../src/capsule/cache.js";

// Local convenience over cacheLookup, mirroring the old cacheGet shim
// the production code no longer carries (nothing in src/ wanted the
// reasonless form).
function cacheGet<T>(key: string) {
  const r = cacheLookup<T>(key);
  return r.hit ? r.result : undefined;
}

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  delete process.env["CAPSULE_MCP_CACHE_TTL_MS"];
  delete process.env["CAPSULE_MCP_CACHE_DISABLED"];
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_CACHE_TTL_MS"];
  delete process.env["CAPSULE_MCP_CACHE_DISABLED"];
});

// ── Pure cache module ──────────────────────────────────────────────────────

describe("cache module", () => {
  it("default TTL is 5 minutes", () => {
    expect(getCacheTtlMs()).toBe(5 * 60 * 1000);
    expect(cacheDisabled()).toBe(false);
  });

  it("CAPSULE_MCP_CACHE_TTL_MS=0 disables caching (back-compat shortcut)", () => {
    process.env["CAPSULE_MCP_CACHE_TTL_MS"] = "0";
    expect(getCacheTtlMs()).toBe(0);
    expect(cacheDisabled()).toBe(true);
  });

  it("CAPSULE_MCP_CACHE_DISABLED=1 is the canonical opt-out", () => {
    process.env["CAPSULE_MCP_CACHE_DISABLED"] = "1";
    // TTL still reads as default — disable is orthogonal.
    expect(getCacheTtlMs()).toBe(5 * 60 * 1000);
    expect(cacheDisabled()).toBe(true);
  });

  it("CAPSULE_MCP_CACHE_DISABLED accepts truthy spellings (1/true/yes/on)", () => {
    for (const truthy of ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON"]) {
      process.env["CAPSULE_MCP_CACHE_DISABLED"] = truthy;
      expect(cacheDisabled()).toBe(true);
    }
  });

  it("CAPSULE_MCP_CACHE_DISABLED ignores non-truthy values (treated as enabled)", () => {
    // "0", "false", empty, unrecognised — none of these should disable.
    for (const falsy of ["0", "false", "no", "off", "", "garbage"]) {
      process.env["CAPSULE_MCP_CACHE_DISABLED"] = falsy;
      expect(cacheDisabled()).toBe(false);
    }
  });

  it("when DISABLED=1, cacheSet is a no-op", async () => {
    process.env["CAPSULE_MCP_CACHE_DISABLED"] = "1";
    cacheSet("GET /x", { data: 1, nextPage: undefined });
    expect(cacheGet<unknown>("GET /x")).toBeUndefined();
    expect(cacheSize()).toBe(0);
  });

  it("falls back to default for malformed CAPSULE_MCP_CACHE_TTL_MS", () => {
    // Negative, non-numeric, and empty strings should not silently
    // turn into "no cache" or "cache forever" — guard at the env
    // boundary instead.
    for (const bad of ["-1", "nope", "Infinity"]) {
      process.env["CAPSULE_MCP_CACHE_TTL_MS"] = bad;
      expect(getCacheTtlMs()).toBe(5 * 60 * 1000);
    }
  });

  it("cacheKey produces stable keys regardless of param order", () => {
    const a = cacheKey("/pipelines", { page: 1, perPage: 100 });
    const b = cacheKey("/pipelines", { perPage: 100, page: 1 });
    expect(a).toBe(b);
  });

  it("cacheKey omits undefined params", () => {
    const k = cacheKey("/pipelines", { page: 1, perPage: undefined });
    expect(k).toBe("GET /pipelines?page=1");
  });

  it("cacheGet returns undefined on miss", () => {
    expect(cacheGet<unknown>("GET /missing")).toBeUndefined();
  });

  it("cacheSet then cacheGet roundtrips a result", () => {
    cacheSet("GET /x", { data: { foo: 1 }, nextPage: undefined });
    const hit = cacheGet<{ foo: number }>("GET /x");
    expect(hit?.data).toEqual({ foo: 1 });
  });

  it("expired entries are evicted on read", () => {
    // TTL of 1ms — sleep past it before reading.
    process.env["CAPSULE_MCP_CACHE_TTL_MS"] = "1";
    cacheSet("GET /x", { data: 1, nextPage: undefined });
    // Force time to advance past the entry's expiry. fake-timers
    // would be cleaner, but a tiny real-time wait is simpler and
    // deterministic at 1ms TTL + 20ms wait.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cacheGet<unknown>("GET /x")).toBeUndefined();
        resolve();
      }, 20);
    });
  });

  it("invalidateByPrefix drops matching keys", () => {
    cacheSet("GET /parties/tags", { data: 1, nextPage: undefined });
    cacheSet("GET /parties/tags?page=1", { data: 2, nextPage: undefined });
    cacheSet("GET /opportunities/tags", { data: 3, nextPage: undefined });
    invalidateByPrefix("/parties/tags");
    expect(cacheGet<unknown>("GET /parties/tags")).toBeUndefined();
    expect(cacheGet<unknown>("GET /parties/tags?page=1")).toBeUndefined();
    expect(cacheGet<unknown>("GET /opportunities/tags")).toBeDefined();
  });

  it("cacheClear empties the cache", () => {
    cacheSet("GET /a", { data: 1, nextPage: undefined });
    cacheSet("GET /b", { data: 2, nextPage: undefined });
    expect(cacheSize()).toBe(2);
    cacheClear();
    expect(cacheSize()).toBe(0);
  });

  it("cap is enforced — oldest evicted past 64 entries", () => {
    for (let i = 0; i < 65; i++) {
      cacheSet(`GET /x/${i}`, { data: i, nextPage: undefined });
    }
    expect(cacheSize()).toBeLessThanOrEqual(64);
    // The first inserted should be gone.
    expect(cacheGet<unknown>("GET /x/0")).toBeUndefined();
    // The most recent should still be there.
    expect(cacheGet<unknown>("GET /x/64")).toBeDefined();
  });
});

// ── capsuleGetCached integration ───────────────────────────────────────────

describe("capsuleGetCached", () => {
  it("serves a second call with identical args from cache (no extra fetch)", async () => {
    mockFetch(200, { pipelines: [{ id: 1, name: "Sales" }] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    const a = await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    const b = await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    expect(a).toEqual(b);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("CAPSULE_MCP_CACHE_TTL_MS=0 bypasses cache — every call hits fetch", async () => {
    process.env["CAPSULE_MCP_CACHE_TTL_MS"] = "0";
    mockFetch(200, { pipelines: [] });
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines");
    await capsuleGetCached("/pipelines");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("CAPSULE_MCP_CACHE_DISABLED=1 bypasses cache — every call hits fetch", async () => {
    process.env["CAPSULE_MCP_CACHE_DISABLED"] = "1";
    mockFetch(200, { pipelines: [] });
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines");
    await capsuleGetCached("/pipelines");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("different params produce different cache keys", async () => {
    mockFetch(200, { pipelines: [] });
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines", { page: 1 });
    await capsuleGetCached("/pipelines", { page: 2 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

// ── Tag-mutation invalidation ──────────────────────────────────────────────

describe("tag mutation invalidates list_tags cache", () => {
  it("add_tag drops the cached parties tag list", async () => {
    // First call: populate the cache.
    mockFetch(200, { tags: [{ id: 1, name: "Old" }] });
    const { listTags, addTag } = await import("../src/tools/tags.js");
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    // add_tag — should invalidate the cache for /parties/tags.
    mockFetch(200, { party: { id: 99, tags: [{ id: 2, name: "New" }] } });
    await addTag({ entity: "parties", entityId: 99, tagName: "New" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    // Third call: cache was invalidated, so this should hit fetch
    // again and see the fresh response.
    mockFetch(200, {
      tags: [
        { id: 1, name: "Old" },
        { id: 2, name: "New" },
      ],
    });
    const result = await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect((result as { tags: unknown[] }).tags).toHaveLength(2);
  });

  it("add_tag invalidates only the matching entity's tag list", async () => {
    // Populate cache for both parties and opportunities tag lists.
    mockFetch(200, { tags: [{ id: 1, name: "X" }] });
    mockFetch(200, { tags: [{ id: 2, name: "Y" }] });
    const { listTags, addTag } = await import("../src/tools/tags.js");
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    await listTags({ entity: "opportunities", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    // add_tag on a PARTY should NOT invalidate the opportunities list.
    mockFetch(200, { party: { id: 99 } });
    await addTag({ entity: "parties", entityId: 99, tagName: "Z" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);

    // Re-read opportunities tags: cached, no extra fetch.
    const oppResult = await listTags({
      entity: "opportunities",
      page: 1,
      perPage: 100,
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect((oppResult as { tags: unknown[] }).tags).toEqual([{ id: 2, name: "Y" }]);

    // Re-read parties tags: cache invalidated, hits fetch.
    mockFetch(200, {
      tags: [
        { id: 1, name: "X" },
        { id: 3, name: "Z" },
      ],
    });
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });

  it("remove_tag_by_id also invalidates the cached list", async () => {
    mockFetch(200, { tags: [{ id: 5, name: "ToRemove" }] });
    const { listTags, removeTagById } = await import("../src/tools/tags.js");
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    mockFetch(200, { party: { id: 99 } });
    await removeTagById({ entity: "parties", entityId: 99, tagId: 5 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    mockFetch(200, { tags: [] });
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("delete_tag_definition also invalidates the cached list", async () => {
    mockFetch(200, { tags: [{ id: 5, name: "Typo" }] });
    const { listTags, deleteTagDefinition } = await import("../src/tools/tags.js");
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    mockFetch(204, {});
    await deleteTagDefinition({ entity: "parties", tagId: 5, confirm: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    mockFetch(200, { tags: [] });
    await listTags({ entity: "parties", page: 1, perPage: 100 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
