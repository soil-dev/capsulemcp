import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

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

  it("rejects non-positive pipelineId at the schema layer", async () => {
    const { listMilestonesSchema } = await import("../src/tools/pipelines.js");
    expect(listMilestonesSchema.safeParse({ pipelineId: 0 }).success).toBe(false);
    expect(listMilestonesSchema.safeParse({ pipelineId: -3 }).success).toBe(false);
    expect(listMilestonesSchema.safeParse({}).success).toBe(false);
  });

  it("propagates Capsule 404 to the caller (no silent swallow)", async () => {
    mockFetch(404, { message: "Pipeline not found" });

    const { listMilestones } = await import("../src/tools/pipelines.js");
    await expect(listMilestones({ pipelineId: 99999 })).rejects.toThrow(/Capsule API error 404/);
  });
});
