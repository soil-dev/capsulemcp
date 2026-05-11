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

describe("searchOpportunities", () => {
  it("routes to /opportunities/search when q is provided", async () => {
    mockFetch(200, { opportunities: [{ id: 1, name: "Big Deal" }] });

    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    await searchOpportunities({ q: "deal", page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/search");
    expect(url).toContain("q=deal");
  });

  it("routes to /opportunities when q is omitted", async () => {
    mockFetch(200, { opportunities: [] }, {
      Link: '<https://api.capsulecrm.com/api/v2/opportunities?page=2&perPage=25>; rel="next"',
    });

    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    const result = await searchOpportunities({ page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities?");
    expect(url).not.toContain("/search");
    expect(result.nextPage).toBe(2);
  });
});

describe("getOpportunity", () => {
  it("returns the opportunity", async () => {
    mockFetch(200, { opportunity: { id: 7, name: "Renewal" } });

    const { getOpportunity } = await import("../src/tools/opportunities.js");
    const result = await getOpportunity({ id: 7 });

    expect((result as { opportunity: { name: string } }).opportunity.name).toBe("Renewal");
  });
});

describe("createOpportunity", () => {
  it("posts with nested party and milestone objects", async () => {
    mockFetch(201, { opportunity: { id: 20, name: "New Deal" } });

    const { createOpportunity } = await import("../src/tools/opportunities.js");
    await createOpportunity({ name: "New Deal", partyId: 1, milestoneId: 3 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);

    expect(body.opportunity.party).toEqual({ id: 1 });
    expect(body.opportunity.milestone).toEqual({ id: 3 });
  });
});

describe("deleteOpportunity", () => {
  it("issues DELETE /opportunities/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteOpportunity } = await import("../src/tools/opportunities.js");
    const result = await deleteOpportunity({ id: 21, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/21");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 21 });
  });
});

describe("updateOpportunity", () => {
  it("puts only the provided fields", async () => {
    mockFetch(200, { opportunity: { id: 20, probability: 80 } });

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, probability: 80 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/20");
    expect((options as RequestInit).method).toBe("PUT");
  });

  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}]", async () => {
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({
      id: 20,
      fields: [
        { definitionId: 5, value: "2025-11-28" },
        { definitionId: 6, value: null },
      ],
    });
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.opportunity.fields).toEqual([
      { definition: { id: 5 }, value: "2025-11-28" },
      { definition: { id: 6 }, value: null },
    ]);
  });

  it("maps lostReasonId → lostReason:{id} for Lost closes", async () => {
    // Production bug report: lostReason couldn't be set at all via this
    // connector, so every connector-driven Lost-close left lostReason
    // null. Now plumbed as a top-level param mirroring ownerId.
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, milestoneId: 7, lostReasonId: 42 });
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.opportunity.milestone).toEqual({ id: 7 });
    expect(body.opportunity.lostReason).toEqual({ id: 42 });
    // user-facing field name doesn't leak into the API body
    expect(body.opportunity.lostReasonId).toBeUndefined();
  });
});

describe("getOpportunities (batch)", () => {
  it("GETs /opportunities/{ids}", async () => {
    mockFetch(200, { opportunities: [{ id: 1 }] });
    const { getOpportunities } = await import("../src/tools/opportunities.js");
    await getOpportunities({ ids: [1, 2, 3] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/opportunities\/1,2,3($|\?)/);
  });
});
