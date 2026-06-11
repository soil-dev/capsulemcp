/**
 * Chunked multi-id GET for Capsule's `GET /<base>/<id1>,<id2>,...`
 * endpoints, which cap at 10 ids per request.
 *
 * For ≤10 ids this is a single round trip returning Capsule's response
 * verbatim. For more, the connector splits the ids into 10-id chunks,
 * fans the chunk requests out in parallel, and concatenates the
 * `responseKey` arrays — the caller-facing shape is identical
 * regardless of input size, so the fan-out stays an internal detail.
 *
 * Extracted from the four batch-fetch handlers (`get_parties`,
 * `get_opportunities`, `get_projects`, `get_tasks`) that each
 * hand-rolled this exact block. Centralising it puts the "Capsule
 * caps multi-id GET at 10" rule in one place.
 */

import { chunk } from "./batch.js";
import { capsuleGet } from "./client.js";

/** Capsule's multi-id GET path accepts at most this many ids per request. */
const MULTI_GET_MAX_IDS = 10;

/**
 * @param base         path prefix without trailing slash, e.g. `/parties`, `/kases`
 * @param responseKey  the array key in the (normalized) response, e.g. `parties`, `projects`
 * @param ids          entity ids (the caller's schema caps the count, typically ≤50)
 * @param params       optional query params forwarded verbatim (e.g. `{ embed }`);
 *                     `undefined` values are dropped by the URL builder, matching
 *                     the prior per-handler behaviour.
 */
export async function chunkedMultiGet(
  base: string,
  responseKey: string,
  ids: number[],
  params?: Parameters<typeof capsuleGet>[1],
): Promise<Record<string, unknown[]>> {
  if (ids.length <= MULTI_GET_MAX_IDS) {
    // Single Capsule request — return its body verbatim (may carry
    // more than just `responseKey`; preserved as-is).
    const { data } = await capsuleGet<Record<string, unknown[]>>(
      `${base}/${ids.join(",")}`,
      params,
    );
    return data;
  }
  // At the typical 50-id schema cap this is at most 5 parallel
  // requests — polite-burst territory for a single tool call.
  const chunks = chunk(ids, MULTI_GET_MAX_IDS);
  const responses = await Promise.all(
    chunks.map((chunkIds) =>
      capsuleGet<Record<string, unknown[]>>(`${base}/${chunkIds.join(",")}`, params),
    ),
  );
  // Preserve any non-array sibling keys (from the first chunk) so the
  // fan-out path returns the SAME shape as the single-chunk path above,
  // which hands back Capsule's body verbatim. In practice Capsule's
  // multi-id GET returns only `{ [responseKey]: [...] }`, but matching
  // the shape removes a count-dependent surprise.
  const merged = responses.flatMap((r) => r.data[responseKey] ?? []);
  return { ...(responses[0]?.data ?? {}), [responseKey]: merged };
}
