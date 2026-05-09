import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

// Audit & navigation tools that don't fit cleanly under a single entity.
//
//   list_employees(partyId)           — people who work at an organisation
//   list_deleted_parties(since)       — audit: parties deleted since a date
//   list_deleted_opportunities(since) — audit: opportunities deleted since a date
//   list_deleted_projects(since)      — audit: projects deleted since a date
//
// All deleted-* endpoints REQUIRE the `since` parameter (Capsule returns
// 422 without it). They also include a `restrictedParties` /
// `restrictedOpportunities` / `restrictedKases` sibling key in the
// response: records that the integration user can see were deleted but
// cannot read in full. We surface both keys verbatim.

// ── Employees of an organisation ────────────────────────────────────────────

export const listEmployeesSchema = z.object({
  partyId: z
    .number()
    .int()
    .positive()
    .describe(
      "The organisation's party id. Returns the people whose `organisation` field links to this party.",
    ),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'."),
});

export async function listEmployees(input: z.infer<typeof listEmployeesSchema>) {
  const { data, nextPage } = await capsuleGet<{ parties: unknown[] }>(
    `/parties/${input.partyId}/people`,
    { page: input.page, perPage: input.perPage, embed: input.embed },
  );
  return { ...data, nextPage };
}

// ── Deleted entities (audit) ────────────────────────────────────────────────

const DeletedSinceSchema = z
  .string()
  .describe(
    "REQUIRED. ISO-8601 timestamp; only deletions on or after this point are returned. Example: '2026-01-01T00:00:00Z'.",
  );

const DeletedPagination = {
  since: DeletedSinceSchema,
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
};

export const listDeletedPartiesSchema = z.object(DeletedPagination);

export async function listDeletedParties(
  input: z.infer<typeof listDeletedPartiesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{
    parties: unknown[];
    restrictedParties?: unknown[];
  }>("/parties/deleted", {
    since: input.since,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

export const listDeletedOpportunitiesSchema = z.object(DeletedPagination);

export async function listDeletedOpportunities(
  input: z.infer<typeof listDeletedOpportunitiesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{
    opportunities: unknown[];
    restrictedOpportunities?: unknown[];
  }>("/opportunities/deleted", {
    since: input.since,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

export const listDeletedProjectsSchema = z.object(DeletedPagination);

export async function listDeletedProjects(
  input: z.infer<typeof listDeletedProjectsSchema>,
) {
  // Capsule's API uses /kases for projects.
  const { data, nextPage } = await capsuleGet<{
    kases: unknown[];
    restrictedKases?: unknown[];
  }>("/kases/deleted", {
    since: input.since,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}
