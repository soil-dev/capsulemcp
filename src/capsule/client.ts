import { fetch, type Response } from "undici";

const DEFAULT_BASE_URL = "https://api.capsulecrm.com/api/v2";

/**
 * The Capsule API base URL. Defaults to the production endpoint;
 * override with `CAPSULE_API_BASE_URL` for testing or self-hosted
 * instances. Read at call time so tests can stub it.
 */
function baseUrl(): string {
  return process.env["CAPSULE_API_BASE_URL"] ?? DEFAULT_BASE_URL;
}

/**
 * Returns true if the server is configured to refuse all writes.
 * Set CAPSULE_MCP_READONLY to "1", "true", or "yes" (case-insensitive)
 * to enable. Any other value (including unset) means writes are allowed.
 */
export function isReadOnly(): boolean {
  const v = process.env["CAPSULE_MCP_READONLY"]?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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
 * Parse a Retry-After header value into a millisecond delay.
 * RFC 7231 allows either an integer-seconds value or an HTTP-date.
 * Falls back to 5 seconds if the value is missing or unparseable.
 */
function parseRetryAfter(value: string | null): number {
  const DEFAULT_MS = 5_000;
  if (!value) return DEFAULT_MS;

  // Try integer-seconds first.
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }

  // Fall back to HTTP-date.
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, 60_000) : DEFAULT_MS;
  }

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

async function doFetch(
  url: string,
  options: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetch(url, options);

  if (res.status === 429) {
    const delay = parseRetryAfter(res.headers.get("Retry-After"));
    await new Promise((resolve) => setTimeout(resolve, delay));

    const retried = await fetch(url, options);
    if (retried.status === 429) {
      throw new CapsuleApiError(429, "Rate limit exceeded after one retry. Please slow down your requests.");
    }
    return retried;
  }

  return res;
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
  return res.json() as Promise<T>;
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

export async function capsuleGet<T>(
  path: string,
  params?: QueryParams,
): Promise<PagedResult<T>> {
  const token = getToken();
  const url = buildUrl(path, params);
  const res = await doFetch(url, { headers: baseHeaders(token) });
  const data = await handleResponse<T>(res);
  const nextPage = parseNextPage(res.headers.get("Link"));
  return { data, nextPage };
}

export async function capsulePost<T>(path: string, body: unknown): Promise<T> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("POST");
  const token = getToken();
  const url = buildUrl(path);
  const res = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
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
  const res = await doFetch(url, {
    method: "POST",
    headers: baseHeaders(token),
  });
  if (res.status === 204) return;
  await throwForStatus(res);
  // 2xx-but-not-204: drain the body so the connection can be reused.
  await res.text();
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
  const res = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await handleResponse<T>(res);
  const nextPage = parseNextPage(res.headers.get("Link"));
  return { data, nextPage };
}

export async function capsulePut<T>(path: string, body: unknown): Promise<T> {
  if (isReadOnly()) throw new CapsuleReadOnlyError("PUT");
  const token = getToken();
  const url = buildUrl(path);
  const res = await doFetch(url, {
    method: "PUT",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

/**
 * GET binary content. Returns the raw bytes plus the response's
 * Content-Type header. Used for attachment downloads — every other
 * read returns JSON, this is the exception.
 */
export async function capsuleGetBinary(
  path: string,
): Promise<{ contentType: string; buffer: Buffer }> {
  const token = getToken();
  const url = buildUrl(path);
  const res = await doFetch(url, { headers: baseHeaders(token) });
  await throwForStatus(res);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType =
    res.headers.get("Content-Type") ?? "application/octet-stream";
  return { contentType, buffer };
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
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      ...baseHeaders(token),
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "X-Attachment-Filename": encodeURIComponent(filename),
    },
    body,
  });
  return handleResponse<T>(res);
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
  const res = await doFetch(url, {
    method: "DELETE",
    headers: baseHeaders(token),
  });

  if (res.status === 204) return;
  await throwForStatus(res);

  // 2xx-but-not-204: drain the body so the connection can be reused.
  await res.text();
}
