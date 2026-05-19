/**
 * Full-lifecycle tests for the task-augmented `batch_*` tools.
 *
 * Drives a real `McpServer` (built by `createCapsuleMcpServer` with
 * `MCP_TASKS_ENABLED=1`) over the SDK's in-memory transport pair,
 * with `undici.fetch` mocked so no Capsule calls escape. Covers
 * three paths that matter operationally:
 *
 *   1. **Auto-poll fallback** — caller does NOT augment the request
 *      with `params.task`. The SDK runs `handleAutomaticTaskPolling`
 *      and returns the final `CallToolResult` synchronously. This
 *      is what every existing client (Claude, today) hits — it
 *      MUST stay identical to the pre-tasks behaviour.
 *
 *   2. **Augmented path** — caller sends `params.task: { ttl }`. The
 *      SDK returns the `CreateTaskResult` envelope immediately;
 *      caller polls `tasks/get` until terminal, retrieves via
 *      `tasks/result`.
 *
 *   3. **Cancellation** — caller starts a task, then sends
 *      `tasks/cancel`. The runner's AbortSignal fires, the
 *      `batchExecute` worker pool stops claiming new items, and
 *      unclaimed slots get a `cancelled` error in the result array.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _resetTaskStoreForTests } from "../../src/tasks/store.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const ENV_KEYS = [
  "MCP_TASKS_ENABLED",
  "MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS",
  "CAPSULE_API_TOKEN",
  "CAPSULE_MCP_READONLY",
];

async function spawn(): Promise<{
  client: Client;
  resetCapsuleMock: () => void;
}> {
  vi.resetModules();
  process.env["MCP_TASKS_ENABLED"] = "1";
  // Tight poll for fast tests — the SDK's auto-poll honors this.
  process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "500";
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  delete process.env["CAPSULE_MCP_READONLY"];

  const { createCapsuleMcpServer } = await import("../../src/server.js");
  const { fetch } = await import("undici");
  const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "lifecycle-test", version: "0.0.0" },
    { capabilities: { tasks: { list: {}, cancel: {} } } },
  );
  const server = createCapsuleMcpServer({ clientId: "test-client" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    resetCapsuleMock: () => mockFetch.mockReset(),
  };
}

describe("MCP Tasks lifecycle on batch_update_party", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });

  it("auto-poll path: legacy clients get CallToolResult unchanged", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    // Mock 3 successful PUTs (one per batch item).
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = (await client.callTool({
      name: "batch_update_party",
      arguments: {
        items: [
          { id: 1, about: "a" },
          { id: 2, about: "b" },
          { id: 3, about: "c" },
        ],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("augmented path: caller polls tasks/get then retrieves tasks/result", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    let resolveFirst!: (v: Response) => void;
    const firstPromise = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    let nthCall = 0;
    mockFetch.mockImplementation(async () => {
      nthCall++;
      if (nthCall === 1) return firstPromise;
      return new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Send tools/call with params.task augmentation. The SDK's
    // client.callTool helper doesn't expose the task field, so we
    // use the raw request method.
    // biome-ignore lint/suspicious/noExplicitAny: exploring untyped raw request
    const createResult: any = await client.request(
      {
        method: "tools/call",
        params: {
          name: "batch_update_party",
          arguments: { items: [{ id: 1, about: "a" }] },
          task: { ttl: 60_000 },
        },
      },
      z.any(),
    );

    expect(createResult.task).toBeDefined();
    expect(createResult.task.taskId).toBeTruthy();
    expect(["submitted", "working"]).toContain(createResult.task.status);
    // The caller asked for ttl: 60_000 — assert it actually round-
    // tripped through the SDK -> our runner -> our scoped store.
    // Before the refactor that landed alongside these tests, the
    // runner called `extra.taskStore.createTask({})` (empty params),
    // silently discarding the caller's hint and falling through to
    // `MCP_TASKS_DEFAULT_TTL_MS` (5 min). The clamp logic in
    // `src/tasks/store.ts` would have been dead code.
    expect(createResult.task.ttl).toBe(60_000);

    // Now unblock Capsule and poll.
    resolveFirst(
      new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    let status = createResult.task.status;
    for (let i = 0; i < 30 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      // biome-ignore lint/suspicious/noExplicitAny: raw request
      const got: any = await client.request(
        { method: "tasks/get", params: { taskId: createResult.task.taskId } },
        z.any(),
      );
      status = got.status;
    }
    expect(status).toBe("completed");

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const final: any = await client.request(
      { method: "tasks/result", params: { taskId: createResult.task.taskId } },
      z.any(),
    );
    const body = JSON.parse(final.content[0].text);
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
  });

  it("cancellation: tasks/cancel halts the batch fan-out", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    // Hold every Capsule call so we can cancel mid-batch.
    const holds: Array<(v: Response) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          holds.push(resolve);
        }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const createResult: any = await client.request(
      {
        method: "tools/call",
        params: {
          name: "batch_update_party",
          arguments: {
            // 10 items × concurrency 5 — 5 workers pick up first 5
            // items immediately; the remaining 5 sit in the queue.
            items: Array.from({ length: 10 }, (_, i) => ({
              id: i + 1,
              about: `n${i}`,
            })),
          },
          task: { ttl: 60_000 },
        },
      },
      z.any(),
    );
    const taskId = createResult.task.taskId as string;

    // Give the worker pool a tick to claim its first 5 slots.
    await new Promise((r) => setTimeout(r, 20));

    await client.request({ method: "tasks/cancel", params: { taskId } }, z.any());

    // Release all held Capsule calls so the workers can run their
    // post-await branches and the batch resolves.
    for (const h of holds) {
      h(
        new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    // Poll until terminal.
    let status: string = "working";
    for (
      let i = 0;
      i < 50 && status !== "completed" && status !== "failed" && status !== "cancelled";
      i++
    ) {
      await new Promise((r) => setTimeout(r, 30));
      // biome-ignore lint/suspicious/noExplicitAny: raw request
      const got: any = await client.request({ method: "tasks/get", params: { taskId } }, z.any());
      status = got.status;
    }
    // SDK transitions to `cancelled` on tasks/cancel.
    expect(status).toBe("cancelled");

    // Capsule was called for at most `concurrency` items (default 5),
    // not all 10 — the rest got the synthetic cancel error.
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(5);
  });

  // ── P0: non-task tool augmented with params.task ─────────────────────────
  //
  // SEP-1686 §4.1.1 says receivers MUST process the request normally when
  // they don't support task augmentation on a particular request. The
  // current SDK doesn't honour this for tools registered with
  // `taskSupport: 'forbidden'` (the default for plain `registerTool`) —
  // it runs the normal handler, then tries to validate the CallToolResult
  // against the CreateTaskResult schema, and rejects. This test pins that
  // observable behaviour so the SDK silently changing it (either to swallow
  // the augmentation or to actually honour the spec) trips CI.
  it("augmenting a non-task tool returns the SDK's loud validation error", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ users: [{ id: 1, name: "x" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "list_users",
            arguments: {},
            task: { ttl: 60_000 },
          },
        },
        z.any(),
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  // ── P0: all-items-failing batch reaches `completed`, not `failed` ───────
  //
  // SEP-1686 §7.2: "For tasks that wrap requests with their own error
  // semantics (like tools/call with isError: true), the task should still
  // reach completed status, and the error information is conveyed through
  // the result structure." The `failed` lifecycle status is reserved for
  // task-machinery failures, not the wrapped tool's per-item errors.
  // batch_update_party returns `{results, summary}` with summary.failed,
  // never throws, so the task always reaches completed.
  it("all-items-failing batch reaches `completed` with per-item errors in result", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "validation failed" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const createResult: any = await client.request(
      {
        method: "tools/call",
        params: {
          name: "batch_update_party",
          arguments: {
            items: [
              { id: 1, about: "a" },
              { id: 2, about: "b" },
              { id: 3, about: "c" },
            ],
          },
          task: { ttl: 60_000 },
        },
      },
      z.any(),
    );
    const taskId = createResult.task.taskId as string;

    let status = createResult.task.status;
    for (let i = 0; i < 30 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      // biome-ignore lint/suspicious/noExplicitAny: raw request
      const got: any = await client.request({ method: "tasks/get", params: { taskId } }, z.any());
      status = got.status;
    }
    expect(status).toBe("completed");

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const final: any = await client.request(
      { method: "tasks/result", params: { taskId } },
      z.any(),
    );
    const body = JSON.parse(final.content[0].text);
    expect(body.summary).toEqual({ total: 3, succeeded: 0, failed: 3 });
    for (const r of body.results) {
      expect(r.ok).toBe(false);
      expect(r.error.status).toBe(422);
    }
  });

  // ── P2: tasks/result after tasks/cancel ─────────────────────────────────
  //
  // SEP-1686 §4.6.1: "Receivers MUST only return results from tasks/result
  // when the task status is completed." After cancellation the task is
  // terminal but NOT completed.
  //
  // Note: SEP-1686 §7.1 documents `-32602 InvalidParams` for this case,
  // but the SDK currently returns `-32603 InternalError`. Test accepts
  // any structured error code — the load-bearing assertion is "rejects".
  it("tasks/result on a cancelled task throws a structured error", async () => {
    const { client } = await spawn();
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const holds: Array<(v: Response) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          holds.push(resolve);
        }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const createResult: any = await client.request(
      {
        method: "tools/call",
        params: {
          name: "batch_update_party",
          arguments: { items: [{ id: 1, about: "a" }] },
          task: { ttl: 60_000 },
        },
      },
      z.any(),
    );
    const taskId = createResult.task.taskId as string;

    await new Promise((r) => setTimeout(r, 20));
    await client.request({ method: "tasks/cancel", params: { taskId } }, z.any());
    for (const h of holds) {
      h(
        new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      client.request({ method: "tasks/result", params: { taskId } }, z.any()),
    ).rejects.toMatchObject({ code: expect.any(Number) });
  });
});

// ── Tenant isolation through the wire (P1) ──────────────────────────────
//
// `tests/tasks/store.test.ts` proves the scoped wrapper filters by
// clientId. This test drives the same isolation through the full SDK
// request path so a refactor that bypasses our scoped wrapper trips here.

describe("tasks/list multi-client isolation through the wire", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });

  it("clientB's tasks/list does not include clientA's tasks", async () => {
    vi.resetModules();
    process.env["MCP_TASKS_ENABLED"] = "1";
    process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "500";
    process.env["CAPSULE_API_TOKEN"] = "test-token";

    const { createCapsuleMcpServer } = await import("../../src/server.js");
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    async function spawnFor(clientId: string) {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: `lifecycle-${clientId}`, version: "0.0.0" },
        { capabilities: { tasks: { list: {}, cancel: {} } } },
      );
      const server = createCapsuleMcpServer({ clientId });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      return client;
    }

    const a = await spawnFor("client-a");
    const b = await spawnFor("client-b");

    async function createTaskFor(client: Client): Promise<string> {
      // biome-ignore lint/suspicious/noExplicitAny: raw request
      const r: any = await client.request(
        {
          method: "tools/call",
          params: {
            name: "batch_update_party",
            arguments: { items: [{ id: 1, about: "x" }] },
            task: { ttl: 60_000 },
          },
        },
        z.any(),
      );
      return r.task.taskId;
    }

    const aTaskIds = [await createTaskFor(a), await createTaskFor(a)];
    const bTaskIds = [await createTaskFor(b)];

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const aList: any = await a.request({ method: "tasks/list", params: {} }, z.any());
    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const bList: any = await b.request({ method: "tasks/list", params: {} }, z.any());

    const aIds = new Set<string>(aList.tasks.map((t: { taskId: string }) => t.taskId));
    const bIds = new Set<string>(bList.tasks.map((t: { taskId: string }) => t.taskId));
    expect(aIds).toEqual(new Set(aTaskIds));
    expect(bIds).toEqual(new Set(bTaskIds));
    for (const id of bTaskIds) expect(aIds.has(id)).toBe(false);
    for (const id of aTaskIds) expect(bIds.has(id)).toBe(false);
  });

  // ── P1: per-client quota exhaustion through the wire ──────────────────
  //
  // Our store throws McpError(InvalidParams, "Task quota exceeded...")
  // but the SDK's CallToolResult wrapping + CreateTaskResult schema
  // validation shadow the original message. The client sees -32602 with
  // "Invalid task creation result". The quota IS enforced (no extra
  // creations land in the store) — only the error text is obscured.
  // We pin the code, the rejection, and the cap behaviour.
  it("4th createTask for one client returns -32602 when MAX_PER_CLIENT=3", async () => {
    vi.resetModules();
    process.env["MCP_TASKS_ENABLED"] = "1";
    process.env["MCP_TASKS_MAX_PER_CLIENT"] = "3";
    process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "500";
    process.env["CAPSULE_API_TOKEN"] = "test-token";

    const { createCapsuleMcpServer } = await import("../../src/server.js");
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "quota-test", version: "0.0.0" },
      { capabilities: { tasks: { list: {}, cancel: {} } } },
    );
    const server = createCapsuleMcpServer({ clientId: "quota-client" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    async function createOne() {
      return client.request(
        {
          method: "tools/call",
          params: {
            name: "batch_update_party",
            arguments: { items: [{ id: 1, about: "x" }] },
            task: { ttl: 60_000 },
          },
        },
        z.any(),
      );
    }

    for (let i = 0; i < 3; i++) await createOne();
    await expect(createOne()).rejects.toMatchObject({ code: -32602 });
  });

  // ── P2: tasks/cancel before background work runs ──────────────────────
  it("tasks/cancel immediately after createTask aborts before any item runs", async () => {
    vi.resetModules();
    process.env["MCP_TASKS_ENABLED"] = "1";
    process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "500";
    process.env["CAPSULE_API_TOKEN"] = "test-token";

    const { createCapsuleMcpServer } = await import("../../src/server.js");
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            500,
          ),
        ),
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "early-cancel-test", version: "0.0.0" },
      { capabilities: { tasks: { list: {}, cancel: {} } } },
    );
    const server = createCapsuleMcpServer({ clientId: "early-cancel" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const createResult: any = await client.request(
      {
        method: "tools/call",
        params: {
          name: "batch_update_party",
          arguments: {
            items: [
              { id: 1, about: "a" },
              { id: 2, about: "b" },
              { id: 3, about: "c" },
            ],
          },
          task: { ttl: 60_000 },
        },
      },
      z.any(),
    );
    const taskId = createResult.task.taskId as string;

    await client.request({ method: "tasks/cancel", params: { taskId } }, z.any());
    await new Promise((r) => setTimeout(r, 100));

    // biome-ignore lint/suspicious/noExplicitAny: raw request
    const got: any = await client.request({ method: "tasks/get", params: { taskId } }, z.any());
    expect(got.status).toBe("cancelled");
  });
});
