/**
 * Per-clientId scoped wrapper around the SDK's `InMemoryTaskStore`.
 *
 * The SDK auto-registers handlers for `tasks/get`, `tasks/result`,
 * `tasks/list`, and `tasks/cancel` when an `McpServer` is constructed
 * with a `taskStore`. Those handlers call our store directly, so the
 * store is the single point at which we can enforce the security
 * boundary we need:
 *
 *   - In capsulemcp's HTTP transport, each POST `/mcp` is its own
 *     stateless request. The `McpServer` is built fresh per request.
 *     The `TaskStore` therefore MUST be a process-singleton — if we
 *     gave each request a private store, the very next `tasks/get`
 *     wouldn't see the task that was just created.
 *
 *   - But a singleton has a footgun: any authenticated caller could
 *     poll any taskId — including taskIds owned by another OAuth
 *     client. SEP-1686 §8 ("Security Considerations") specifically
 *     calls out this scenario.
 *
 * The fix is `createScopedTaskStore(clientId)` — a per-request thin
 * wrapper that snapshots the caller's OAuth `clientId` at
 * construction, delegates every operation to the singleton, and
 * cross-checks the recorded owner of each taskId before returning
 * (or modifying) anything. A caller from clientId A sees `null` /
 * `task not found` for any taskId created by clientId B, exactly as
 * if it didn't exist.
 *
 * The wrapper also enforces two DoS caps cheaply:
 *
 *   - `maxPerClient` — per-clientId task count, defense against a
 *     compromised single tenant.
 *   - `maxTotal` — process-wide ceiling, defense against many
 *     tenants pushing simultaneously. With our current Cloud Run
 *     topology (`max_instance_count=1`, `min_instance_count=0`)
 *     the ceiling is the actual memory budget.
 *
 * On scale-to-zero, the singleton evaporates along with the
 * instance — all in-flight tasks are silently dropped. This is a
 * known limitation documented in DEPLOY.md; an external `TaskStore`
 * (Firestore/Redis) is the future upgrade path noted in IDEAS.md.
 */

import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  ErrorCode,
  McpError,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { logEvent } from "../log.js";
import { getTasksConfig } from "./config.js";

/**
 * Process-singleton SDK store. Lazily initialised so importing this
 * module is side-effect-free (matches the rest of the codebase).
 */
let _globalStore: InMemoryTaskStore | null = null;

function getGlobalStore(): InMemoryTaskStore {
  if (_globalStore === null) {
    _globalStore = new InMemoryTaskStore();
  }
  return _globalStore;
}

/**
 * Augment map: records the owning `clientId` for every taskId we
 * hand out. Lookups against the SDK store are gated through this
 * map; mismatched-owner reads are reported as `not found` to avoid
 * leaking the existence of a foreign task.
 */
const owners = new Map<string, string>();

/**
 * Per-task AbortController registry. The SDK's `tasks/cancel`
 * handler only updates the task status to `cancelled` — it does NOT
 * fire any AbortSignal. To make cancellation actually halt our
 * background batch fan-outs, the runner (`src/server/register-tool.ts`)
 * registers a controller here before kicking off work, and our
 * `updateTaskStatus` override below fires the controller when the
 * SDK transitions a task to `cancelled`. Cleared on terminal
 * transitions and on TTL eviction so the controllers don't leak.
 */
const abortControllers = new Map<string, AbortController>();

/**
 * Runner-facing hook. Registers an AbortController for a task; when
 * the task's status flips to `cancelled` via the SDK's tasks/cancel
 * handler (which calls `updateTaskStatus` on our store), the
 * controller's `signal` fires. Called from the task runner right
 * after `createTask` so there's no window where a tasks/cancel
 * arrives before the abort handler is wired.
 */
export function registerAbortController(taskId: string, controller: AbortController): void {
  abortControllers.set(taskId, controller);
}

/** Test-only reset hook. Clears the singleton and owner map. */
export function _resetTaskStoreForTests(): void {
  _globalStore?.cleanup();
  _globalStore = null;
  owners.clear();
  for (const ctrl of abortControllers.values()) ctrl.abort();
  abortControllers.clear();
}

function countPerClient(clientId: string): number {
  let n = 0;
  for (const owner of owners.values()) {
    if (owner === clientId) n++;
  }
  return n;
}

/**
 * Build a per-clientId TaskStore wrapper bound to the singleton.
 *
 * Returns a fresh wrapper on every call (cheap — just a closure over
 * `clientId`), so each McpServer constructed for an inbound HTTP
 * request gets its own wrapper without sharing mutable state.
 */
