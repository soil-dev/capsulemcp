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

describe("listProjects", () => {
  it("returns kases and nextPage", async () => {
    mockFetch(200, { kases: [{ id: 1, name: "Website Rebuild" }] }, {
      Link: '<https://api.capsulecrm.com/api/v2/kases?page=2&perPage=25>; rel="next"',
    });

    const { listProjects } = await import("../src/tools/projects.js");
    const result = await listProjects({ page: 1, perPage: 25 });

    expect(result.kases).toHaveLength(1);
    expect(result.nextPage).toBe(2);
  });

  it("passes status filter to query params", async () => {
    mockFetch(200, { kases: [] });

    const { listProjects } = await import("../src/tools/projects.js");
    await listProjects({ status: "OPEN", page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("status=OPEN");
  });
});

describe("getProject", () => {
  it("returns the project", async () => {
    mockFetch(200, { kase: { id: 3, name: "Onboarding" } });

    const { getProject } = await import("../src/tools/projects.js");
    const result = await getProject({ id: 3 });

    expect((result as { kase: { name: string } }).kase.name).toBe("Onboarding");
  });
});

describe("createProject", () => {
  it("posts to /kases with nested party", async () => {
    mockFetch(201, { kase: { id: 10, name: "Migration" } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Migration", partyId: 5 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.party).toEqual({ id: 5 });
  });
});
