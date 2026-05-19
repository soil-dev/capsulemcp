/**
 * Regression test for the "augmented-path task crash" bug fixed in
 * v1.6.0-alpha.2.
 *
 * Under stateless HTTP POST `/mcp`, the SDK's `updateTaskStatus` and
 * `storeTaskResult` wrappers (in shared/protocol.js) emit a
 * `notifications/tasks/status` push on the *original* request's
 * notification channel after each store mutation. By the time our
 * background runner finishes the actual work and tries to store the
 * result, the original `tools/call` request has long since resolved
 * (we returned `{ task }` synchronously) and its SSE stream is
 * closed. The notification throws.
 *
 * The pre-fix runner had a single catch that called `storeTaskResult`
 * a second time to mark the task `failed` — but the underlying store
 * already had the result in terminal status, so SDK threw "results
 * can only be stored once", which became an unhandled rejection from
 * the `void(async()=>...)` IIFE → process exit(1) → instance recycle
 * → all in-flight tasks for all clients lost.
 *
 * The fix decouples the handler-error branch from the
 * storeTaskResult-error branch. This test forces the notification
 * path to throw and asserts:
 *
 *   1. The runner completes without an unhandled rejection.
 *   2. The task reaches `completed` status in the underlying store.
 *   3. `tasks/result` returns the right payload.
 *
 * If anyone removes the post-store try/catch, this test crashes
 * vitest with an unhandled rejection. Belt and braces.
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

describe("stateless-POST resilience: notification throws don't crash the runner", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });

  it("survives notifications/tasks/status throws on closed channel", async () => {
    vi.resetModules();
    process.env["MCP_TASKS_ENABLED"] = "1";
    process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "500";
    process.env["CAPSULE_API_TOKEN"] = "test-token";

    const { createCapsuleMcpServer } = await import("../../src/server.js");
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "stateless-test", version: "0.0.0" },
      { capabilities: { tasks: { list: {}, cancel: {} } } },
    );
    const server = createCapsuleMcpServer({ clientId: "test-client" });

    // Reach into the underlying protocol layer and force every
    // outgoing `notifications/tasks/status` to throw — exactly what
    // happens under stateless POST when the SSE stream has closed
    // before the background work finishes.
    // biome-ignore lint/suspicious/noExplicitAny: probing SDK internals
    const innerServer = (server as any).server;
    const originalNotification = innerServer.notification.bind(innerServer);
    innerServer.notification = vi.fn(async (n: { method: string }) => {
      if (n.method === "notifications/tasks/status") {
        throw new Error("Not connected (stream closed)");
      }
      return originalNotification(n);
    });

    // Surface unhandled rejections as test failures — the whole
    // point of the fix is that the void IIFE doesn't produce any.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    try {
      await Promise.all([server.connect(serverT), client.connect(clientT)]);

      // Augment with params.task so we hit the CreateTaskResult path
      // (the auto-poll path doesn't trigger the bug — the
      // notification channel is kept alive for the duration of the
      // outer request).
      // biome-ignore lint/suspicious/noExplicitAny: raw request
      const createResult: any = await client.request(
        {
          method: "tools/call",
          params: {
            name: "batch_update_party",
            arguments: { items: [{ id: 1, about: "regression" }] },
            task: { ttl: 60_000 },
          },
        },
        z.any(),
      );
      const taskId = createResult.task.taskId as string;
      expect(taskId).toBeTruthy();

      // Poll until terminal — fix ensures we *do* reach terminal
      // even though every notification throws.
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
      expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });

      // Let any deferred rejections settle.
      await new Promise((r) => setTimeout(r, 50));

      // The bug manifested as an unhandled rejection from the
      // void IIFE; this assertion is the canary.
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
