import { z } from "zod";
import { paginationFields } from "./shared-schemas.js";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { capsuleSearch } from "../capsule/client.js";

// ── Shared schema ───────────────────────────────────────────────────────────
//
// Capsule's structured filter endpoints all share the same shape:
//
//   POST /<entity>/filters/results
//   body: { "filter": { "conditions": [{field, operator, value}, ...] } }
//   query: ?page=1&perPage=25&embed=tags
//
// IMPORTANT: filter field names DIFFER from the JSON response field names.
// Always use the filter-side names below, not the response-side names:
//
//   Response field      Filter field        Type
//   ─────────────────   ─────────────────   ────
//   createdAt           addedOn             date
//   updatedAt           updatedOn           date
//   lastContactedAt     lastContactedOn     date  (parties only)
//   closedOn            closedOn            date  (opp/project)
//   expectedCloseOn     expectedCloseOn     date  (opp/project)
//
// Sending lastContactedAt (the response name) returns a 422
// "invalid field name" error. See Capsule's filter reference at
// https://developer.capsulecrm.com/v2/reference/filters for the full
// per-entity allow-list.
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
      "The Capsule filter-side field name (these differ from response field names — e.g. response.createdAt is filter-side 'addedOn', response.lastContactedAt is filter-side 'lastContactedOn'). Common: 'addedOn' (date created), 'updatedOn' (date last modified), 'lastContactedOn' (parties only), 'name', 'tag', 'owner', 'team', 'type' (parties: person|organisation), 'milestone' (opportunities), 'status' (opp/project: OPEN|CLOSED), 'closedOn' (opp/project), 'expectedCloseOn' (opp/project), 'hasTags', 'hasEmailAddress' (parties), 'isOpen', 'isStale' (opportunities), 'custom:{fieldId}'. Full per-entity list: https://developer.capsulecrm.com/v2/reference/filters",
    ),
  operator: z
    .string()
    .describe(
      "The filter operator. Common: 'is', 'is not' (use value=null to test for null), 'contains', 'does not contain', 'is greater than', 'is less than', 'is within last' (date fields, value=integer days), 'is more than' (date fields, value=integer days ago), 'starts with', 'ends with'. Operator validity depends on the field's type.",
    ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe(
      "The value to compare against. For 'is within last' on date fields, pass an integer number of days. For tag filters, pass the tag name (string) or tag id (number). For 'is not' null tests, pass null literally.",
    ),
});

const FilterInputSchema = z.object({
  conditions: z
    .array(FilterConditionSchema)
    .min(1)
    .describe(
      "Array of filter conditions. All conditions are ANDed together. To get newest records, use a date condition like {field: 'addedOn', operator: 'is within last', value: 7} and pick the highest-id row from the result (Capsule IDs are monotonic).",
    ),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  ...paginationFields,
});

export type FilterInput = z.infer<typeof FilterInputSchema>;

// ── Implementation ──────────────────────────────────────────────────────────

async function runFilter<T extends object>(
  entityPath: string,
  input: FilterInput,
): Promise<T & { nextPage: number | undefined }> {
  const { data, nextPage } = await capsuleSearch<T>(
    `/${entityPath}/filters/results`,
    { filter: { conditions: input.conditions } },
    {
      page: input.page,
      perPage: input.perPage,
      embed: input.embed,
    },
  );
  return { ...data, nextPage };
}

// ── Tool exports ────────────────────────────────────────────────────────────

export const filterPartiesSchema = FilterInputSchema;
export async function filterParties(input: FilterInput) {
  // Common patterns:
  //   "Parties contacted in last N days":
  //     [{field: "lastContactedOn", operator: "is within last", value: N}]
  //   "Parties added in last N days":
  //     [{field: "addedOn", operator: "is within last", value: N}]
  //   "Organisations only":
  //     [{field: "type", operator: "is", value: "organisation"}]
  //   "Tagged X" (by name or id):
  //     [{field: "tag", operator: "is", value: "VIP"}]
  //   "Has at least one tag" (filter out untagged auto-imports):
  //     [{field: "hasTags", operator: "is", value: true}]
  return runFilter<{ parties: unknown[] }>("parties", input);
}

export const filterOpportunitiesSchema = FilterInputSchema;
export async function filterOpportunities(input: FilterInput) {
  // Common patterns:
  //   "Opportunities won in last N days":
  //     [{field: "milestone", operator: "is", value: "<id-or-name>"},
  //      {field: "closedOn", operator: "is within last", value: N}]
  //   "Open opportunities":
  //     [{field: "isOpen", operator: "is", value: true}]
  //   "Stale opportunities (no recent activity)":
  //     [{field: "isStale", operator: "is", value: true}]
  //   "Closing this quarter":
  //     [{field: "expectedCloseOn", operator: "is within next", value: 90}]
  return runFilter<{ opportunities: unknown[] }>("opportunities", input);
}

export const filterProjectsSchema = FilterInputSchema;
export async function filterProjects(input: FilterInput) {
  // Common patterns:
  //   "Open projects only":
  //     [{field: "isOpen", operator: "is", value: true}]
  //   "Projects in stage X":
  //     [{field: "stage", operator: "is", value: "<stage-id>"}]
  //   "Projects closed in last N days":
  //     [{field: "status", operator: "is", value: "CLOSED"},
  //      {field: "closedOn", operator: "is within last", value: N}]
  //
  // Capsule's API uses the legacy `/kases` path for projects (cases).
  return runFilter<{ kases: unknown[] }>("kases", input);
}
