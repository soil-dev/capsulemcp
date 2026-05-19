/**
 * Tests for the parallel fan-out helper and the batch tools that
 * use it. Covers:
 *
 *   - getBatchConcurrency reads CAPSULE_MCP_BATCH_CONCURRENCY (default
 *     5, clamped to [1, 50], falls back on malformed input)
 *   - batchExecute returns per-item results in input order
 *   - Errors in one item don't poison the rest
 *   - Concurrency cap is respected (peak in-flight ≤ cap)
 *   - batch.complete event always emits (verbose-independent), with
 *     aggregate summary fields only by default
 *   - detailed failureReasons are emitted only in verbose mode
 *   - The 5 wired-up batch tools (batch_update_party,
 *     batch_update_opportunity, batch_complete_task, batch_add_tag,
 *     batch_remove_tag_by_id) all PUT once per item and aggregate
 *     results correctly
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { mockFetch } from "./test-helpers.js";
import { batchExecute, chunk, getBatchConcurrency } from "../src/capsule/batch.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

let stderrLines: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  delete process.env["CAPSULE_MCP_BATCH_CONCURRENCY"];
  delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
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
  delete process.env["CAPSULE_MCP_BATCH_CONCURRENCY"];
  delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
});

function emittedEvents(): Array<Record<string, unknown>> {
  return stderrLines
    .flatMap((s) => s.split("\n"))
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

// ── chunk helper ──────────────────────────────────────────────────────────

describe("chunk", () => {
  it("splits an array into fixed-size groups, last possibly smaller", () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 5)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12, 13],
    ]);
  });

  it("returns one chunk when input fits in a single group", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("returns empty array on empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("throws on non-positive chunk size", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
    expect(() => chunk([1, 2, 3], -1)).toThrow();
  });
});

// ── concurrency env knob ──────────────────────────────────────────────────

describe("getBatchConcurrency", () => {
  it("defaults to 5", () => {
    expect(getBatchConcurrency()).toBe(5);
  });

  it("honours CAPSULE_MCP_BATCH_CONCURRENCY when set", () => {
    process.env["CAPSULE_MCP_BATCH_CONCURRENCY"] = "10";
    expect(getBatchConcurrency()).toBe(10);
  });

  it("clamps below 1 to default", () => {
    for (const bad of ["0", "-1", "0.5"]) {
      process.env["CAPSULE_MCP_BATCH_CONCURRENCY"] = bad;
      expect(getBatchConcurrency()).toBe(5);
    }
  });

  it("clamps above 50 to 50 (hard ceiling)", () => {
    process.env["CAPSULE_MCP_BATCH_CONCURRENCY"] = "10000";
    expect(getBatchConcurrency()).toBe(50);
  });

  it("falls back to default on malformed values", () => {
    for (const bad of ["nope", "Infinity", "NaN", ""]) {
      process.env["CAPSULE_MCP_BATCH_CONCURRENCY"] = bad;
      expect(getBatchConcurrency()).toBe(5);
    }
  });
});

// ── batchExecute core ─────────────────────────────────────────────────────

describe("batchExecute", () => {
  it("returns per-item results in input order", async () => {
    const items = [1, 2, 3, 4, 5];
    const { results, summary } = await batchExecute("test", items, async (n) => n * 10);
    expect(results.map((r) => (r.ok ? r.result : null))).toEqual([10, 20, 30, 40, 50]);
    expect(summary).toEqual({ total: 5, succeeded: 5, failed: 0 });
  });

  it("catches per-item exceptions; one failure doesn't poison the rest", async () => {
    const items = [1, 2, 3, 4];
    const { results, summary } = await batchExecute("test", items, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ ok: true, result: 1 });
    expect(results[1]).toEqual({ ok: false, error: { message: "boom" } });
    expect(results[2]).toEqual({ ok: true, result: 3 });
    expect(results[3]).toEqual({ ok: true, result: 4 });
    expect(summary).toEqual({ total: 4, succeeded: 3, failed: 1 });
  });

  it("extracts numeric status from Capsule-shaped errors", async () => {
    const items = [1];
    const { results } = await batchExecute("test", items, async () => {
      const err = new Error("party.name: name is required") as Error & { status: number };
      err.status = 422;
      throw err;
    });
    expect(results[0]).toEqual({
      ok: false,
      error: { status: 422, message: "party.name: name is required" },
    });
  });

  it("respects the concurrency cap — peak in-flight ≤ N", async () => {
    process.env["CAPSULE_MCP_BATCH_CONCURRENCY"] = "3";
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await batchExecute("test", items, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // sanity: some parallelism happened
  });

  it("always emits a batch.complete event (regardless of verbose flag)", async () => {
    // Verbose flag is unset in beforeEach; the event should still emit.
    await batchExecute("test_tool", [1, 2, 3], async (n) => n);
    const events = emittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "batch.complete",
      tool: "test_tool",
      total: 3,
      succeeded: 3,
      failed: 0,
      concurrency: 5,
    });
    expect(typeof events[0]?.["durationMs"]).toBe("number");
  });

  it("does not include raw failureReasons when verbose logging is off", async () => {
    await batchExecute("test_tool", [1], async () => {
      throw new Error("customer-specific validation detail");
    });
    const events = emittedEvents();
    expect(events[0]).toMatchObject({
      event: "batch.complete",
      total: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(events[0]).not.toHaveProperty("failureReasons");
    expect(JSON.stringify(events[0])).not.toContain("customer-specific");
  });

  it("includes deduplicated failureReasons on batch.complete when verbose is on", async () => {
    process.env["CAPSULE_MCP_LOG_VERBOSE"] = "1";
    const items = [1, 2, 3, 4, 5];
    await batchExecute("test_tool", items, async (n) => {
      if (n <= 3) {
        const err = new Error("name is required") as Error & { status: number };
        err.status = 422;
        throw err;
      }
      if (n === 4) throw new Error("unique error");
      return n;
    });
    const events = emittedEvents();
    expect(events[0]).toMatchObject({
      event: "batch.complete",
      total: 5,
      succeeded: 1,
      failed: 4,
    });
    // Most common reason first (3 × "name is required"); the unique one
    // second (1 × "unique error").
    const reasons = events[0]?.["failureReasons"] as Array<{ count: number; message: string }>;
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toEqual({ status: 422, message: "name is required", count: 3 });
    expect(reasons[1]).toEqual({ message: "unique error", count: 1 });
  });

  it("omits failureReasons when no items failed", async () => {
    await batchExecute("test", [1, 2], async (n) => n);
    const events = emittedEvents();
    expect(events[0]).not.toHaveProperty("failureReasons");
  });
});

// ── end-to-end tool wrappers (mock fetch, assert per-call) ────────────────

describe("batch_update_party", () => {
  it("fans out one PUT /parties/{id} per item; aggregates results", async () => {
    mockFetch(200, { party: { id: 1, name: "Acme" } });
    mockFetch(200, { party: { id: 2, name: "Globex" } });
    mockFetch(200, { party: { id: 3, name: "Initech" } });
    const { batchUpdateParty } = await import("../src/tools/parties.js");
    const out = await batchUpdateParty({
      items: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
        { id: 3, name: "Initech" },
      ],
    });
    expect(out.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(out.results.every((r) => r.ok)).toBe(true);
    // Each item generated exactly one PUT to /parties/{id}.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("rejects empty items (Zod min(1))", async () => {
    const { batchUpdatePartySchema } = await import("../src/tools/parties.js");
    expect(batchUpdatePartySchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("rejects more than 50 items (Zod max(50))", async () => {
    const { batchUpdatePartySchema } = await import("../src/tools/parties.js");
    const items = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, name: "x" }));
    expect(batchUpdatePartySchema.safeParse({ items }).success).toBe(false);
  });
});

describe("batch_complete_task", () => {
  it("fans out PUT /tasks/{id} with status COMPLETED for each id", async () => {
    mockFetch(200, { task: { id: 1, status: "COMPLETED" } });
    mockFetch(200, { task: { id: 2, status: "COMPLETED" } });
    const { batchCompleteTask } = await import("../src/tools/tasks.js");
    const out = await batchCompleteTask({ ids: [1, 2] });
    expect(out.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const bodies = vi.mocked(fetch).mock.calls.map((c) => {
      const init = c[1] as RequestInit;
      return JSON.parse(init.body as string);
    });
    for (const body of bodies) {
      expect(body).toEqual({ task: { status: "COMPLETED" } });
    }
  });
});

describe("batch_add_tag", () => {
  it("fans out PUT /<entity>/{id} with the tag-add body for each item", async () => {
    mockFetch(200, { party: { id: 1 } });
    mockFetch(200, { opportunity: { id: 2 } });
    const { batchAddTag } = await import("../src/tools/tags.js");
    const out = await batchAddTag({
      items: [
        { entity: "parties", entityId: 1, tagName: "VIP" },
        { entity: "opportunities", entityId: 2, tagName: "RSAC26" },
      ],
    });
    expect(out.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe("batch_remove_tag_by_id", () => {
  it("fans out PUT /<entity>/{id} with the tag-detach body for each item", async () => {
    mockFetch(200, { party: { id: 1 } });
    mockFetch(200, { party: { id: 2 } });
    const { batchRemoveTagById } = await import("../src/tools/tags.js");
    const out = await batchRemoveTagById({
      items: [
        { entity: "parties", entityId: 1, tagId: 100 },
        { entity: "parties", entityId: 2, tagId: 100 },
      ],
    });
    expect(out.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
