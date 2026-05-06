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

describe("listPipelines", () => {
  it("returns pipelines array", async () => {
    mockFetch(200, { pipelines: [{ id: 1, name: "Sales" }] });

    const { listPipelines } = await import("../src/tools/pipelines.js");
    const result = await listPipelines({});

    expect((result as { pipelines: unknown[] }).pipelines).toHaveLength(1);
  });
});

describe("listMilestones", () => {
  it("fetches milestones scoped to a pipeline", async () => {
    mockFetch(200, { milestones: [{ id: 10, name: "Qualified" }] });

    const { listMilestones } = await import("../src/tools/pipelines.js");
    await listMilestones({ pipelineId: 1 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/pipelines/1/milestones");
  });
});
