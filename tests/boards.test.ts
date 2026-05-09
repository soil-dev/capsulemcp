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

describe("listBoards", () => {
  it("GETs /boards", async () => {
    mockFetch(200, { boards: [{ id: 1, name: "Sponsors" }] });
    const { listBoards } = await import("../src/tools/boards.js");
    const result = await listBoards({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/boards");
    expect(result.boards).toHaveLength(1);
  });
});

describe("listStages", () => {
  it("GETs /stages globally when no boardId is given", async () => {
    mockFetch(200, { stages: [{ id: 1, name: "Approved", board: { id: 65935 } }] });
    const { listStages } = await import("../src/tools/boards.js");
    await listStages({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/stages($|\?)/);
    expect(url).not.toContain("/boards/");
  });

  it("GETs /boards/{id}/stages when boardId is provided", async () => {
    mockFetch(200, { stages: [] });
    const { listStages } = await import("../src/tools/boards.js");
    await listStages({ boardId: 65935 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/boards/65935/stages");
  });
});
