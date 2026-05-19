/**
 * Full-lifecycle tests for the task-augmented `batch_*` tools.
 *
 * Drives a real `McpServer` (built by `createCapsuleMcpServer` with
 * `MCP_TASKS_ENABLED=1`) over the SDK's in-memory transport pair,
 * with `undici.fetch` mocked so no Capsule calls escape. Covers
 * three paths that matter operationally:
 *
 *   1. **Auto-poll fallback** — caller does NOT augment the request
 *      with `_meta.task`. The SDK runs `handleAutomaticTaskPolling`
 *      and returns the final `CallToolResult` synchronously. This
 *      is what every existing client (Claude, today) hits — it
 *      MUST stay identical to the pre-tasks behaviour.
 *
 *   2. **Augmented path** — caller sends `_meta.task: { ttl }`. The
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

    // Send tools/call with _meta.task augmentation. The SDK's
    // client.callTool helper doesn't expose the meta hook, so we
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
});
