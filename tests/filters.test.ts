import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

// ── Helpers ──────────────────────────────────────────────────────────────────

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_READONLY"];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("filterParties", () => {
  it("POSTs to /parties/filters/results with the conditions wrapped in {filter:...}", async () => {
    mockFetch(200, { parties: [{ id: 42 }] });

    const { filterParties } = await import("../src/tools/filters.js");
    await filterParties({
      conditions: [
        { field: "addedOn", operator: "is within last", value: 7 },
      ],
      page: 1,
      perPage: 25,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/filters/results");
    expect((init as { method: string }).method).toBe("POST");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      filter: {
        conditions: [
          { field: "addedOn", operator: "is within last", value: 7 },
        ],
      },
    });
  });

  it("propagates page, perPage, and embed as query params", async () => {
    mockFetch(200, { parties: [] });

    const { filterParties } = await import("../src/tools/filters.js");
    await filterParties({
      conditions: [{ field: "tag", operator: "is", value: "VIP" }],
      page: 3,
      perPage: 50,
      embed: "tags,fields",
    });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("page=3");
    expect(url).toContain("perPage=50");
    expect(url).toContain("embed=tags%2Cfields");
  });

  it("parses nextPage from the Link header", async () => {
    mockFetch(
      200,
      { parties: [] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/parties/filters/results?page=2&perPage=25>; rel="next"',
      },
    );

    const { filterParties } = await import("../src/tools/filters.js");
    const result = await filterParties({
      conditions: [{ field: "addedOn", operator: "is within last", value: 30 }],
      page: 1,
      perPage: 25,
    });
    expect(result.nextPage).toBe(2);
  });

  it("works in read-only mode (filter is a read, not a write)", async () => {
    process.env["CAPSULE_MCP_READONLY"] = "1";
    mockFetch(200, { parties: [{ id: 1 }] });

    const { filterParties } = await import("../src/tools/filters.js");
    const result = await filterParties({
      conditions: [{ field: "addedOn", operator: "is within last", value: 7 }],
      page: 1,
      perPage: 25,
    });
    expect(result.parties).toHaveLength(1);
  });
});

describe("filterOpportunities", () => {
  it("POSTs to /opportunities/filters/results", async () => {
    mockFetch(200, { opportunities: [{ id: 7 }] });

    const { filterOpportunities } = await import("../src/tools/filters.js");
    await filterOpportunities({
      conditions: [{ field: "milestone", operator: "is", value: "Won" }],
      page: 1,
      perPage: 25,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/filters/results");
    expect((init as { method: string }).method).toBe("POST");
  });
});

describe("filterProjects", () => {
  it("POSTs to /kases/filters/results (Capsule's legacy projects path)", async () => {
    mockFetch(200, { kases: [{ id: 13 }] });

    const { filterProjects } = await import("../src/tools/filters.js");
    await filterProjects({
      conditions: [{ field: "status", operator: "is", value: "OPEN" }],
      page: 1,
      perPage: 25,
    });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/filters/results");
    expect(url).not.toContain("/projects/");
  });
});
