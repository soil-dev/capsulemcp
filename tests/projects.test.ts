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
    // No stage when stageId is omitted — Capsule will leave the project
    // unassigned to any board.
    expect(body.kase.stage).toBeUndefined();
  });

  it("maps stageId → stage:<integer> in the request body", async () => {
    mockFetch(201, { kase: { id: 10, stage: { id: 42, name: "Discovery" } } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Onboarding", partyId: 5, stageId: 42 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    // Capsule's create-case body uses bare integer per docs example.
    expect(body.kase.stage).toBe(42);
    // The user-facing stageId field doesn't leak into the API body.
    expect(body.kase.stageId).toBeUndefined();
  });
});

describe("deleteProject", () => {
  it("issues DELETE /kases/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteProject } = await import("../src/tools/projects.js");
    const result = await deleteProject({ id: 11, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/11");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, id: 11 });
  });
});

describe("updateProject", () => {
  it("puts only the provided fields to /kases/:id", async () => {
    mockFetch(200, { kase: { id: 10, status: "CLOSED" } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, status: "CLOSED" });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/10");
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase).toEqual({ status: "CLOSED" });
  });

  it("maps ownerId to nested owner object", async () => {
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.ownerId).toBeUndefined();
  });

  it("maps stageId → stage:<integer> for moving a project across stages", async () => {
    mockFetch(200, { kase: { id: 10, stage: { id: 99, name: "Live" } } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, stageId: 99 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.stage).toBe(99);
    expect(body.kase.stageId).toBeUndefined();
  });
});

describe("getProjects (batch)", () => {
  it("GETs /kases/{ids} (legacy projects path)", async () => {
    mockFetch(200, { kases: [{ id: 1 }] });
    const { getProjects } = await import("../src/tools/projects.js");
    await getProjects({ ids: [1, 2] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/kases\/1,2($|\?)/);
    expect(url).not.toContain("/projects/");
  });
});
