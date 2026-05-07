import { z } from "zod";
import { capsuleSearch } from "../capsule/client.js";

// ── Shared schema ───────────────────────────────────────────────────────────
//
// Capsule's structured filter endpoints all share the same shape:
//
//   POST /<entity>/filters/results
//   body: { "filter": { "conditions": [{field, operator, value}, ...] } }
//   query: ?page=1&perPage=25&embed=tags
//
// Sort is NOT supported on the ad-hoc filter endpoint — only on saved
// filters configured in Capsule's web UI. To answer "most recent X"
// questions, filter by date (e.g. addedOn) and rely on the fact that
// Capsule's numeric IDs are monotonically incrementing — within a date-
// bounded result set, the highest id is the newest record.
//
// Operator values (and which ones apply per field) come from Capsule's
// filter system; we accept them as a free-form string and let the API
// reject invalid combinations rather than try to maintain a per-field
// allow-list that would drift out of sync with Capsule.

const FilterConditionSchema = z.object({
  field: z
    .string()
    .describe(
      "The Capsule field to filter on. Examples: 'addedOn', 'lastContactedAt', 'tag', 'name', 'createdOn', 'status', 'milestone'. Field availability depends on the entity type.",
    ),
  operator: z
    .string()
    .describe(
      "The filter operator. Examples: 'is', 'is not', 'contains', 'does not contain', 'is greater than', 'is less than', 'is within last', 'is more than', 'starts with'. Operator validity depends on the field's type.",
    ),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .describe(
      "The value to compare against. For 'is within last' on date fields, pass an integer number of days. For tag filters, pass the tag name as a string.",
    ),
});

const FilterInputSchema = z.object({
  conditions: z
    .array(FilterConditionSchema)
    .min(1)
    .describe(
      "Array of filter conditions. All conditions are ANDed together. To get newest records, use a date condition like {field: 'addedOn', operator: 'is within last', value: 7} and pick the highest-id row from the result (Capsule IDs are monotonic).",
    ),
  embed: z
    .string()
    .optional()
    .describe("Comma-separated embeds, e.g. 'tags,fields'."),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export type FilterInput = z.infer<typeof FilterInputSchema>;

// ── Implementation ──────────────────────────────────────────────────────────

async function runFilter<T>(entityPath: string, input: FilterInput): Promise<T> {
  const { data, nextPage } = await capsuleSearch<T & object>(
    `/${entityPath}/filters/results`,
    { filter: { conditions: input.conditions } },
    {
      page: input.page,
      perPage: input.perPage,
      embed: input.embed,
    },
  );
  return { ...data, nextPage } as T;
}

// ── Tool exports ────────────────────────────────────────────────────────────

export const filterPartiesSchema = FilterInputSchema;
export async function filterParties(input: FilterInput) {
  return runFilter<{ parties: unknown[]; nextPage: number | undefined }>(
    "parties",
    input,
  );
}

export const filterOpportunitiesSchema = FilterInputSchema;
export async function filterOpportunities(input: FilterInput) {
  return runFilter<{ opportunities: unknown[]; nextPage: number | undefined }>(
    "opportunities",
    input,
  );
}

export const filterProjectsSchema = FilterInputSchema;
export async function filterProjects(input: FilterInput) {
  // Capsule's API uses the legacy `/kases` path for projects (cases).
  return runFilter<{ kases: unknown[]; nextPage: number | undefined }>(
    "kases",
    input,
  );
}
