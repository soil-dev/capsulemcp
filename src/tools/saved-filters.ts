import { z } from "zod";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { capsuleGet } from "../capsule/client.js";

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
// Entity is one of: parties, opportunities, kases (Capsule's name for
// projects).

const EntitySchema = z
  .enum(["parties", "opportunities", "kases"])
  .describe(
    "Which entity type the filter operates over. Use 'kases' for projects (Capsule's legacy name).",
  );

// ── List saved filters ──────────────────────────────────────────────────────

export const listSavedFiltersSchema = z.object({
  entity: EntitySchema,
});

export async function listSavedFilters(input: z.infer<typeof listSavedFiltersSchema>) {
  const { data } = await capsuleGet<{ filters: unknown[] }>(`/${input.entity}/filters`);
  return data;
}

// ── Run a saved filter ──────────────────────────────────────────────────────

export const runSavedFilterSchema = z.object({
  entity: EntitySchema,
  id: z.number().int().positive().describe("The saved filter id (from list_saved_filters)."),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function runSavedFilter(input: z.infer<typeof runSavedFilterSchema>) {
  const { data, nextPage } = await capsuleGet<Record<string, unknown>>(
    `/${input.entity}/filters/${input.id}/results`,
    { page: input.page, perPage: input.perPage, embed: input.embed },
  );
  return { ...data, nextPage };
}
