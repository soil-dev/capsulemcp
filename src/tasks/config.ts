/**
 * Resolved configuration for the MCP Tasks (SEP-1686) subsystem.
 *
 * Read at call time (not module init) so tests can flip env vars per
 * case without reloading the module. Same convention as
 * `getCacheTtlMs()` in `src/capsule/cache.ts`.
 *
 * The whole subsystem is **off by default** — `MCP_TASKS_ENABLED=1`
 * is the master switch. When unset, `createCapsuleMcpServer` does
 * not advertise the `tasks` capability and constructs the SDK
 * server with no `taskStore`, so the four `tasks/*` request handlers
 * are not registered. Existing callers see the connector behave
 * exactly as it did before this code shipped.
 *
 * The six `batch_*` write tools opt in when a task store is wired
 * (`registerToolTask` with `taskSupport: "optional"`). Enabling
 * tasks is non-breaking for callers that omit `params.task`: the
 * SDK's `handleAutomaticTaskPolling` keeps them on the synchronous-
 * response path. See OPTIMIZATIONS.md / DESIGN.md.
 */

import { readBool, readPositiveInt } from "../env.js";

/** Default TTL applied when a caller's `task.ttl` is absent. */
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Hard ceiling on requested `task.ttl`. Callers asking for more get clamped. */
const DEFAULT_MAX_KEEP_ALIVE_MS = 15 * 60 * 1000; // 15 minutes
/** Minimum retention window; shorter values make task polling race cleanup. */
export const MIN_TASK_TTL_MS = 1000;
/** Suggested polling interval surfaced to clients on each `tasks/get`. */
const DEFAULT_POLL_FREQUENCY_MS = 1500;
/** Floor on the suggested polling interval — under this we churn the wire. */
const MIN_POLL_FREQUENCY_MS = 500;
/** Per-client task quota. Cheap DoS guard for the in-memory store. */
const DEFAULT_MAX_PER_CLIENT = 20;
/** Process-wide task quota — second DoS guard, total memory ceiling. */
const DEFAULT_MAX_TOTAL = 200;

export interface TasksConfig {
  /** Master switch. `false` ⇒ subsystem is invisible to the wire protocol. */
  enabled: boolean;
  /** Applied when caller omits `task.ttl`. Always ≤ `maxKeepAliveMs`. */
  defaultTtlMs: number;
  /** Hard upper bound on any `task.ttl` (caller-provided or default). */
  maxKeepAliveMs: number;
  /** Suggested poll frequency returned on `tasks/get`. */
  defaultPollFrequencyMs: number;
  /** Per-clientId task cap. Throws InvalidParams on overflow. */
  maxPerClient: number;
  /** Process-wide task cap. Throws InvalidParams on overflow. */
  maxTotal: number;
}

/**
 * Resolve the current tasks configuration from environment.
 *
 * `defaultTtlMs` is clamped to `maxKeepAliveMs` (operator who sets a
 * larger default than the ceiling probably meant the latter to be
 * larger too — but the runtime enforces the ceiling regardless).
 * Both values are floored at `MIN_TASK_TTL_MS` so the store's
 * effective task TTL cannot exceed an operator's configured ceiling
 * just because the ceiling was below the polling-safe minimum.
 *
 * `defaultPollFrequencyMs` is clamped to `MIN_POLL_FREQUENCY_MS` so
 * a typo can't suggest a 50 ms poll loop.
 */
export function getTasksConfig(): TasksConfig {
  const enabled = readBool("MCP_TASKS_ENABLED");
  const maxKeepAliveMs = Math.max(
    readPositiveInt("MCP_TASKS_MAX_KEEP_ALIVE_MS", DEFAULT_MAX_KEEP_ALIVE_MS),
    MIN_TASK_TTL_MS,
  );
  const defaultTtlMs = Math.min(
    Math.max(readPositiveInt("MCP_TASKS_DEFAULT_TTL_MS", DEFAULT_TTL_MS), MIN_TASK_TTL_MS),
    maxKeepAliveMs,
  );
  const defaultPollFrequencyMs = Math.max(
    readPositiveInt("MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS", DEFAULT_POLL_FREQUENCY_MS),
    MIN_POLL_FREQUENCY_MS,
  );
  const maxPerClient = readPositiveInt("MCP_TASKS_MAX_PER_CLIENT", DEFAULT_MAX_PER_CLIENT);
  const maxTotal = readPositiveInt("MCP_TASKS_MAX_TOTAL", DEFAULT_MAX_TOTAL);
  return {
    enabled,
    defaultTtlMs,
    maxKeepAliveMs,
    defaultPollFrequencyMs,
    maxPerClient,
    maxTotal,
  };
}
