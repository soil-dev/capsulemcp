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

  it("maps ownerId to the bare 'owner' query param", async () => {
    mockFetch(200, { tasks: [] });

    const { listTasks } = await import("../src/tools/tasks.js");
    await listTasks({ ownerId: 643698, page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("owner=643698");
    expect(url).not.toContain("ownerId=");
    expect(url).not.toContain("assignedToUserId=");
  });

  it("defaults status to OPEN when omitted (matches description)", async () => {
    mockFetch(200, { tasks: [] });

    const { listTasks } = await import("../src/tools/tasks.js");
    await listTasks({ page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("status=OPEN");
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

describe("updateTask", () => {
  it("puts only the provided fields to /tasks/:id", async () => {
    mockFetch(200, { task: { id: 5, description: "Updated" } });

    const { updateTask } = await import("../src/tools/tasks.js");
    await updateTask({ id: 5, description: "Updated", dueOn: "2025-12-15" });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tasks/5");
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.task).toEqual({ description: "Updated", dueOn: "2025-12-15" });
  });

  it("maps ownerId to nested owner object", async () => {
    mockFetch(200, { task: { id: 5 } });

    const { updateTask } = await import("../src/tools/tasks.js");
    await updateTask({ id: 5, ownerId: 9 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.task.owner).toEqual({ id: 9 });
    expect(body.task.ownerId).toBeUndefined();
  });

  it("rejects status: 'PENDING' at the schema layer (Capsule rejects on direct set)", async () => {
    // Production write-mode test caught: enum included PENDING but
    // Capsule responds 422 'cannot set task status to PENDING' — that
    // status is reachable only via track machinery. Schema now
    // restricts to the two values that are actually settable.
    const { updateTaskSchema, listTasksSchema } = await import(
      "../src/tools/tasks.js"
    );
    expect(updateTaskSchema.safeParse({ id: 1, status: "PENDING" }).success).toBe(
      false,
    );
    expect(updateTaskSchema.safeParse({ id: 1, status: "OPEN" }).success).toBe(
      true,
    );
    expect(updateTaskSchema.safeParse({ id: 1, status: "COMPLETED" }).success).toBe(
      true,
    );
    // listTasks shares the same enum gap.
    expect(listTasksSchema.safeParse({ status: "PENDING" }).success).toBe(false);
  });
});

describe("deleteTask", () => {
  it("issues DELETE /tasks/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteTask } = await import("../src/tools/tasks.js");
    const result = await deleteTask({ id: 6, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tasks/6");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 6 });
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

describe("getTask", () => {
  it("GETs /tasks/{id}", async () => {
    mockFetch(200, { task: { id: 99, description: "x" } });
    const { getTask } = await import("../src/tools/tasks.js");
    await getTask({ id: 99 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tasks/99");
  });
});

describe("getTasks (batch)", () => {
  it("GETs /tasks/{ids}", async () => {
    mockFetch(200, { tasks: [{ id: 1 }] });
    const { getTasks } = await import("../src/tools/tasks.js");
    await getTasks({ ids: [1, 2] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/tasks\/1,2($|\?)/);
  });
});
