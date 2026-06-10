/**
 * Structured-event logging for runtime observability.
 *
 * Emits single-line JSON to stderr when `CAPSULE_MCP_LOG_VERBOSE=1`.
 * Cloud Run's logging agent auto-parses single-line JSON written to
 * stderr into structured `jsonPayload` fields, so events become
 * queryable via gcloud logging — e.g.:
 *
 *   gcloud logging read \
 *     'jsonPayload.event="cache.hit"' \
 *     --project=<your-gcp-project> --freshness=7d --limit=100
 *
 *   gcloud logging read \
 *     'jsonPayload.event="cache.miss" AND jsonPayload.reason="expired"' \
 *     --project=<your-gcp-project> --freshness=7d
 *
 * Why opt-in:
 *
 * The cache and request paths are hot — emitting a log line on every
 * tool call would quadruple log volume for everyone, most of whom
 * don't need it. Flipping `CAPSULE_MCP_LOG_VERBOSE=1` on a Cloud Run
 * service for a few hours, gathering data, then flipping it back is
 * the intended pattern. See OPTIMIZATIONS.md for the canonical
 * recipes that use these events.
 *
 * Format:
 *
 *   { "event": "cache.hit", "path": "/pipelines", ...fields,
 *     "timestamp": "2026-05-19T09:15:42.123Z" }
 *
 * The `event` field is dotted: "<area>.<verb>". Current areas:
 *
 *   cache.*    — hit, miss, invalidate, evict
 *   batch.*    — complete (always-on; opts.force)
 *   task.*     — created, transition, rejected, evicted
 *   tool.*     — call, chain (per /mcp-request aggregate)
 *   capsule.*  — request (one per completed call); timeout / error /
 *                ratelimit (one per failed call — forced/always-on, so a
 *                hung, connection-failed, or rate-limited call is never
 *                invisible). timeout covers BOTH the fetch stage and a
 *                mid-body stall; ratelimit fires when the single 429
 *                retry is also throttled. All three feed
 *                `tool.chain.capsuleCalls`.
 *
 * Adding new areas follows the same shape: pick a verb, populate the
 * relevant fields, call logEvent. **Privacy invariant**: events MUST
 * NOT contain CRM data. Paths go through `redactPath()` to swap
 * numeric IDs for `:id` placeholders; tool arguments are logged by
 * field NAME only (`argFields: ["conditions", "page"]`), never by
 * value. See OPTIMIZATIONS.md for the gcloud recipes that consume
 * these events.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readBool } from "./env.js";

/** True when verbose event logging is opted in via env. */
export function logVerbose(): boolean {
  return readBool("CAPSULE_MCP_LOG_VERBOSE");
}

/**
 * Emit a structured event to stderr.
 *
 * Default behaviour is gated on `CAPSULE_MCP_LOG_VERBOSE` — the hot
 * paths (cache, task store) only log when explicitly opted in.
 *
 * `opts.force: true` bypasses the gate. Used for low-cardinality,
 * uniformly-useful events (`batch.complete`) that operators
 * shouldn't have to flip verbose on to see. The detail fields on
 * such events still respect the verbose gate at the call site —
 * see how `src/capsule/batch.ts` strips `failureReasons` unless
 * `logVerbose()` is also on.
 *
 * stderr (not stdout) so the MCP-protocol JSON on stdout for the
 * stdio transport never collides with these. The HTTP transport
 * doesn't use stdout, so the same code path works for both.
 */
/**
 * Per-event aggregators that mutate the active RequestContext for
 * the `tool.chain` summary. Declarative table: adding a new event
 * type that should feed the chain is one row. Events not in this
 * table are emitted but don't update the chain.
 */
const chainHandlers: Record<
  string,
  (ctx: RequestContext, fields: Record<string, unknown>) => void
