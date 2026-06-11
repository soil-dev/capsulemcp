/**
 * v2 boundary normalization: Capsule's legacy `kase`/`kases`/
 * `restrictedKases` response KEYS become `project`/`projects`/
 * `restrictedProjects` for every consumer, applied once in
 * `handleResponse` (src/capsule/normalize.ts).
 *
 * Values must never be touched — a party named "kase" or a note whose
 * text contains "kases" passes through verbatim. The write side is
 * unchanged (request bodies still send Capsule's `kase` wrapper).
 */

import { fetch } from "undici";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { normalizeProjectKeys } from "../src/capsule/normalize.js";
import { mockFetch } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("normalizeProjectKeys (unit)", () => {
  it("renames the three legacy keys at any depth", () => {
    const input = {
      kases: [{ id: 1, kase: { id: 2 } }],
      restrictedKases: [{ id: 3 }],
      nested: { deeper: { kase: { id: 4 } } },
    };
    expect(normalizeProjectKeys(input)).toEqual({
      projects: [{ id: 1, project: { id: 2 } }],
      restrictedProjects: [{ id: 3 }],
      nested: { deeper: { project: { id: 4 } } },
    });
  });

  it("never touches VALUES, only keys", () => {
    const input = {
      name: "kase",
      description: "about kases and restrictedKases",
      tags: ["kase", "kases"],
    };
    expect(normalizeProjectKeys(input)).toEqual(input);
  });

  it("passes through primitives, null, and arrays", () => {
    expect(normalizeProjectKeys(null)).toBeNull();
    expect(normalizeProjectKeys(7)).toBe(7);
    expect(normalizeProjectKeys([{ kases: [] }])).toEqual([{ projects: [] }]);
  });
});

describe("boundary integration", () => {
  it("get_task returns a `project` parent ref for Capsule's `kase` key (input/output symmetry)", async () => {
    // Pre-v2 asymmetry: update_task { projectId: 5 } read back as
    // task.kase.id === 5. Now the response key matches the input param.
    mockFetch(200, { task: { id: 1, kase: { id: 5, name: "X" } } });
    const { getTask } = await import("../src/tools/tasks.js");
    const result = (await getTask({ id: 1 })) as {
      task: { project?: { id: number }; kase?: unknown };
    };
    expect(result.task.project).toEqual({ id: 5, name: "X" });
    expect(result.task.kase).toBeUndefined();
  });

  it("write side is untouched: update_task still sends Capsule's `kase` wrapper", async () => {
    mockFetch(200, { task: { id: 1 } });
    const { updateTask } = await import("../src/tools/tasks.js");
    await updateTask({ id: 1, projectId: 9 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.task.kase).toEqual({ id: 9 });
  });
});
