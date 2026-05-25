/**
 * Tests for the shared `positiveId` schema used across all tool
 * registrations that accept a Capsule entity ID.
 *
 * The contract is two-pronged:
 *
 *   1. Accept positive integers as-is.
 *   2. **Coerce** integer-shaped strings to numbers. This is the
 *      load-bearing behaviour for LLM-driven MCP clients that
 *      sometimes serialize IDs as JSON strings — without coercion,
 *      a perfectly valid `"12345"` from the model gets rejected
 *      with `expected number, received string`, which v1.6.0
 *      production traffic surfaced as a flaky "single-call vs
 *      batch-call behavior difference" before we traced it to
 *      non-deterministic client serialization.
 *
 *   3. Reject garbage. The `.int().positive()` checks still apply
 *      AFTER string coercion. Non-decimal strings, zero, negatives,
 *      floats, booleans, arrays, and objects all reject.
 *
 * Pinned at the helper level (not per-tool) because every tool's ID
 * fields go through this same Zod schema; if it changes, every tool
 * picks up the new behaviour transparently.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { positiveId } from "../src/tools/shared-schemas.js";

describe("positiveId", () => {
  it("accepts a positive integer as-is", () => {
    expect(positiveId.parse(1)).toBe(1);
    expect(positiveId.parse(12345)).toBe(12345);
    expect(positiveId.parse(99999)).toBe(99999);
  });

  it("coerces integer-shaped strings to numbers", () => {
    // The load-bearing case: LLM clients that ship IDs as JSON strings.
    expect(positiveId.parse("1")).toBe(1);
    expect(positiveId.parse("12345")).toBe(12345);
    expect(positiveId.parse("99999")).toBe(99999);
    expect(positiveId.parse(" 42 ")).toBe(42);
  });

  it("rejects non-numeric strings", () => {
    // Coercion is intentionally narrower than Number(...).
    expect(() => positiveId.parse("abc")).toThrow();
    expect(() => positiveId.parse("")).toThrow();
    expect(() => positiveId.parse("12.5")).toThrow();
    expect(() => positiveId.parse("1e3")).toThrow();
    expect(() => positiveId.parse("+12")).toThrow();
  });

  it("rejects zero and negative numbers", () => {
    // `.positive()` excludes 0.
    expect(() => positiveId.parse(0)).toThrow();
    expect(() => positiveId.parse(-1)).toThrow();
    expect(() => positiveId.parse("0")).toThrow();
    expect(() => positiveId.parse("-42")).toThrow();
  });

  it("rejects non-integer numbers", () => {
    expect(() => positiveId.parse(1.5)).toThrow();
    expect(() => positiveId.parse("1.5")).toThrow();
  });

  it("rejects non-scalar inputs", () => {
    expect(() => positiveId.parse(null)).toThrow();
    expect(() => positiveId.parse(undefined)).toThrow();
    expect(() => positiveId.parse({})).toThrow();
    expect(() => positiveId.parse(true)).toThrow();
    expect(() => positiveId.parse(false)).toThrow();
    expect(() => positiveId.parse([1])).toThrow();
    expect(() => positiveId.parse([1, 2])).toThrow();
  });

  it("preserves int identity when modifiers are chained", () => {
    // Sanity: .optional() / .nullable() chains compose correctly.
    const optional = positiveId.optional();
    expect(optional.parse(42)).toBe(42);
    expect(optional.parse("42")).toBe(42);
    expect(optional.parse(undefined)).toBeUndefined();

    const nullable = positiveId.nullable();
    expect(nullable.parse(42)).toBe(42);
    expect(nullable.parse("42")).toBe(42);
    expect(nullable.parse(null)).toBeNull();
  });

  it("works inside z.array() for batch ID inputs", () => {
    // Used in get_parties / get_opportunities / get_projects / etc.
    // Mixed int + string array should all coerce to numbers.
    const arr = z.array(positiveId);
    expect(arr.parse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(arr.parse(["1", "2", "3"])).toEqual([1, 2, 3]);
    expect(arr.parse([1, "2", 3])).toEqual([1, 2, 3]);
    expect(() => arr.parse([1, "abc", 3])).toThrow();
  });
});
