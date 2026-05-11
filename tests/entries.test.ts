import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
afterEach(() => { vi.clearAllMocks(); delete process.env["CAPSULE_API_TOKEN"]; });

describe("listPartyEntries", () => {
  it("hits /parties/:id/entries with pagination params", async () => {
    mockFetch(200, { entries: [{ id: 1, type: "note" }, { id: 2, type: "email" }] });

    const { listPartyEntries } = await import("../src/tools/entries.js");
    const result = await listPartyEntries({ partyId: 7, page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/7/entries");
    expect(url).toContain("perPage=25");
    expect(result.entries).toHaveLength(2);
  });
});

describe("listOpportunityEntries", () => {
  it("hits /opportunities/:id/entries", async () => {
    mockFetch(200, { entries: [] });

    const { listOpportunityEntries } = await import("../src/tools/entries.js");
    await listOpportunityEntries({ opportunityId: 11, page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/11/entries");
  });
});

describe("listProjectEntries", () => {
  it("hits /kases/:id/entries", async () => {
    mockFetch(200, { entries: [] });

    const { listProjectEntries } = await import("../src/tools/entries.js");
    await listProjectEntries({ projectId: 22, page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/22/entries");
  });
});

describe("getEntry", () => {
  it("hits /entries/:id and returns the entry", async () => {
    mockFetch(200, { entry: { id: 99, type: "email", subject: "Re: deal", content: "body..." } });

    const { getEntry } = await import("../src/tools/entries.js");
    const result = await getEntry({ id: 99 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/entries/99");
    expect((result as { entry: { subject: string } }).entry.subject).toBe("Re: deal");
  });
});

describe("updateEntry", () => {
  it("PUTs to /entries/{id} with content wrapped in {entry: ...}", async () => {
    mockFetch(200, { entry: { id: 99, content: "edited" } });
    const { updateEntry } = await import("../src/tools/entries.js");
    await updateEntry({ id: 99, content: "edited" });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/entries/99");
    const i = init as { method: string; body: string };
    expect(i.method).toBe("PUT");
    expect(JSON.parse(i.body)).toEqual({ entry: { content: "edited" } });
  });

  it("supports updating subject only", async () => {
    mockFetch(200, { entry: { id: 1 } });
    const { updateEntry } = await import("../src/tools/entries.js");
    await updateEntry({ id: 1, subject: "New subject" });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      entry: { subject: "New subject" },
    });
  });

  it("rejects calls with no fields to update", async () => {
    const { updateEntry } = await import("../src/tools/entries.js");
    await expect(updateEntry({ id: 1 })).rejects.toThrow(
      /provide at least one field/,
    );
  });
});

describe("listEntries (global feed)", () => {
  it("GETs /entries (no entity prefix) with pagination", async () => {
    mockFetch(
      200,
      { entries: [{ id: 1, type: "note" }] },
      { Link: '<https://api.capsulecrm.com/api/v2/entries?page=2&perPage=25>; rel="next"' },
    );

    const { listEntries } = await import("../src/tools/entries.js");
    const result = await listEntries({ page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/entries\?/);
    expect(url).not.toMatch(/\/parties\/\d+\/entries/);
    expect(url).not.toMatch(/\/opportunities\/\d+\/entries/);
    expect(url).not.toMatch(/\/kases\/\d+\/entries/);
    expect(result.nextPage).toBe(2);
  });
});

describe("addNote", () => {
  it("posts a note linked to a party", async () => {
    mockFetch(201, { entry: { id: 1, type: "note", content: "Spoke to client" } });

    const { addNote } = await import("../src/tools/entries.js");
    await addNote({ content: "Spoke to client", partyId: 7 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/entries");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.entry.type).toBe("note");
    expect(body.entry.party).toEqual({ id: 7 });
  });

  it("posts a note linked to an opportunity", async () => {
    mockFetch(201, { entry: { id: 2, type: "note" } });

    const { addNote } = await import("../src/tools/entries.js");
    await addNote({ content: "Progressing", opportunityId: 3 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.entry.opportunity).toEqual({ id: 3 });
  });

  it("forwards entryAt verbatim for backdating", async () => {
    mockFetch(201, { entry: { id: 4 } });
    const { addNote } = await import("../src/tools/entries.js");
    await addNote({
      content: "Historical meeting",
      partyId: 7,
      entryAt: "2020-03-15T14:30:00Z",
    });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.entry.entryAt).toBe("2020-03-15T14:30:00Z");
  });

  it("maps creatorId → creator:{id} for on-behalf-of authoring", async () => {
    mockFetch(201, { entry: { id: 5 } });
    const { addNote } = await import("../src/tools/entries.js");
    await addNote({
      content: "Logged on behalf of Kajal",
      partyId: 7,
      creatorId: 99,
    });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.entry.creator).toEqual({ id: 99 });
    expect(body.entry.creatorId).toBeUndefined();
  });

  it("rejects malformed entryAt at the schema layer", async () => {
    const { addNoteSchema } = await import("../src/tools/entries.js");
    expect(
      addNoteSchema.safeParse({ content: "x", partyId: 1, entryAt: "not-a-date" })
        .success,
    ).toBe(false);
    expect(
      addNoteSchema.safeParse({ content: "x", partyId: 1, entryAt: "2024-03-15" })
        .success,
    ).toBe(false); // needs full ISO 8601, not just date
    expect(
      addNoteSchema.safeParse({
        content: "x",
        partyId: 1,
        entryAt: "2024-03-15T14:30:00Z",
      }).success,
    ).toBe(true);
  });

  it("throws if no link target is provided", async () => {
    const { addNote } = await import("../src/tools/entries.js");
    await expect(addNote({ content: "Orphan note" })).rejects.toThrow("exactly one");
  });

  it("throws if multiple link targets are provided", async () => {
    const { addNote } = await import("../src/tools/entries.js");
    await expect(
      addNote({ content: "Bad", partyId: 1, opportunityId: 2 }),
    ).rejects.toThrow("exactly one");
  });
});

describe("deleteEntry", () => {
  it("issues DELETE /entries/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteEntry } = await import("../src/tools/entries.js");
    const result = await deleteEntry({ id: 99, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/entries/99");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 99 });
  });
});
