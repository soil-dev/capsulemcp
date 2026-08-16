/**
 * Per-resource embed allow-lists + wire mapping (issue #112 P1).
 *
 * v2.0.0's single allow-list (tags/fields/missingImportantFields) was
 * derived from a probe that diffed TOP-LEVEL row keys — blind to embeds
 * that enrich a NESTED ref (embed=party on an opportunity expands the
 * party stub 4 → 15 keys; verified live 2026-08-16). These tests pin:
 *
 *   1. each resource accepts its documented tokens (incl. ref-enriching
 *      ones) and still rejects typos/wrong-resource tokens;
 *   2. the caller-facing `project` token maps to Capsule's `kase` on
 *      the wire (URL), mirroring ENTITY_PATH and the response-key
 *      normalization;
 *   3. task tools expose embed and propagate it;
 *   4. run_saved_filter validates embed cross-field against `entity`.
 */

import { fetch } from "undici";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("per-resource allow-lists", () => {
  it("opportunities accept party + milestone; parties reject them", async () => {
    const { searchOpportunitiesSchema } = await import("../src/tools/opportunities.js");
    const { searchPartiesSchema } = await import("../src/tools/parties.js");
    expect(searchOpportunitiesSchema.safeParse({ embed: "party,milestone" }).success).toBe(true);
    expect(searchPartiesSchema.safeParse({ embed: "milestone" }).success).toBe(false);
  });

  it("parties accept organisation; projects accept party + opportunity", async () => {
    const { getPartySchema } = await import("../src/tools/parties.js");
    const { getProjectSchema } = await import("../src/tools/projects.js");
    expect(getPartySchema.safeParse({ id: 1, embed: "organisation,tags" }).success).toBe(true);
    expect(getProjectSchema.safeParse({ id: 1, embed: "party,opportunity,fields" }).success).toBe(
      true,
    );
    expect(getProjectSchema.safeParse({ id: 1, embed: "organisation" }).success).toBe(false);
  });

  it("entries accept the five documented ref tokens plus legacy attachments/participants", async () => {
    const { getEntrySchema } = await import("../src/tools/entries.js");
    expect(
      getEntrySchema.safeParse({ id: 1, embed: "party,project,opportunity,creator,activityType" })
        .success,
    ).toBe(true);
    expect(getEntrySchema.safeParse({ id: 1, embed: "attachments,participants" }).success).toBe(
      true,
    );
    expect(getEntrySchema.safeParse({ id: 1, embed: "tags" }).success).toBe(false);
  });

  it("typos are still rejected everywhere", async () => {
    const { searchOpportunitiesSchema } = await import("../src/tools/opportunities.js");
    expect(searchOpportunitiesSchema.safeParse({ embed: "partey" }).success).toBe(false);
    expect(searchOpportunitiesSchema.safeParse({ embed: "party," }).success).toBe(false);
  });
});

describe("project → kase wire mapping", () => {
  it("embed=project on an entry becomes embed=kase in the URL", async () => {
    mockFetch(200, { entry: { id: 1 } });
    const { getEntry } = await import("../src/tools/entries.js");
    await getEntry({ id: 1, embed: "project,creator" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("embed=kase%2Ccreator");
    expect(String(url)).not.toContain("project");
  });

  it("embed=project on a task becomes embed=kase; other tokens pass through", async () => {
    mockFetch(200, { task: { id: 1 } });
    const { getTask } = await import("../src/tools/tasks.js");
    await getTask({ id: 1, embed: "project,owner,nextTask" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("embed=kase%2Cowner%2CnextTask");
  });
});

describe("task tools expose embed", () => {
  it("list_tasks propagates embed", async () => {
    mockFetch(200, { tasks: [] });
    const { listTasks } = await import("../src/tools/tasks.js");
    await listTasks({ embed: "party,owner", page: 1, perPage: 25 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("embed=party%2Cowner");
  });

  it("get_tasks propagates embed through the chunked multi-get", async () => {
    mockFetch(200, { tasks: [{ id: 1 }, { id: 2 }] });
    const { getTasks } = await import("../src/tools/tasks.js");
    await getTasks({ ids: [1, 2], embed: "nextTask" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tasks/1,2");
    expect(url).toContain("embed=nextTask");
  });

  it("rejects wrong-resource tokens on tasks", async () => {
    const { listTasksSchema } = await import("../src/tools/tasks.js");
    expect(listTasksSchema.safeParse({ embed: "tags" }).success).toBe(false);
  });
});

describe("run_saved_filter cross-field embed validation", () => {
  it("accepts entity-appropriate tokens and maps project→kase on the wire", async () => {
    const { runSavedFilterSchema, runSavedFilter } = await import("../src/tools/saved-filters.js");
    expect(
      runSavedFilterSchema.safeParse({ entity: "opportunities", id: 5, embed: "party,milestone" })
        .success,
    ).toBe(true);

    mockFetch(200, { kases: [] });
    await runSavedFilter({
      entity: "projects",
      id: 5,
      embed: "party,opportunity",
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/filters/5/results");
    expect(url).toContain("embed=party%2Copportunity");
  });

  it("rejects tokens invalid for the given entity", async () => {
    const { runSavedFilterSchema } = await import("../src/tools/saved-filters.js");
    expect(
      runSavedFilterSchema.safeParse({ entity: "projects", id: 5, embed: "milestone" }).success,
    ).toBe(false);
    expect(
      runSavedFilterSchema.safeParse({ entity: "parties", id: 5, embed: "party" }).success,
    ).toBe(false);
  });
});

describe("filter tools carry per-entity embeds", () => {
  it("filter_opportunities accepts milestone; filter_parties does not", async () => {
    const { filterOpportunitiesSchema, filterPartiesSchema } = await import(
      "../src/tools/filters.js"
    );
    const conditions = [{ field: "addedOn", operator: "is within last", value: 7 }];
    expect(
      filterOpportunitiesSchema.safeParse({ conditions, embed: "milestone,tags" }).success,
    ).toBe(true);
    expect(filterPartiesSchema.safeParse({ conditions, embed: "milestone" }).success).toBe(false);
  });
});
