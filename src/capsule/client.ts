import { fetch, type Response } from "undici";
import { readBool } from "../env.js";
import { logEvent, logVerbose, redactPath } from "../log.js";
import { cacheDisabled, cacheKey, cacheLookup, cacheSet } from "./cache.js";

const DEFAULT_BASE_URL = "https://api.capsulecrm.com/api/v2";

/**
 * The Capsule API base URL. Defaults to the production endpoint;
 * override with `CAPSULE_API_BASE_URL` for testing or self-hosted
 * instances. Read at call time so tests can stub it.
 *
 * Validation: the override MUST be either https:// or http:// pointed
 * at a loopback host. Sending the bearer token to an arbitrary http://
 * host (e.g. via a typo or a hostile env) would exfiltrate it; the
 * validation here is defence-in-depth on top of operator hygiene.
 */
function baseUrl(): string {
  const override = process.env["CAPSULE_API_BASE_URL"];
  if (!override) return DEFAULT_BASE_URL;
  if (!URL.canParse(override)) {
    throw new CapsuleAuthError(
      `CAPSULE_API_BASE_URL is not a valid URL: ${JSON.stringify(override)}`,
    );
  }
  const u = new URL(override);
  const isLocal =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
    throw new CapsuleAuthError(
      `CAPSULE_API_BASE_URL must be https:// (or http:// on localhost); got ${u.protocol}//${u.hostname}. Sending the Capsule API token to that URL would expose it.`,
    );
  }
  return override;
}

/**
 * Returns true if the server is configured to refuse all writes.
 * Set CAPSULE_MCP_READONLY to a truthy value (`1` / `true` / `yes`
 * / `on`, case-insensitive) to enable. Any other value (including
 * unset) means writes are allowed.
 */
export function isReadOnly(): boolean {
  return readBool("CAPSULE_MCP_READONLY");
}

export class CapsuleReadOnlyError extends Error {
  constructor(method: string) {
    super(
      `capsulemcp is running in read-only mode (CAPSULE_MCP_READONLY is set). ` +
        `${method} requests are refused. Unset CAPSULE_MCP_READONLY to enable writes.`,
    );
    this.name = "CapsuleReadOnlyError";
  }
}

export class CapsuleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleAuthError";
  }
}

export class CapsuleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CapsuleApiError";
  }
}

export interface PagedResult<T> {
  data: T;
  nextPage: number | undefined;
}

function getToken(): string {
  const token = process.env["CAPSULE_API_TOKEN"];
  if (!token) {
    throw new CapsuleAuthError(
      "CAPSULE_API_TOKEN environment variable is not set. " +
        "Generate a Personal Access Token via My Preferences → API Authentication Tokens in Capsule.",
    );
  }
  return token;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/** Parse RFC 5988 Link header and return the `next` page number, if present. */
function parseNextPage(linkHeader: string | null): number | undefined {
  if (!linkHeader) return undefined;
  // Link: <https://...?page=3&perPage=25>; rel="next"
  const match = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

/**
 * Decide how long to wait before retrying a 429.
 *
 * Capsule's API publishes its rate-limit reset time via
 * `X-RateLimit-Reset` (UTC epoch seconds), NOT the standard
 * `Retry-After` header. See:
 *   https://developer.capsulecrm.com/v2/overview/handling-api-responses
 *   "wait until the time inside the X-RateLimit-Reset header before
 *    it makes any other API requests for the specific user"
 *
 * The hourly window means the reset can be many minutes out. We cap
 * the wait at 60 seconds so a long-quota-exhaustion doesn't block a
 * Cloud Run request indefinitely; if Capsule says wait longer than
 * that, we surface the 429 and let the caller decide.
 *
 * Honour `X-RateLimit-Reset` first, then `Retry-After` as a
 * defensive fallback (in case Capsule ever standardises), then a
 * 5-second default if neither is present or parseable.
 */
function parseRateLimitDelay(res: Response): number {
  const DEFAULT_MS = 5_000;
  const MAX_WAIT_MS = 60_000;

  // 1. Capsule-specific: X-RateLimit-Reset (UTC epoch seconds).
  const resetRaw = res.headers.get("X-RateLimit-Reset");
  if (resetRaw) {
    const resetEpochSec = Number(resetRaw);
    if (Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
      const delta = resetEpochSec * 1000 - Date.now();
      // Reset already in the past (clock skew, or window just rolled
      // over): retry quickly.
      if (delta <= 0) return DEFAULT_MS;
      return Math.min(delta, MAX_WAIT_MS);
    }
  }

  // 2. RFC 7231 fallback: Retry-After (integer-seconds or HTTP-date).
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_WAIT_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? Math.min(delta, MAX_WAIT_MS) : DEFAULT_MS;
    }
  }

  // 3. No usable hint — wait a conservative default.
  return DEFAULT_MS;
}

