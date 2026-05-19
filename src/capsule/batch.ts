/**
 * Concurrency-capped parallel fan-out for batched writes.
 *
 * Capsule v2 has no batch-write API — every create/update/delete is
 * one entity per call. For LLM flows that touch 5-50 records at once
 * (mass tag, mass owner reassignment, "mark these tasks done"),
 * sequential single-tool calls cost N × the wire latency. This
 * helper takes an array of items and an action function, runs them
 * in parallel up to a concurrency cap, and aggregates the results.
 *
 * Key design choices:
 *
 *   - **Per-item results, not all-or-nothing.** Capsule has no
 *     rollback. If 8 of 10 PUTs succeed and 2 422 on validation,
 *     you can't undo the 8. The return shape is an array where each
 *     slot is `{ ok: true, result }` or `{ ok: false, error }`. The
 *     caller (and the LLM) has to handle partial failure honestly.
 *
 *   - **Concurrency cap, not unlimited parallelism.** Capsule's
 *     hourly per-token rate budget (~4000 req/h) is shared with
 *     every other tool call on the same token. Fanning out 50
 *     parallel writes would 429 hard and starve everything else.
 *     Default cap of 5 keeps the burst polite while still getting
 *     ~5× speedup vs sequential. Configurable via
 *     `CAPSULE_MCP_BATCH_CONCURRENCY`.
 *
 *   - **One log line per batch.** `batch.complete` event carries
 *     summary fields (total, succeeded, failed, durationMs,
 *     concurrency) plus up to 5 deduplicated failure reasons —
 *     enough to spot patterns without dumping 50 error blobs into
 *     the log stream. See src/log.ts for the broader logging
 *     contract.
 */

/**
 * Split an array into fixed-size chunks. Final chunk may be smaller.
 * Used by the `get_parties` / `get_opportunities` / `get_projects` /
 * `get_tasks` tools when called with >10 ids: Capsule's native
 * multi-id GET caps at 10 per request, so we split larger sets
 * into 10-id chunks, fan out the resulting Capsule requests in
 * parallel, and concatenate the responses. The caller-facing shape
 * (`{ parties: [...] }` etc.) stays identical to the single-chunk
 * case — fan-out is an internal implementation detail.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Per-item result shape returned to the tool caller. */
export type BatchItemResult<TOutput> =
  | { ok: true; result: TOutput }
  | { ok: false; error: { status?: number; message: string } };

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
}

export interface BatchResponse<TOutput> {
  results: BatchItemResult<TOutput>[];
  summary: BatchSummary;
}

/** Default fan-out cap when CAPSULE_MCP_BATCH_CONCURRENCY is unset. */
const DEFAULT_CONCURRENCY = 5;

/** Hard ceiling — operators can't accidentally set 10000. */
const MAX_CONCURRENCY = 50;

/**
 * Resolved concurrency. Read at call time so tests / operators can
 * flip the env without process restart. Floors to 1; ceilings to
 * MAX_CONCURRENCY; falls back to default on malformed input.
 */
export function getBatchConcurrency(): number {
  const raw = process.env["CAPSULE_MCP_BATCH_CONCURRENCY"];
  if (raw === undefined || raw === "") return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

/**
 * Run `action` against each item with bounded parallelism. Per-item
 * exceptions are caught and surfaced in the result slot — they never
 * reject the outer promise. Order of `results` matches order of
 * `items` regardless of completion order.
 *
 * `tool` is the connector-side tool name; emitted in the batch.complete
 * log event for grouping in queries.
 */
export async function batchExecute<TInput, TOutput>(
  tool: string,
  items: TInput[],
  action: (item: TInput, index: number) => Promise<TOutput>,
): Promise<BatchResponse<TOutput>> {
  const concurrency = getBatchConcurrency();
  const results: BatchItemResult<TOutput>[] = new Array(items.length);
  const startedAt = Date.now();

  // Simple promise-pool: a pointer walks the input array, N
  // workers each grab the next unclaimed index. No external
  // dependency needed; the indirection cost is negligible at N <
  // ~100 items.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        const result = await action(items[i] as TInput, i);
        results[i] = { ok: true, result };
      } catch (err) {
        results[i] = { ok: false, error: extractError(err) };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const summary: BatchSummary = { total: results.length, succeeded, failed };

  // batch.complete fires on every batch (unlike cache events which
  // gate on verbose). The summary is low-cardinality, low-volume, and
  // useful for retroactive analysis of batch failure rates — so we
  // emit it even when CAPSULE_MCP_LOG_VERBOSE is off. logEvent's
  // verbose gate is the per-event opt-in for cache.* events; for
  // batch.complete we use a direct write so it always lands.
  //
  // For "where are batches failing", attach up to 5 deduplicated
  // failure reasons (most common ones first).
  const failureReasons = topFailureReasons(results, 5);
  logEventAlways("batch.complete", {
    tool,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    durationMs: Date.now() - startedAt,
    concurrency,
    ...(failureReasons.length > 0 ? { failureReasons } : {}),
  });

  return { results, summary };
}

/**
 * Coerce an unknown thrown value into the on-wire error shape.
 * Capsule client errors carry a numeric status and a structured
 * message; arbitrary thrown values lose the status and surface the
 * stringified message.
 */
function extractError(err: unknown): { status?: number; message: string } {
  if (err instanceof Error) {
    // CapsuleApiError / CapsuleAuthError / CapsuleReadOnlyError all
    // extend Error and may have a `status` field; pluck if present.
    const maybeStatus = (err as { status?: number }).status;
    return {
      ...(typeof maybeStatus === "number" ? { status: maybeStatus } : {}),
      message: err.message,
    };
  }
  return { message: String(err) };
}

/**
 * Top-N deduplicated failure reasons, ordered by frequency. Used to
 * keep batch.complete log lines compact even on a 50-item batch where
 * 40 fail with the same validation error.
 */
function topFailureReasons<T>(
  results: BatchItemResult<T>[],
  n: number,
): Array<{ status?: number; message: string; count: number }> {
  const counts = new Map<string, { status?: number; message: string; count: number }>();
  for (const r of results) {
    if (r.ok) continue;
    const key = `${r.error.status ?? "?"}::${r.error.message}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { ...r.error, count: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

/**
 * Direct stderr write that bypasses CAPSULE_MCP_LOG_VERBOSE. Used by
 * batch.complete because the event is low-volume (one line per batch
 * tool call) and uniformly useful for retroactive analysis —
 * operators shouldn't have to flip verbose on just to confirm a
 * batch ran or to see its failure rate. Same JSON shape as logEvent
 * so it parses into the same jsonPayload structure in Cloud Run.
 */
function logEventAlways(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() })}\n`,
  );
}
