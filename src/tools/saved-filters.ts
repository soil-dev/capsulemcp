import { z } from "zod";
import { ENTITY_PATH, positiveId, paginationFields } from "./shared-schemas.js";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { capsuleGetCached, capsuleGetList } from "../capsule/client.js";

// Saved filters are filters created and stored in Capsule's web UI. Unlike
// the ad-hoc `filter_*` tools (which use POST /<entity>/filters/results),
// saved filters DO support sort — the orderBy is configured when the
// filter is saved. So the answer to "give me the most recent X sorted by
// Y" is to set up a saved filter in Capsule's UI and then run it via
// run_saved_filter.
//
// Endpoints:
//   GET /<entity>/filters              — list all saved filters
//   GET /<entity>/filters/{id}         — get a single saved filter (its
//                                         conditions, columns, orderBy)
//   GET /<entity>/filters/{id}/results — run the filter, paginated
//
// Entity is one of: parties, opportunities, projects (mapped to
// Capsule's legacy `kases` path component internally).

const EntitySchema = z
  .enum(["parties", "opportunities", "projects"])
  .describe("Which entity type the filter operates over.");

// ── List saved filters ──────────────────────────────────────────────────────

export const listSavedFiltersSchema = z.object({
  entity: EntitySchema,
});

export async function listSavedFilters(input: z.infer<typeof listSavedFiltersSchema>) {
  const { data } = await capsuleGetCached<{ filters: unknown[] }>(
    `/${ENTITY_PATH[input.entity]}/filters`,
  );
  return data;
}

// ── Run a saved filter ──────────────────────────────────────────────────────

export const runSavedFilterSchema = z.object({
  entity: EntitySchema,
  id: positiveId.describe("The saved filter id (from list_saved_filters)."),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  ...paginationFields,
});

export async function runSavedFilter(input: z.infer<typeof runSavedFilterSchema>) {
  return capsuleGetList<Record<string, unknown>>(
    `/${ENTITY_PATH[input.entity]}/filters/${input.id}/results`,
    {
      page: input.page,
      perPage: input.perPage,
      embed: input.embed,
    },
  );
}