interface CapsuleErrorBody {
  message?: string;
  errors?: Array<{ resource?: string; field?: string; message?: string }>;
}

/**
 * Capsule returns errors in two shapes:
 *   { "message": "..." }                                         (auth, server errors)
 *   { "errors": [{ "resource": "Party", "field": "name", ...}] } (validation errors)
 * Format both into a single human-readable string.
 */
async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as CapsuleErrorBody;

    if (body.errors && body.errors.length > 0) {
      return body.errors
        .map((e) => {
          const parts = [e.resource, e.field].filter(Boolean).join(".");
          return parts ? `${parts}: ${e.message ?? "invalid"}` : (e.message ?? "invalid");
        })
        .join("; ");
    }

    if (body.message) return body.message;

    return res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Per-request timeout for outbound Capsule HTTP calls. A slow or
 * stuck upstream response surfaces as a clean error to the caller
 * instead of pinning the connection. Bounds the outbound budget
 * against DNS hiccups, TCP keepalive holes, and slow-failing
 * Capsule responses.
 *
 * Reaches into the `signal` slot on the fetch options unless the
 * caller already provided one. Tests that need to bypass the
 * timeout (e.g. fake-timer tests that drive the 429-retry delay)
 * can pass their own signal.
 */
const REQUEST_TIMEOUT_MS = 60_000;

function withTimeout(options: Parameters<typeof fetch>[1]): {
  options: Parameters<typeof fetch>[1];
  cleanup: () => void;
} {
  if (options && (options as { signal?: AbortSignal }).signal !== undefined) {
    // Caller-provided signal — respect it, don't double-bind.
    return { options, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Don't hold up Node process exit on a pending timer.
  timer.unref();
  return {
    options: { ...(options ?? {}), signal: controller.signal },
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Result of an outbound Capsule fetch. The `cleanup` callback MUST be
 * invoked once the response body has been fully consumed (or the call
 * is abandoned) — it clears the timeout timer that's keeping the
 * AbortController alive. Releasing it earlier would let a mid-stream
 * stall on `res.body.getReader().read()`, `res.arrayBuffer()`, or
 * `res.json()` hang indefinitely, since undici's body-read primitives
 * are only abortable while the controller's signal is unfired. Pre-v1
 * this was a real DoS vector caught in the pre-GA security review.
 */
interface FetchResult {
  res: Response;
  cleanup: () => void;
}

/**
 * Map an AbortError thrown during body consumption into the same clean
 * 504 the fetch-stage abort produces. Without this, a timer-driven
 * abort firing during `res.json()` / `res.arrayBuffer()` /
 * `reader.read()` surfaces as a cryptic Node-internal AbortError.
 */
async function mapAbort<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
      throw new CapsuleApiError(
        504,
        `Capsule API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The Capsule API may be slow or hung; retry after a short wait. If the failed call was a write/delete, read the entity first to see whether the change actually applied before retrying.`,
      );
    }
    throw err;
  }
}

async function fetchWithTimeout(
  url: string,
  options: Parameters<typeof fetch>[1],
): Promise<FetchResult> {
  const { options: opts, cleanup } = withTimeout(options);
  try {
    const res = await fetch(url, opts);
    return { res, cleanup };
  } catch (err) {
    // On the error path we own the timer — clear it now, since no
    // body-consumption phase follows.
    cleanup();
    // Convert AbortError into a recognizable, actionable error rather
    // than a cryptic 'fetch failed' that the caller can't diagnose.
    if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
      throw new CapsuleApiError(
        504,
        `Capsule API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The Capsule API may be slow or hung; retry after a short wait. If the failed call was a write/delete, read the entity first to see whether the change actually applied before retrying.`,
      );
    }
    throw err;
  }
}

