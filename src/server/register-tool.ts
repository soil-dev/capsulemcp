/**
 * Helper to register an MCP tool whose handler returns any value and
 * needs to be wrapped in the standard JSON-stringify-into-text MCP
 * response shape.
 *
 * Why this exists:
 * - Reduces 8 lines per `server.tool(...)` registration to a single
 *   call, collapsing >400 LOC of repetitive wrapper boilerplate
 *   in src/server.ts.
 * - Puts the tool NAME and DESCRIPTION on the same call (positional
 *   args 2 and 3), eliminating the "Edit collapses two adjacent
 *   string lines" footgun that has hit the alpha series three times
 *   while editing description text.
 *
 * The exception is `get_attachment` — its handler does
 * content-type-aware response shaping (image vs text vs binary) and
 * needs the raw `server.tool(...)` call. That registration stays
 * inline.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";
import { registerAbortController } from "../tasks/store.js";

/** Wrap a handler's return value in the MCP `content: [{text}]` shape. */
function wrapAsText(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Register an MCP tool whose handler takes a zod-typed input and
 * returns any JSON-serialisable value. The value gets wrapped in the
 * standard MCP text-content response.
 */
export function registerTool<Schema extends z.ZodObject<ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  schema: Schema,
  handler: (input: z.infer<Schema>) => Promise<unknown>,
): void {
  // Use the SDK config-form registerTool with the full Zod schema. The
  // deprecated shape overload rebuilds z.object(schema.shape), which drops
  // object-level refinements such as superRefine.
  const registerWithSchema = server.registerTool.bind(server) as (
    toolName: string,
    config: { description: string; inputSchema: Schema },
    callback: (input: z.infer<Schema>) => Promise<CallToolResult>,
  ) => void;

  registerWithSchema(name, { description, inputSchema: schema }, async (input) => {
    const result = await handler(input);
    return wrapAsText(result);
  });
}

/**
 * Register a task-augmented MCP tool (SEP-1686).
 *
 * Behaviour with `taskSupport: 'optional'`:
 *
 *   - Caller does **not** send `_meta.task` → SDK runs
 *     `handleAutomaticTaskPolling`: calls our `createTask`, polls
 *     the store internally, returns the final `CallToolResult` to
 *     the client. Caller never sees a task envelope. This is what
 *     existing clients (Claude, today) hit; behaviour is identical
 *     to the non-task path apart from the SDK's internal polling.
 *
 *   - Caller sends `_meta.task: { ttl?, pollInterval? }` → SDK
 *     calls our `createTask`, returns the `CreateTaskResult`
 *     envelope synchronously. Caller polls via `tasks/get` and
 *     retrieves via `tasks/result`.
 *
 * Handler signature mirrors `registerTool`'s, plus an optional
 * `opts: { signal?: AbortSignal }` second arg. The signal fires
 * when the caller sends `tasks/cancel` (or `notifications/cancelled`
 * on the original request id) — handlers that fan out (the 5
 * `batch_*` writes today) pass the signal into `batchExecute` so
 * unclaimed items get a `cancelled` error rather than running.
 *
 * The handler's return value is wrapped identically to
 * `registerTool` so the eventual `tasks/result` payload looks the
 * same as a synchronous `tools/call` result.
 */
