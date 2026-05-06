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

describe("listTasks", () => {
  it("returns tasks", async () => {
    mockFetch(200, { tasks: [{ id: 1, description: "Call client" }] });

    const { listTasks } = await import("../src/tools/tasks.js");
    const result = await listTasks({ status: "OPEN", page: 1, perPage: 25 });

    expect(result.tasks).toHaveLength(1);
  });
});

describe("createTask", () => {
  it("posts with linked party as nested object", async () => {
    mockFetch(201, { task: { id: 5, description: "Follow up" } });

    const { createTask } = await import("../src/tools/tasks.js");
    await createTask({ description: "Follow up", dueOn: "2025-12-01", partyId: 10 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.task.party).toEqual({ id: 10 });
    expect(body.task.partyId).toBeUndefined();
  });

  it("throws if multiple link targets are given", async () => {
    const { createTask } = await import("../src/tools/tasks.js");
    await expect(
      createTask({ description: "Bad", dueOn: "2025-12-01", partyId: 1, opportunityId: 2 }),
    ).rejects.toThrow("at most one");
  });
});

describe("completeTask", () => {
  it("puts status COMPLETED to /tasks/:id", async () => {
    mockFetch(200, { task: { id: 5, status: "COMPLETED" } });

    const { completeTask } = await import("../src/tools/tasks.js");
    await completeTask({ id: 5 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tasks/5");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.task.status).toBe("COMPLETED");
  });
});
