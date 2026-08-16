/**
 * Issue #112 P3–P5: write-side coverage gaps + since + 202 handling.
 * Every wire shape asserted here was verified against the live API
 * (2026-08-16) before implementation.
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

const body = (call = 0) =>
  JSON.parse((vi.mocked(fetch).mock.calls[call]![1] as RequestInit).body as string);

describe("tracks-at-create (wire: tracks: [{definition: {id}}])", () => {
  it("create_party maps trackDefinitionIds", async () => {
    mockFetch(201, { party: { id: 1 } });
    const { createParty } = await import("../src/tools/parties.js");
    await createParty({ type: "organisation", name: "Acme", trackDefinitionIds: [7, 9] });
    expect(body().party.tracks).toEqual([{ definition: { id: 7 } }, { definition: { id: 9 } }]);
    expect(body().party.trackDefinitionIds).toBeUndefined();
  });

  it("create_opportunity and create_project map trackDefinitionIds", async () => {
    mockFetch(201, { opportunity: { id: 1 } });
    const { createOpportunity } = await import("../src/tools/opportunities.js");
    await createOpportunity({ name: "Deal", partyId: 1, milestoneId: 2, trackDefinitionIds: [5] });
    expect(body().opportunity.tracks).toEqual([{ definition: { id: 5 } }]);

    mockFetch(201, { kase: { id: 1 } });
    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Proj", partyId: 1, trackDefinitionIds: [5] });
    expect(body(1).kase.tracks).toEqual([{ definition: { id: 5 } }]);
  });
});

describe("opportunity duration/durationBasis", () => {
  it("create forwards both; FIXED + numeric duration is rejected pre-flight", async () => {
    mockFetch(201, { opportunity: { id: 1 } });
    const { createOpportunity, createOpportunitySchema } = await import(
      "../src/tools/opportunities.js"
    );
    await createOpportunity({
      name: "Deal",
      partyId: 1,
      milestoneId: 2,
      durationBasis: "MONTH",
      duration: 12,
    });
    expect(body().opportunity.duration).toBe(12);
    expect(body().opportunity.durationBasis).toBe("MONTH");
    expect(
      createOpportunitySchema.safeParse({
        name: "X",
        partyId: 1,
        milestoneId: 2,
        durationBasis: "FIXED",
        duration: 6,
      }).success,
    ).toBe(false);
  });

  it("update supports the FIXED + duration:null clear (wire-verified)", async () => {
    mockFetch(200, { opportunity: { id: 1 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 1, durationBasis: "FIXED", duration: null });
    expect(body().opportunity.duration).toBeNull();
    expect(body().opportunity.durationBasis).toBe("FIXED");
  });
});

describe("task repeat", () => {
  it("create_task forwards the repeat object", async () => {
    mockFetch(201, { task: { id: 1 } });
    const { createTask } = await import("../src/tools/tasks.js");
    await createTask({
      description: "T",
      dueOn: "2026-09-01",
      partyId: 1,
      repeat: { frequency: "WEEKLY", interval: 2 },
    });
    expect(body().task.repeat).toEqual({ frequency: "WEEKLY", interval: 2 });
  });

  it("rejects unknown frequency at the schema layer", async () => {
    const { createTaskSchema } = await import("../src/tools/tasks.js");
    expect(
      createTaskSchema.safeParse({
        description: "T",
        dueOn: "2026-09-01",
        repeat: { frequency: "DAILY" },
      }).success,
    ).toBe(false);
  });
});

describe("add_note activityTypeId", () => {
  it("forwards activityType as a bare id (wire-verified shape)", async () => {
    mockFetch(201, { entry: { id: 1 } });
    const { addNote } = await import("../src/tools/entries.js");
    await addNote({ content: "c", partyId: 1, activityTypeId: 42 });
    expect(body().entry.activityType).toBe(42);
  });

  it("omits activityType when not given (Capsule defaults to Note)", async () => {
    mockFetch(201, { entry: { id: 1 } });
    const { addNote } = await import("../src/tools/entries.js");
    await addNote({ content: "c", partyId: 1 });
    expect(body().entry.activityType).toBeUndefined();
  });
});

describe("entry attachment deltas", () => {
  it("update_entry removeAttachmentIds sends {id, _delete: true}", async () => {
    mockFetch(200, { entry: { id: 1, attachments: [] } });
    const { updateEntry } = await import("../src/tools/entries.js");
    await updateEntry({ id: 1, removeAttachmentIds: [55, 56] });
    expect(body().entry.attachments).toEqual([
      { id: 55, _delete: true },
      { id: 56, _delete: true },
    ]);
  });

  it("upload_attachment entryId mode: upload then PUT to the entry, no note created", async () => {
    mockFetch(200, { upload: { token: "tok-1" } });
    mockFetch(200, { entry: { id: 9, attachments: [{ id: 1 }] } });
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    const data = Buffer.from("hello").toString("base64");
    await uploadAttachment({
      filename: "a.txt",
      contentType: "text/plain",
      dataBase64: data,
      entryId: 9,
    });
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0]![0])).toContain("/attachments/upload");
    expect(String(calls[1]![0])).toContain("/entries/9");
    expect((calls[1]![1] as RequestInit).method).toBe("PUT");
    expect(body(1).entry.attachments).toEqual([{ token: "tok-1" }]);
  });

  it("entryId is mutually exclusive with parents and content", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    const data = Buffer.from("x").toString("base64");
    await expect(
      uploadAttachment({
        filename: "a.txt",
        contentType: "text/plain",
        dataBase64: data,
        entryId: 9,
        partyId: 1,
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("since on list endpoints", () => {
  it("search_parties / list_projects forward since", async () => {
    mockFetch(200, { parties: [] });
    const { searchParties } = await import("../src/tools/parties.js");
    await searchParties({ since: "2026-08-01T00:00:00Z", page: 1, perPage: 25 });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("since=2026-08-01");

    mockFetch(200, { kases: [] });
    const { listProjects } = await import("../src/tools/projects.js");
    await listProjects({ since: "2026-08-01T00:00:00Z", page: 1, perPage: 25 });
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain("since=2026-08-01");
  });
});

describe("DELETE 202 Accepted (long-running deletion)", () => {
  it("delete envelope carries scheduled: true on 202", async () => {
    mockFetch(202, {});
    const { deleteParty } = await import("../src/tools/parties.js");
    const r = await deleteParty({ id: 1, confirm: true });
    expect(r.deleted).toBe(true);
    expect(r.scheduled).toBe(true);
  });

  it("no scheduled key on a plain 204", async () => {
    mockFetch(204, {});
    const { deleteParty } = await import("../src/tools/parties.js");
    const r = await deleteParty({ id: 1, confirm: true });
    expect(r.deleted).toBe(true);
    expect("scheduled" in r).toBe(false);
  });
});

describe("audit follow-ups", () => {
  it("since forwarded by search_opportunities and search_projects", async () => {
    mockFetch(200, { opportunities: [] });
    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    await searchOpportunities({ since: "2026-08-01T00:00:00Z", page: 1, perPage: 25 });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("since=2026-08-01");

    mockFetch(200, { kases: [] });
    const { searchProjects } = await import("../src/tools/projects.js");
    await searchProjects({ since: "2026-08-01T00:00:00Z", page: 1, perPage: 25 });
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain("since=2026-08-01");
  });

  it("q + since is rejected pre-flight on all three search tools (since is ignored on /search)", async () => {
    const { searchPartiesSchema } = await import("../src/tools/parties.js");
    const { searchOpportunitiesSchema } = await import("../src/tools/opportunities.js");
    const { searchProjectsSchema } = await import("../src/tools/projects.js");
    for (const schema of [searchPartiesSchema, searchOpportunitiesSchema, searchProjectsSchema]) {
      expect(schema.safeParse({ q: "acme", since: "2026-08-01T00:00:00Z" }).success).toBe(false);
      expect(schema.safeParse({ since: "2026-08-01T00:00:00Z" }).success).toBe(true);
      expect(schema.safeParse({ q: "acme" }).success).toBe(true);
    }
  });

  it("delete_tag_definition surfaces scheduled: true on 202", async () => {
    mockFetch(202, {});
    const { deleteTagDefinition } = await import("../src/tools/tags.js");
    const r = (await deleteTagDefinition({
      entity: "parties",
      tagId: 7,
      confirm: true,
    })) as Record<string, unknown>;
    expect(r["deleted"]).toBe(true);
    expect(r["scheduled"]).toBe(true);
  });

  it("update_entry rejects an empty removeAttachmentIds array", async () => {
    const { updateEntrySchema } = await import("../src/tools/entries.js");
    expect(updateEntrySchema.safeParse({ id: 1, removeAttachmentIds: [] }).success).toBe(false);
  });
});