export function registerToolTask<Schema extends z.ZodObject<ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  schema: Schema,
  handler: (input: z.infer<Schema>, opts: { signal?: AbortSignal }) => Promise<unknown>,
): void {
  // We reach into the experimental namespace; the SDK explicitly
  // labels these APIs as such ("WARNING: These APIs are experimental
  // and may change without notice"). Keeping the surface area we
  // touch here narrow makes future SDK upgrades a one-file change.
  // Same casting trick as registerTool above: the SDK's overload
  // signatures parameterise on a custom AnySchema / ZodRawShapeCompat
  // pair that TS can't infer directly from our z.ZodObject. Bind
  // to a function type that mentions exactly the surface we want
  // (description + inputSchema + execution).
  type TaskHandler = {
    createTask: (input: z.infer<Schema>, extra: CreateTaskRequestHandlerExtra) => Promise<unknown>;
    getTask: (input: z.infer<Schema>, extra: TaskRequestHandlerExtra) => Promise<unknown>;
    getTaskResult: (
      input: z.infer<Schema>,
      extra: TaskRequestHandlerExtra,
    ) => Promise<CallToolResult>;
  };
  const registerWithSchema = server.experimental.tasks.registerToolTask.bind(
    server.experimental.tasks,
  ) as (
    name: string,
    config: {
      description: string;
      inputSchema: Schema;
      execution: { taskSupport: "optional" | "required" };
    },
    handler: TaskHandler,
  ) => void;

  registerWithSchema(
    name,
    {
      description,
      inputSchema: schema,
      execution: { taskSupport: "optional" },
    },
    {
      createTask: async (input: z.infer<Schema>, extra: CreateTaskRequestHandlerExtra) => {
        // The SDK exposes a *simplified* `RequestTaskStore` surface
        // via `extra.taskStore` — `createTask` here takes only
        // `taskParams`; the SDK threads `requestId` and the original
        // `request` internally. The full 4-arg surface only exists
        // on the underlying `TaskStore` we passed to the server.
        const task = await extra.taskStore.createTask({});

        // Wire a per-task AbortController BEFORE kicking off the
        // background work. The SDK's `tasks/cancel` handler only
        // flips the task's status — our store override (see
        // src/tasks/store.ts) is what fires this controller. Doing
        // this before the void IIFE guarantees there's no window
        // where a tasks/cancel arrives before the abort hook is
        // installed: the SDK's tasks/cancel call also goes through
        // `extra.taskStore`, which won't see the cancellation flip
        // until our `createTask` resolves anyway. Using a per-task
        // controller (not `extra.signal`) because `extra.signal`
        // belongs to the original `tools/call` request — that
        // request resolves the instant we return `{ task }`, so
        // its signal is no longer useful.
        const abortController = new AbortController();
        registerAbortController(task.taskId, abortController);

        // Background execution — the whole point of tasks is that
        // the JSON-RPC response returns before the work finishes.
        // Errors go into the task as a `failed` CallToolResult
        // (isError: true); they MUST NOT propagate out (no one is
        // awaiting this promise) and they MUST NOT use the task
        // `failed` lifecycle status, which is reserved for
        // task-machinery failures, not the wrapped tool's own
        // error path. See SEP-1686 §7.2.
        void (async () => {
          try {
            await extra.taskStore.updateTaskStatus(task.taskId, "working");
            const result = await handler(input, {
              signal: abortController.signal,
            });
            // If cancellation fired during execution, the task's
            // status is already `cancelled` (terminal) — SEP-1686
            // §4.3 forbids transitioning out of terminal states.
            // Skip the storeTaskResult call rather than provoke
            // the SDK's "cannot transition terminal task" error.
            if (!abortController.signal.aborted) {
              await extra.taskStore.storeTaskResult(task.taskId, "completed", wrapAsText(result));
            }
          } catch (err) {
            if (abortController.signal.aborted) return;
            // Capsule error text can include CRM data; surface it
            // via the same isError: true shape a synchronous tool
            // call would have used, so callers using `tasks/result`
            // see the same body shape they'd see from `tools/call`.
            const message = err instanceof Error ? err.message : String(err);
            await extra.taskStore.storeTaskResult(task.taskId, "completed", {
              content: [{ type: "text", text: message }],
              isError: true,
            });
          }
        })();

        return { task };
      },
      getTask: async (_input: z.infer<Schema>, extra: TaskRequestHandlerExtra) =>
        extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_input: z.infer<Schema>, extra: TaskRequestHandlerExtra) => {
        const r = await extra.taskStore.getTaskResult(extra.taskId);
        return r as CallToolResult;
      },
    },
  );
}
