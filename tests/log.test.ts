/**
 * Tests for the verbose-logging helper and the cache events that
 * use it. Covers:
 *
 *   - logVerbose() reads the env each call (so tests can flip mid-suite)
 *   - logEvent emits nothing when verbose is off, and JSON to stderr
 *     when verbose is on
 *   - capsuleGetCached emits cache.hit on hit (with ageMs)
 *   - capsuleGetCached emits cache.miss with reason="empty" on cold miss
 *   - capsuleGetCached emits cache.miss with reason="expired" after TTL
 *   - tag-mutation invalidation emits cache.invalidate with trigger label
 *   - capacity overflow emits cache.evict
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { cacheClear, cacheSet, cacheSize, invalidateByPrefix } from "../src/capsule/cache.js";
import { logEvent, logVerbose } from "../src/log.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

// Spy on stderr writes. Capture the raw bytes so we can parse each
// emitted line back into JSON in tests.
let stderrLines: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
  delete process.env["CAPSULE_MCP_CACHE_DISABLED"];
  delete process.env["CAPSULE_MCP_CACHE_TTL_MS"];
  stderrLines = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    if (typeof chunk === "string") stderrLines.push(chunk);
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
  delete process.env["CAPSULE_MCP_CACHE_DISABLED"];
  delete process.env["CAPSULE_MCP_CACHE_TTL_MS"];
});

function emitted(): Array<Record<string, unknown>> {
  return stderrLines
    .flatMap((s) => s.split("\n"))
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

// ── logEvent helper ────────────────────────────────────────────────────────

describe("logEvent", () => {
  it("emits nothing when CAPSULE_MCP_LOG_VERBOSE is unset", () => {
    expect(logVerbose()).toBe(false);
    logEvent("test.event", { foo: "bar" });
    expect(emitted()).toEqual([]);
  });

  it("emits JSON to stderr when CAPSULE_MCP_LOG_VERBOSE=1", () => {
    process.env["CAPSULE_MCP_LOG_VERBOSE"] = "1";
    expect(logVerbose()).toBe(true);
    logEvent("test.event", { foo: "bar" });
    const events = emitted();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "test.event", foo: "bar" });
    expect(events[0]).toHaveProperty("timestamp");
  });

  it("accepts truthy spellings 1 / true / yes / on (case-insensitive)", () => {
    for (const truthy of ["1", "true", "TRUE", "yes", "ON"]) {
      process.env["CAPSULE_MCP_LOG_VERBOSE"] = truthy;
      expect(logVerbose()).toBe(true);
    }
  });

  it("treats 0 / false / unrecognised as 'off'", () => {
    for (const falsy of ["0", "false", "no", "off", "garbage", ""]) {
      process.env["CAPSULE_MCP_LOG_VERBOSE"] = falsy;
      expect(logVerbose()).toBe(false);
    }
  });
});

// ── cache events via capsuleGetCached ──────────────────────────────────────

describe("cache events when CAPSULE_MCP_LOG_VERBOSE=1", () => {
  beforeEach(() => {
    process.env["CAPSULE_MCP_LOG_VERBOSE"] = "1";
  });

  it("emits cache.miss with reason='empty' on the first call", async () => {
    mockFetch(200, { pipelines: [{ id: 1 }] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    const cacheEvents = emitted().filter((e) => String(e["event"]).startsWith("cache."));
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0]).toMatchObject({
      event: "cache.miss",
      path: "/pipelines",
      reason: "empty",
    });
    expect(cacheEvents[0]).toHaveProperty("latencyMs");
  });

  it("emits cache.hit on the second identical call (with ageMs)", async () => {
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    stderrLines.length = 0; // clear the miss event
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    const cacheEvents = emitted().filter((e) => String(e["event"]).startsWith("cache."));
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0]).toMatchObject({
      event: "cache.hit",
      path: "/pipelines",
    });
    expect(typeof cacheEvents[0]?.["ageMs"]).toBe("number");
  });

  it("emits cache.miss with reason='expired' after TTL", async () => {
    process.env["CAPSULE_MCP_CACHE_TTL_MS"] = "1";
    mockFetch(200, { pipelines: [] });
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    // Wait past TTL.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    stderrLines.length = 0;
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    const cacheEvents = emitted().filter((e) => String(e["event"]).startsWith("cache."));
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0]).toMatchObject({
      event: "cache.miss",
      path: "/pipelines",
      reason: "expired",
    });
  });

  it("emits cache.invalidate with trigger label and droppedCount", () => {
    cacheSet("GET /parties/tags", { data: 1, nextPage: undefined });
    cacheSet("GET /parties/tags?page=1", { data: 2, nextPage: undefined });
    invalidateByPrefix("/parties/tags", "add_tag");
    const cacheEvents = emitted().filter((e) => e["event"] === "cache.invalidate");
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0]).toMatchObject({
      event: "cache.invalidate",
      prefix: "/parties/tags",
      trigger: "add_tag",
      droppedCount: 2,
    });
  });

  it("does NOT emit cache.invalidate when no keys matched", () => {
    invalidateByPrefix("/never-cached");
    const cacheEvents = emitted().filter((e) => e["event"] === "cache.invalidate");
    expect(cacheEvents).toHaveLength(0);
  });

  it("emits cache.evict when the cap is exceeded", () => {
    cacheClear();
    // The cap is 64; fill past it.
    for (let i = 0; i < 65; i++) {
      cacheSet(`GET /x/${i}`, { data: i, nextPage: undefined });
    }
    const evictions = emitted().filter((e) => e["event"] === "cache.evict");
    // One eviction event per overflow; we exceeded the cap by 1.
    expect(evictions.length).toBeGreaterThanOrEqual(1);
    expect(evictions[0]).toMatchObject({ event: "cache.evict", reason: "cap" });
    expect(cacheSize()).toBeLessThanOrEqual(64);
  });
});

// ── cache events when verbose is off ───────────────────────────────────────

describe("no cache events when CAPSULE_MCP_LOG_VERBOSE is unset", () => {
  it("capsuleGetCached emits nothing", async () => {
    mockFetch(200, { pipelines: [] });
    const { capsuleGetCached } = await import("../src/capsule/client.js");
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    await capsuleGetCached("/pipelines", { page: 1, perPage: 100 });
    expect(emitted().filter((e) => String(e["event"]).startsWith("cache."))).toEqual([]);
  });

  it("invalidateByPrefix emits nothing", () => {
    cacheSet("GET /parties/tags", { data: 1, nextPage: undefined });
    invalidateByPrefix("/parties/tags", "add_tag");
    expect(emitted().filter((e) => String(e["event"]).startsWith("cache."))).toEqual([]);
  });
});
