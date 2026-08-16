import { z } from "zod";
import { paginationFields } from "./shared-schemas.js";
import { capsuleGetList } from "../capsule/client.js";

/**
 * Global cross-entity activity feed — `GET /activities`.
 *
 * CAVEAT: this endpoint is NOT in Capsule's public API documentation
 * (discovered by live probe in the issue #112 delta sweep, 2026-08-16).
 * It has been stable in observation, but being undocumented it could
 * change or disappear without notice. Treat schema drift here with
 * suspicion before blaming the connector.
 *
 * Row shape (observed): { id, createdAt, activityType: {id, name},
 * activitySource, apiClient, user, owner, team, entry, party,
 * opportunity, project, task } — the entity refs are null except for
 * the one(s) the activity concerns. activityType values observed:
 * Note (-1), Task completed (-4), Email sent (-5), Email received (-6),
 * plus tenant-defined custom types.
 *
 * `since` filters server-side (verified). Entity-scoped filter params
 * (`party=`, `entity=`) return 200 but appear to be silently IGNORED —
 * per Capsule's general unknown-param behaviour — so this tool does not
 * expose them; filter client-side on the returned refs instead.
 *
 * The legacy `kase` ref key is normalized to `project` at the client
 * boundary like every other response.
 */

export const listActivitiesSchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "Only activities on/after this ISO-8601 timestamp (server-side filter, verified live). Omit for the newest activities.",
    ),
  ...paginationFields,
});

export async function listActivities(input: z.infer<typeof listActivitiesSchema>) {
  return capsuleGetList<{ activities: unknown[] }>("/activities", {
    since: input.since,
    page: input.page,
    perPage: input.perPage,
  });
}