/**
 * Result of `doFetch` — adds the bookkeeping that `consumeBody` needs
 * to fire the `capsule.request` event AFTER the body has been read.
 *
 * Keeping the emit *after* body consumption is load-bearing: pre-v1.6.1
 * we measured only TTFB (Date.now() − startedAt at the point fetch()
 * returned headers), which silently undercounted endpoints that send
 * large response bodies (`list_entries` global feed was 542 ms by the
 * old metric vs 2720 ms wall-clock end-to-end — the gap was body
 * stream + JSON parse, invisible to the dashboard). See `consumeBody`.
 */
interface RequestStart {
  res: Response;
  cleanup: () => void;
  startedAt: number;
  method: string;
  url: string;
  retriedAfter429: boolean;
}

async function doFetch(url: string, options: Parameters<typeof fetch>[1]): Promise<RequestStart> {
  const startedAt = Date.now();
  const method = (options?.method as string | undefined) ?? "GET";

  const first = await fetchWithTimeout(url, options);

  if (first.res.status === 429) {
    const delay = parseRateLimitDelay(first.res);
    // Release the first fetch's timer before sleeping — the body of
    // the 429 response is not consumed, and we don't want a phantom
    // timer firing during the back-off window.
    first.cleanup();
    await new Promise((resolve) => setTimeout(resolve, delay));

    const retried = await fetchWithTimeout(url, options);
    if (retried.res.status === 429) {
      retried.cleanup();
      throw new CapsuleApiError(
        429,
        "Rate limit exceeded after one retry. Please slow down your requests.",
      );
    }
    return { ...retried, startedAt, method, url, retriedAfter429: true };
  }

  return { ...first, startedAt, method, url, retriedAfter429: false };
}

/**
 * Wrap body consumption in the `capsule.request` emit boundary so that
 * `durationMs` reflects the FULL request lifecycle (request issued →
 * body fully read), not just headers received. Fires on success and
 * on error during body parsing (4xx/5xx that read the error body,
 * malformed JSON, mid-stream timeouts, etc.) — analytics see every
 * outbound call, including the slow ones.
 */
async function consumeBody<T>(start: RequestStart, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    emitCapsuleRequest(
      start.method,
      start.url,
      start.res,
      Date.now() - start.startedAt,
      start.retriedAfter429,
    );
  }
}

/**
 * Emit a `capsule.request` event for one outbound Capsule API call.
 *
 * Verbose-gated. Path is run through `redactPath` so numeric IDs
 * become `:id` placeholders and the query string is dropped —
 * preserves shape for analytical queries (top endpoints, p95
 * latency per endpoint, error rate per endpoint) without leaking
 * specific record identifiers or search terms.
 *
 * Also updates the per-`/mcp`-request aggregator via `logEvent`'s
 * RequestContext awareness, so the `tool.chain` event at the end
 * of the request reports `capsuleCalls` accurately.
 *
 * `retriedAfter429: true` means this row counts ONE 429 retry on
 * top of the underlying request — useful for spotting rate-limit
 * pressure retroactively. (We never emit on the first 429 itself,
 * only on its retry; the no-retry success path emits once with
 * `retried=false`.)
 */
function emitCapsuleRequest(
  method: string,
  url: string,
  res: Response,
  durationMs: number,
  retriedAfter429: boolean,
): void {
  // Extract just the path from the URL; redact IDs.
  let path = "";
  try {
    path = redactPath(new URL(url).pathname);
  } catch {
    path = "?";
  }
  // Content-Length is usually present on Capsule responses; if not,
  // fall back to 0 — we don't want to read the body just for size.
  const lenHeader = res.headers.get("content-length");
  const responseBytes = lenHeader ? Number.parseInt(lenHeader, 10) : 0;
  logEvent("capsule.request", {
    method,
    path,
    status: res.status,
    durationMs,
    responseBytes: Number.isFinite(responseBytes) ? responseBytes : 0,
    ...(retriedAfter429 ? { retriedAfter429: true } : {}),
  });
}