export function createScopedTaskStore(clientId: string): TaskStore {
  if (!clientId) {
    // Tasks require an authenticated caller. Reject explicitly so
    // the bug — if any — surfaces in tests rather than silently
    // creating world-readable tasks.
    throw new Error("createScopedTaskStore: clientId is required");
  }

  const global = getGlobalStore();

  /**
   * Returns the task if and only if it exists AND is owned by this
   * wrapper's clientId. Otherwise returns null — same shape the SDK
   * returns for genuinely-missing tasks, so the SDK's `tasks/get`
   * handler converts it to a standard "task not found" error.
   */
  async function getOwned(taskId: string): Promise<Task | null> {
    if (owners.get(taskId) !== clientId) return null;
    return global.getTask(taskId);
  }

  return {
    async createTask(
      taskParams: CreateTaskOptions,
      requestId: RequestId,
      request: Request,
      sessionId?: string,
    ): Promise<Task> {
      const cfg = getTasksConfig();

      // Quota enforcement first — cheapest reject path.
      const totalNow = owners.size;
      if (totalNow >= cfg.maxTotal) {
        logEvent("task.rejected", {
          reason: "max_total",
          clientId,
          totalNow,
          cap: cfg.maxTotal,
        });
        throw new McpError(ErrorCode.InvalidParams, "Task quota exceeded for this server instance");
      }
      const perClientNow = countPerClient(clientId);
      if (perClientNow >= cfg.maxPerClient) {
        logEvent("task.rejected", {
          reason: "max_per_client",
          clientId,
          perClientNow,
          cap: cfg.maxPerClient,
        });
        throw new McpError(ErrorCode.InvalidParams, "Task quota exceeded for this client");
      }

      // Clamp TTL to [0, maxKeepAliveMs]. `null` (unlimited) is
      // never honoured — we only support a bounded retention window
      // in the in-memory store, otherwise a stuck task pins memory
      // until process restart.
      const requestedTtl = taskParams.ttl ?? cfg.defaultTtlMs;
      const clampedTtl =
        requestedTtl === null
          ? cfg.maxKeepAliveMs
          : Math.max(1000, Math.min(requestedTtl, cfg.maxKeepAliveMs));

      // Same applies to pollInterval — accept the caller's hint but
      // floor it at the configured suggestion to avoid hot loops.
      const requestedPoll = taskParams.pollInterval ?? cfg.defaultPollFrequencyMs;
      const clampedPoll = Math.max(cfg.defaultPollFrequencyMs, Math.floor(requestedPoll));

      const task = await global.createTask(
        { ttl: clampedTtl, pollInterval: clampedPoll, context: taskParams.context },
        requestId,
        request,
        sessionId,
      );
      owners.set(task.taskId, clientId);

      // Schedule augment-map cleanup at TTL. The SDK sweeps its own
      // map; we sweep ours in lockstep so the maps don't drift. Use
      // `unref` so this timer doesn't keep the Node event loop alive
      // (Cloud Run instances must be free to scale to zero).
      const timer = setTimeout(() => {
        owners.delete(task.taskId);
        abortControllers.delete(task.taskId);
        logEvent("task.evicted", { taskId: task.taskId, clientId, reason: "ttl" });
      }, clampedTtl);
      timer.unref?.();

      logEvent("task.created", {
        taskId: task.taskId,
        clientId,
        ttl: clampedTtl,
        pollInterval: clampedPoll,
        method:
          typeof (request as { method?: unknown }).method === "string"
            ? (request as { method: string }).method
            : "unknown",
      });

      return task;
    },

    async getTask(taskId: string): Promise<Task | null> {
      return getOwned(taskId);
    },

    async storeTaskResult(
      taskId: string,
      status: "completed" | "failed",
      result: Result,
      sessionId?: string,
    ): Promise<void> {
      // Result-storing comes from the task's own runner (in PR2),
      // which already knows the owning clientId because it's the
      // same scoped wrapper the createTask call ran through. Still
      // belt-and-braces: drop the write if the owner doesn't match.
      if (owners.get(taskId) !== clientId) {
        throw new McpError(ErrorCode.InvalidParams, "Task not found");
      }
      logEvent("task.transition", { taskId, clientId, status });
      await global.storeTaskResult(taskId, status, result, sessionId);
    },

    async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
      if (owners.get(taskId) !== clientId) {
        throw new McpError(ErrorCode.InvalidParams, "Task not found");
      }
      return global.getTaskResult(taskId, sessionId);
    },

    async updateTaskStatus(
      taskId: string,
      status: Task["status"],
      statusMessage?: string,
      sessionId?: string,
    ): Promise<void> {
      if (owners.get(taskId) !== clientId) {
        throw new McpError(ErrorCode.InvalidParams, "Task not found");
      }
      logEvent("task.transition", { taskId, clientId, status, statusMessage });
      await global.updateTaskStatus(taskId, status, statusMessage, sessionId);
      // Fire the runner-registered AbortController when the SDK's
      // tasks/cancel handler transitions us into `cancelled` — that
      // handler does the status flip but does NOT abort any
      // signal, so without this hook the background batch
      // fan-out runs to completion and the cancellation is purely
      // bookkeeping. With this hook, the runner's batchExecute
      // sees `signal.aborted` between items and stops claiming.
      if (status === "cancelled") {
        const ctrl = abortControllers.get(taskId);
        if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      }
      // Drop the controller reference on any terminal transition;
      // no need to keep aborting nothing.
      if (status === "completed" || status === "failed" || status === "cancelled") {
        abortControllers.delete(taskId);
      }
    },

    async listTasks(
      cursor?: string,
      sessionId?: string,
    ): Promise<{ tasks: Task[]; nextCursor?: string }> {
      // Pull the underlying page, then filter to entries we own.
      // Cursor opacity is preserved: we hand the SDK's cursor back
      // to the caller verbatim, so the next call continues from the
      // SDK's idea of "next page" — not ours. This means a clientId
      // with sparse ownership may get a short page; clients should
      // page until `nextCursor` is absent, which is exactly what
      // the spec already requires.
      const page = await global.listTasks(cursor, sessionId);
      const filtered = page.tasks.filter((t) => owners.get(t.taskId) === clientId);
      return page.nextCursor
        ? { tasks: filtered, nextCursor: page.nextCursor }
        : { tasks: filtered };
    },
  };
}

/**
 * Test/debug helper. Returns a snapshot of the augment map so tests
 * can assert ownership transitions without poking the SDK store
 * internals.
 */
export function _ownersSnapshot(): ReadonlyMap<string, string> {
  return new Map(owners);
}
