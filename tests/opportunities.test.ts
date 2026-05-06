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
  it("returns opportunities and nextPage", async () => {
    mockFetch(200, { opportunities: [{ id: 1, name: "Big Deal" }] }, {
      Link: '<https://api.capsulecrm.com/api/v2/opportunities?page=2&perPage=25>; rel="next"',
    });

    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    const result = await searchOpportunities({ page: 1, perPage: 25 });

    expect(result.opportunities).toHaveLength(1);
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

describe("updateOpportunity", () => {
  it("puts only the provided fields", async () => {
    mockFetch(200, { opportunity: { id: 20, probability: 80 } });

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, probability: 80 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/20");
    expect((options as RequestInit).method).toBe("PUT");
  });
});