/**
 * Throw a typed error if the response is not 2xx. Does NOT consume the
 * body on success — the caller decides whether to read it.
 */
async function throwForStatus(res: Response): Promise<void> {
  if (res.status === 401) {
    const detail = await parseErrorBody(res);
    throw new CapsuleAuthError(
      `Capsule API returned 401 Unauthorized: ${detail}. ` +
        "Check that CAPSULE_API_TOKEN is valid and not expired.",
    );
  }
  if (!res.ok) {
    const msg = await parseErrorBody(res);
    throw new CapsuleApiError(res.status, `Capsule API error ${res.status}: ${msg}`);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  await throwForStatus(res);
  return mapAbort(res.json() as Promise<T>);
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${baseUrl()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function capsuleGet<T>(path: string, params?: QueryParams): Promise<PagedResult<T>> {
  const token = getToken();
  const url = buildUrl(path, params);
  const start = await doFetch(url, { headers: baseHeaders(token) });
  try {
    return await consumeBody(start, async () => {
      const data = await handleResponse<T>(start.res);
      const nextPage = parseNextPage(start.res.headers.get("Link"));
      return { data, nextPage };
    });
  } finally {
    start.cleanup();
  }
}

/**
 * GET with TTL caching for near-static reference data (pipelines,
 * boards, custom-field schemas, …). See src/capsule/cache.ts for
 * the full rationale and the list of opted-in tools. Falls through
 * to `capsuleGet` on cache miss/stale and stores the fresh result.
 * When `CAPSULE_MCP_CACHE_TTL_MS=0`, the cache is bypassed entirely
 * and every call behaves identically to `capsuleGet`.
 */
export async function capsuleGetCached<T>(
  path: string,
  params?: QueryParams,
): Promise<PagedResult<T>> {
  if (cacheDisabled()) return capsuleGet<T>(path, params);
  const key = cacheKey(path, params);
  const lookup = cacheLookup<T>(key);
  if (lookup.hit) {
    // Skip the work on the hot path when verbose logging is off —
    // logEvent already short-circuits but param-shape construction
    // here is also avoidable.
    if (logVerbose()) {
      logEvent("cache.hit", {
        path: redactPath(path),
        ...(params ? { paramFields: Object.keys(params) } : {}),
        ageMs: lookup.ageMs,
      });
    }
    return lookup.result;
  }
  const fetchStart = Date.now();
  const result = await capsuleGet<T>(path, params);
  const latencyMs = Date.now() - fetchStart;
  cacheSet(key, result);
  if (logVerbose()) {
    logEvent("cache.miss", {
      path: redactPath(path),
      ...(params ? { paramFields: Object.keys(params) } : {}),
      reason: lookup.reason,
      latencyMs,
    });
  }
  return result;
}

export async function capsulePost<T>(path: string, body: unknown): Promise<T> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("POST");
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}

/**
 * POST a request that creates a side-effect (linking, applying, etc.)
 * but doesn't return a body. Capsule returns 204 No Content on these
 * endpoints, e.g. POST /opportunities/{id}/parties/{partyId} (link an
 * additional party). `capsulePost` would crash trying to JSON-parse
 * an empty body; this helper handles it.
 */
export async function capsulePostNoContent(path: string): Promise<void> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("POST");
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, {
    method: "POST",
    headers: baseHeaders(token),
  });
  try {
    await consumeBody(start, async () => {
      if (start.res.status === 204) return;
      await throwForStatus(start.res);
      // 2xx-but-not-204: drain the body so the connection can be reused.
      await mapAbort(start.res.text());
    });
  } finally {
    start.cleanup();
  }
}

/**
 * POST a body to a Capsule endpoint that semantically performs a *read*
 * (e.g. `/parties/filters/results`). Capsule uses POST for these
 * endpoints because the filter conditions don't fit cleanly into a query
 * string, but they are not mutations — so this helper does NOT gate on
 * `isReadOnly()`. Returns a paginated result with `nextPage` parsed from
 * the Link header, mirroring `capsuleGet`.
 */