> = {
  "tool.call": (ctx, f) => {
    if (typeof f["tool"] === "string") ctx.tools.push(f["tool"]);
  },
  "capsule.request": (ctx) => {
    ctx.capsuleCalls += 1;
  },
  // A timed-out or connection-failed call is still an attempt that
  // never reaches the `capsule.request` emit (it throws at the fetch
  // stage). Count it here so `tool.chain.capsuleCalls` stays honest and
  // a chain whose duration ballooned is explained by a visible failure.
  "capsule.timeout": (ctx) => {
    ctx.capsuleCalls += 1;
  },
  "capsule.error": (ctx) => {
    ctx.capsuleCalls += 1;
  },
  // A request that exhausted its 429 retry is a real (doubly-attempted)
  // outbound call that throws before `capsule.request` fires — count it
  // so a chain whose latency ballooned on rate-limit backoff is explained.
  "capsule.ratelimit": (ctx) => {
    ctx.capsuleCalls += 1;
  },
  // Cache-hit events feed the aggregate so the chain stat is right
  // even on tools whose Capsule calls all hit the cache.
  "cache.hit": (ctx) => {
    ctx.cacheHits += 1;
  },
};

export function logEvent(
  event: string,
  fields: Record<string, unknown>,
  opts: { force?: boolean } = {},
): void {
  // Update the active request context for aggregation events
  // (tool.chain). Always runs — counters are cheap and we want the
  // aggregate to be accurate even when verbose is off but tool.chain
  // gets emitted by an always-on path. (Today there's none, but the
  // discipline keeps future force:true callers honest.)
  const ctx = requestContext.getStore();
  if (ctx) chainHandlers[event]?.(ctx, fields);

  if (!opts.force && !logVerbose()) return;
  process.stderr.write(
    `${JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() })}\n`,
  );
}

/**
 * Replace numeric-ID segments in a Capsule API path with `:id`
 * placeholders, and drop the query string entirely. Used by every
 * event that includes a path (`cache.*`, `capsule.request`) so we
 * don't smear specific party / opportunity / project IDs (and their
 * adjacent metadata) across log aggregators.
 *
 * Patterns redacted:
 *   /parties/123456789            -> /parties/:id
 *   /parties/1,2,3                -> /parties/:id   (multi-id GET)
 *   /parties/123456789/notes      -> /parties/:id/notes
 *   /parties/123456789/notes/456  -> /parties/:id/notes/:id
 *   /parties/search?q=Acme        -> /parties/search  (query dropped)
 *
 * Tag-list paths (`/parties/tags`, `/opportunities/tags`,
 * `/kases/tags`) are left as-is — `tags` isn't a numeric ID.
 */
export function redactPath(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  // Match a slash followed by one or more numeric segments separated
  // by commas (Capsule's multi-id GET syntax). Replace with `/:id`.
  return noQuery.replace(/\/\d+(?:,\d+)*/g, "/:id");
}

/**
 * Per-`/mcp`-request context for the `tool.chain` aggregate event.
 *
 * Lives in an `AsyncLocalStorage` so the chain accumulator is
 * implicit — every `tool.call` and `capsule.request` event lands in
 * the right bucket without threading context objects through every
 * call site. Set up by `withRequestContext` at the top of the
 * `/mcp` handler in `src/http/app.ts`; read at the end to emit the
 * aggregate event.
 */
export interface RequestContext {
  clientId?: string;
  tools: string[];
  capsuleCalls: number;
  cacheHits: number;
  startedAt: number;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with an active RequestContext. Anything within (and any
 * async work it spawns) sees the same context via
 * `getRequestContext()`. The accumulator is populated implicitly by
 * `logEvent` based on event type.
 *
 * On scope exit (resolved or rejected), emits the `tool.chain`
 * aggregate event with the collected stats. Owning the emission
 * here — rather than at the caller — keeps the chain lifecycle in
 * one place and means a caller can never forget to emit. The event
 * fires even if `fn` throws, because partial chains are still
 * useful for diagnosing tool errors.
 */
export function withRequestContext<T>(
  initial: Omit<RequestContext, "tools" | "capsuleCalls" | "cacheHits" | "startedAt">,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: RequestContext = {
    ...initial,
    tools: [],
    capsuleCalls: 0,
    cacheHits: 0,
    startedAt: Date.now(),
  };
  return requestContext.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      logEvent("tool.chain", {
        ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
        tools: ctx.tools,
        toolCount: ctx.tools.length,
        capsuleCalls: ctx.capsuleCalls,
        cacheHits: ctx.cacheHits,
        durationMs: Date.now() - ctx.startedAt,
      });
    }
  });
}

/** Read the active request context, if any. */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
