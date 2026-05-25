/**
 * Helper for the defensive read-modify-write used by `update_project`
 * and `update_opportunity` to defeat the asymmetric PUT semantic
 * documented in NOTES-ON-CAPSULE-API.md §27.
 *
 * Capsule's PUT on `/kases/:id` and `/opportunities/:id` clears any
 * ID-bearing ref field (`team`, `stage`) that is OMITTED from the body
 * when `owner` IS in the body. Sending `{owner: {id: X}}` on its own
 * silently nulls `team` and (on projects) `stage` server-side. Callers
 * who want to update only the owner need the connector to read the
 * current values first and carry them into the PUT body.
 *
 * Both update tools used to inline this read; this helper centralises
 * it so they share the GET shape and the carry-forward logic.
 */

import { capsuleGet } from "../capsule/client.js";

interface EntityRefShape {
  team?: { id: number } | null;
  stage?: { id: number } | null;
}

/**
 * Read the current team and stage IDs (where present) for an entity
 * at `path` — typically `/kases/:id` or `/opportunities/:id`. Returns
 * `undefined` for absent fields; the caller decides whether absent
 * means "skip" or "explicit null".
 *
 * @param path  full Capsule API path, e.g. `/opportunities/123`
 * @param responseKey  top-level field on the response: `kase` for
 *                     projects, `opportunity` for opportunities.
 */
export async function readEntityRefs(
  path: string,
  responseKey: "kase" | "opportunity" | "party",
): Promise<{ teamId: number | undefined; stageId: number | undefined }> {
  const { data } = await capsuleGet<Record<string, EntityRefShape>>(path);
  const entity = data[responseKey];
  return {
    teamId: entity?.team?.id ?? undefined,
    stageId: entity?.stage?.id ?? undefined,
  };
}