export async function capsuleSearch<T>(
  path: string,
  body: unknown,
  params?: QueryParams,
): Promise<PagedResult<T>> {
  const token = getToken();
  const url = buildUrl(path, params);
  const start = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await consumeBody(start, async () => {
      const data = await handleResponse<T>(start.res);
      const nextPage = parseNextPage(start.res.headers.get("Link"));
      return { data, nextPage };
    });
  } finally {
    start.cleanup();
  }
}

export async function capsulePut<T>(path: string, body: unknown): Promise<T> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("PUT");
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, {
    method: "PUT",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}

/**
 * GET binary content. Returns the raw bytes plus the response's
 * Content-Type header. Used for attachment downloads — every other
 * read returns JSON, this is the exception.
 *
 * If `maxBytes` is provided, the response is rejected before any bytes
 * are buffered when the server-advertised `Content-Length` exceeds it,
 * AND the streaming read aborts as soon as accumulated bytes exceed
 * the cap. Without this, a malicious or buggy upstream could buffer
 * an arbitrarily large response into memory before any size check ran.
 *
 * Returns `{truncated: true, sizeBytes}` (with an empty buffer) when
 * the cap is exceeded; the caller decides how to surface that to the
 * MCP layer.
 */
export interface BinaryResult {
  contentType: string;
  buffer: Buffer;
  truncated?: boolean;
  sizeBytes: number;
}

export async function capsuleGetBinary(path: string, maxBytes?: number): Promise<BinaryResult> {
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, { headers: baseHeaders(token) });
  try {
    return await consumeBody(start, async (): Promise<BinaryResult> => {
      const res = start.res;
      await throwForStatus(res);
      const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";

      // Pre-buffer cap check. If Content-Length is advertised and exceeds
      // the cap, refuse to read the body at all.
      const declared = res.headers.get("Content-Length");
      const declaredBytes = declared ? Number(declared) : NaN;
      if (maxBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        // Drain (cancel) the body so the connection can be released.
        if (res.body) await res.body.cancel().catch(() => {});
        return {
          contentType,
          buffer: Buffer.alloc(0),
          truncated: true,
          sizeBytes: declaredBytes,
        };
      }

      // Streaming cap check. Even when Content-Length is absent or honest,
      // abort the read once we've accumulated more than the cap. The
      // per-chunk read is wrapped in mapAbort so a mid-stream timeout
      // surfaces as the same clean 504 a fetch-stage timeout does.
      if (maxBytes !== undefined && res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        while (true) {
          const { done, value } = await mapAbort(reader.read());
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
        if (truncated) {
          return {
            contentType,
            buffer: Buffer.alloc(0),
            truncated: true,
            sizeBytes: total,
          };
        }
        const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        return { contentType, buffer, sizeBytes: buffer.length };
      }

      const arrayBuffer = await mapAbort(res.arrayBuffer());
      const buffer = Buffer.from(arrayBuffer);
      return { contentType, buffer, sizeBytes: buffer.length };
    });
  } finally {
    start.cleanup();
  }
}

/**
 * POST raw binary as the request body. Capsule's attachment-upload
 * endpoint takes the file content directly (NOT multipart/form-data),
 * with three required headers — Content-Type, Content-Length, and
 * `X-Attachment-Filename` (URL-encoded).
 *
 * Read-only mode refuses this (it is a write).
 */
export async function capsulePostBinary<T>(
  path: string,
  body: Buffer,
  contentType: string,
  filename: string,
): Promise<T> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("POST");
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, {
    method: "POST",
    headers: {
      ...baseHeaders(token),
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "X-Attachment-Filename": encodeURIComponent(filename),
    },
    body,
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}

/**
 * DELETE /<path>. Capsule returns 204 No Content on success — no body
 * to parse. Errors flow through the same `throwForStatus` helper as
 * GET/POST/PUT.
 */
export async function capsuleDelete(path: string): Promise<void> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("DELETE");
  const token = getToken();
  const url = buildUrl(path);
  const start = await doFetch(url, {
    method: "DELETE",
    headers: baseHeaders(token),
  });
  try {
    await consumeBody(start, async () => {
      if (start.res.status === 204) return;
      await throwForStatus(start.res);

      // 2xx-but-not-204: drain the body so the connection can be reused.
      await mapAbort(start.res.text());
    });
  } finally {
    start.cleanup();
  }
}
