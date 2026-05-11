import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("listSavedFilters", () => {
  it("GETs /<entity>/filters per entity", async () => {
    mockFetch(200, { filters: [{ id: 338778, name: "VIP Customers" }] });
    const { listSavedFilters } = await import("../src/tools/saved-filters.js");
    await listSavedFilters({ entity: "parties" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/filters");
  });

  it("uses /kases/filters for projects", async () => {
    mockFetch(200, { filters: [] });
    const { listSavedFilters } = await import("../src/tools/saved-filters.js");
    await listSavedFilters({ entity: "kases" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/filters");
  });
});

describe("runSavedFilter", () => {
  it("GETs /<entity>/filters/{id}/results with pagination", async () => {
    mockFetch(
      200,
      { parties: [{ id: 1 }] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/parties/filters/123/results?page=2&perPage=25>; rel="next"',
      },
    );
    const { runSavedFilter } = await import("../src/tools/saved-filters.js");
    const result = await runSavedFilter({
      entity: "parties",
      id: 123,
      page: 1,
      perPage: 25,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/filters/123/results");
    expect(url).toContain("page=1");
    expect(url).toContain("perPage=25");
    expect((init as { method?: string }).method).toBeUndefined(); // GET
    expect(result.nextPage).toBe(2);
  });

  it("propagates embed", async () => {
    mockFetch(200, { opportunities: [] });
    const { runSavedFilter } = await import("../src/tools/saved-filters.js");
    await runSavedFilter({
      entity: "opportunities",
      id: 99,
      embed: "tags,fields",
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("embed=tags%2Cfields");
  });

  it("sort is intentionally not exposed as a parameter — orderBy lives on the saved filter itself", async () => {
    // Capsule's saved-filter sort is configured in the web UI at save
    // time (the orderBy is part of the saved filter definition). The
    // run endpoint doesn't accept a client-side sort override — and
    // we deliberately don't expose one on this tool. Pinning the
    // schema surface so a contributor doesn't add a `sort` param
    // without first verifying Capsule accepts it on the run endpoint.
    const { runSavedFilterSchema } = await import("../src/tools/saved-filters.js");
    expect("sort" in (runSavedFilterSchema.shape as Record<string, unknown>)).toBe(false);
  });
});
