/**
 * Shared test-fixture builders.
 *
 * Every per-tool test file used to redefine its own `mockFetch` (and the
 * attachment-related tests redefined `mockJson` / `mockBinary` on top).
 * One source of truth here keeps the response shape consistent and means
 * future fixture changes (new fields on the Response shape, new helpers)
 * land in one place instead of 18.
 *
 * Caller-side pattern:
 *
 *   vi.mock("undici", () => ({ fetch: vi.fn() }));   // still per-file —
 *                                                    // vitest needs the
 *                                                    // mock at top-level
 *   beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
 *   afterEach(()  => { vi.clearAllMocks(); ... });
 *
 *   import { mockFetch } from "./test-helpers.js";
 *   mockFetch(200, { parties: [] });
 *
 * The `vi.mock` call has to live in the importing file because vitest
 * hoists it before any other code; that's a vitest design, not a choice
 * we can route through here.
 */

import { vi } from "vitest";
import { fetch } from "undici";

/**
 * Queue a JSON-body response for the next outbound `fetch` call. Header
 * map is optional and merges into `Headers` so `Link: ...` rels for
 * pagination tests work the same way as a real Capsule response.
 */
export function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

/**
 * Queue a JSON-body response with no headers. Equivalent to `mockFetch`
 * with an empty headers map; kept as a separate name in the attachment-
 * upload tests because the shape there alternates between binary
 * responses and JSON ones, and a distinct name makes the alternation
 * scannable.
 */
export const mockJson = mockFetch;

/**
 * Queue a binary response for the next outbound `fetch` call. Real
 * Capsule attachment-download responses carry `Content-Type` plus
 * `Content-Length`; the client uses the latter for its pre-buffer size
 * cap, so the mock supplies both. The buffer is exposed as both
 * `arrayBuffer()` and `text()` so callers can probe whichever route
 * the handler uses.
 */
export function mockBinary(
  status: number,
  buffer: Buffer,
  contentType = "application/octet-stream",
): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
    }),
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    text: async () => buffer.toString("utf8"),
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}
