/**
 * Tests for the per-clientId scoped task store wrapper.
 *
 * Three things matter and are covered here:
 *
 *   1. Tenant isolation: a wrapper bound to clientId A must not see,
 *      modify, or list tasks owned by clientId B. The SEP-1686
 *      security model lives in this wrapper, so the assertions are
 *      pointed.
 *
 *   2. DoS caps: maxPerClient and maxTotal must throw the documented
 *      McpError(InvalidParams) when exceeded, with the per-client
 *      cap firing on the offender even when total has room.
 *
 *   3. TTL/poll clamping: caller-supplied values are floored at the
 *      configured floor and ceiled at the configured max. `null`
 *      ttl is converted to maxKeepAliveMs, never stored as unlimited.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  _ownersSnapshot,
  _resetTaskStoreForTests,
  createScopedTaskStore,
} from "../../src/tasks/store.js";

const ENV_KEYS = [
  "MCP_TASKS_ENABLED",
  "MCP_TASKS_DEFAULT_TTL_MS",
  "MCP_TASKS_MAX_KEEP_ALIVE_MS",
  "MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS",
  "MCP_TASKS_MAX_PER_CLIENT",
  "MCP_TASKS_MAX_TOTAL",
];

const FAKE_REQUEST = {
  method: "tools/call",
  params: { name: "noop", arguments: {} },
};

async function create(store: ReturnType<typeof createScopedTaskStore>, n = 1) {
  const created = [];
  for (let i = 0; i < n; i++) {
    const t = await store.createTask({ ttl: 60_000 }, i + 1, FAKE_REQUEST);
    created.push(t);
  }
  return created;
}

describe("createScopedTaskStore", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });

  it("rejects construction without a clientId", () => {
    expect(() => createScopedTaskStore("")).toThrow(/clientId is required/);
  });

  describe("tenant isolation", () => {
    it("clientB cannot getTask a task created by clientA", async () => {
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      const [task] = await create(a, 1);
      expect(await b.getTask(task.taskId)).toBeNull();
      expect(await a.getTask(task.taskId)).not.toBeNull();
    });

    it("clientB cannot getTaskResult a task created by clientA", async () => {
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      const [task] = await create(a, 1);
      await a.storeTaskResult(task.taskId, "completed", {
        content: [{ type: "text", text: "done" }],
        isError: false,
      });
      await expect(b.getTaskResult(task.taskId)).rejects.toBeInstanceOf(McpError);
    });

    it("clientB cannot updateTaskStatus a task created by clientA", async () => {
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      const [task] = await create(a, 1);
      await expect(b.updateTaskStatus(task.taskId, "working")).rejects.toBeInstanceOf(McpError);
    });

    it("listTasks for clientB excludes clientA's tasks", async () => {
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      await create(a, 3);
      await create(b, 2);
      const pageA = await a.listTasks();
      const pageB = await b.listTasks();
      expect(pageA.tasks).toHaveLength(3);
      expect(pageB.tasks).toHaveLength(2);
      const idsA = new Set(pageA.tasks.map((t) => t.taskId));
      for (const t of pageB.tasks) expect(idsA.has(t.taskId)).toBe(false);
    });
  });

  describe("DoS caps", () => {
    it("rejects when per-client cap is hit even if total has room", async () => {
      process.env["MCP_TASKS_MAX_PER_CLIENT"] = "2";
      process.env["MCP_TASKS_MAX_TOTAL"] = "100";
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      await create(a, 2);
      await expect(create(a, 1)).rejects.toThrow(/Task quota exceeded for this client/);
      // Other clients are unaffected.
      await expect(create(b, 1)).resolves.toBeTruthy();
    });

    it("rejects when total cap is hit before per-client", async () => {
      process.env["MCP_TASKS_MAX_PER_CLIENT"] = "10";
      process.env["MCP_TASKS_MAX_TOTAL"] = "2";
      const a = createScopedTaskStore("client-a");
      const b = createScopedTaskStore("client-b");
      await create(a, 1);
      await create(b, 1);
      await expect(create(a, 1)).rejects.toThrow(/Task quota exceeded for this server instance/);
    });
  });

  describe("clamping", () => {
    it("clamps requested ttl to maxKeepAliveMs", async () => {
      process.env["MCP_TASKS_MAX_KEEP_ALIVE_MS"] = "10000";
      const a = createScopedTaskStore("client-a");
      const t = await a.createTask({ ttl: 999_999 }, 1, FAKE_REQUEST);
      expect(t.ttl).toBe(10_000);
    });

    it("clamps null ttl to maxKeepAliveMs (no unlimited)", async () => {
      process.env["MCP_TASKS_MAX_KEEP_ALIVE_MS"] = "8000";
      process.env["MCP_TASKS_DEFAULT_TTL_MS"] = "2000";
      const a = createScopedTaskStore("client-a");
      const t = await a.createTask({ ttl: null }, 1, FAKE_REQUEST);
      expect(t.ttl).toBe(8000);
    });

    it("floors pollInterval at the configured suggestion", async () => {
      process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "2000";
      const a = createScopedTaskStore("client-a");
      const t = await a.createTask({ ttl: 60_000, pollInterval: 50 }, 1, FAKE_REQUEST);
      expect(t.pollInterval).toBe(2000);
    });
  });

  describe("owner map bookkeeping", () => {
    it("records owning clientId for every task", async () => {
      const a = createScopedTaskStore("client-a");
      const [t1, t2] = await create(a, 2);
      const snap = _ownersSnapshot();
      expect(snap.get(t1.taskId)).toBe("client-a");
      expect(snap.get(t2.taskId)).toBe("client-a");
    });
  });
});
