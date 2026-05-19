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
 *   cache.*   — hit, miss, invalidate, evict
 *
 * Adding new areas (e.g. "auth.*", "ratelimit.*") follows the same
 * shape: pick a verb, populate the relevant fields, call logEvent.
 */

/** True when verbose event logging is opted in via env. */
export function logVerbose(): boolean {
  const raw = process.env["CAPSULE_MCP_LOG_VERBOSE"]?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Emit a structured event to stderr if verbose logging is enabled.
 * No-op otherwise. Hot path; written to avoid allocating the JSON
 * string when verbose is off.
 */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  if (!logVerbose()) return;
  // stderr (not stdout) so MCP-protocol JSON on stdout for the stdio
  // transport never collides with these. The HTTP transport doesn't
  // use stdout, so the same code path works for both.
  process.stderr.write(
    `${JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() })}\n`,
  );
}
