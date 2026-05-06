import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

function mockFetch(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
afterEach(() => { vi.clearAllMocks(); delete process.env["CAPSULE_API_TOKEN"]; });

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
    expect(result).toEqual({ deleted: true, id: 99 });
  });
});
