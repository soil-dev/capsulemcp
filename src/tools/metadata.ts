import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

// Reference-data endpoints. Most accounts have a small number of each
// (a handful of teams, ~10 loss reasons, etc.) so a single call typically
// returns everything. But Capsule's default page size is 50, so an
// account with 51+ users / 100+ track definitions / etc. would silently
// get capped without pagination.
//
// All tools below accept optional page/perPage and return a `nextPage`
// cursor when more results exist. perPage defaults to 100 (Capsule's max)
// to maximise the chance of a single-page result for small accounts.
//
// Defaults applied in code via `?? value` (not via zod's .default()) so
// the inferred input types keep page/perPage optional for callers.

const paginationFields = {
  page: z.number().int().positive().optional(),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Page size, max 100. Defaults to 100 for reference data."),
};

// ── Teams ───────────────────────────────────────────────────────────────────

export const listTeamsSchema = z.object({ ...paginationFields });

export async function listTeams(input: z.infer<typeof listTeamsSchema>) {
  const { data, nextPage } = await capsuleGet<{ teams: unknown[] }>("/teams", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ── Loss reasons ────────────────────────────────────────────────────────────

export const listLostReasonsSchema = z.object({ ...paginationFields });

export async function listLostReasons(input: z.infer<typeof listLostReasonsSchema>) {
  // Note response key: `lostReasons` (camelCase plural).
  const { data, nextPage } = await capsuleGet<{ lostReasons: unknown[] }>("/lostreasons", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ── Activity types ──────────────────────────────────────────────────────────

export const listActivityTypesSchema = z.object({ ...paginationFields });

export async function listActivityTypes(input: z.infer<typeof listActivityTypesSchema>) {
  // Note response key: `activityTypes` (camelCase plural).
  const { data, nextPage } = await capsuleGet<{ activityTypes: unknown[] }>("/activitytypes", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ── Site (account info) ─────────────────────────────────────────────────────
//
// Returns the Capsule account this connector is currently connected to:
// subdomain, display name, URL. Useful as a "which Capsule am I talking
// to?" diagnostic. For the PAT owner's user identity, use get_current_user
// (GET /users/current) instead.
// Singular response, no pagination.

export const getSiteSchema = z.object({});

export async function getSite(_input: z.infer<typeof getSiteSchema>) {
  const { data } = await capsuleGet<{ site: unknown }>("/site");
  return data;
}

// ── Track definitions (workflow templates) ──────────────────────────────────
//
// Tracks are reusable workflow templates: "when this track is applied to
// an opportunity / project, auto-create these tasks at these intervals".
// Useful for understanding what automations exist and what the team's
// standard processes look like.

export const listTrackDefinitionsSchema = z.object({ ...paginationFields });

export async function listTrackDefinitions(input: z.infer<typeof listTrackDefinitionsSchema>) {
  // Note response key: `trackDefinitions` (camelCase plural). Each entry
  // includes nested taskDefinitions describing the auto-tasks the track
  // creates when applied.
  const { data, nextPage } = await capsuleGet<{ trackDefinitions: unknown[] }>(
    "/trackdefinitions",
    { page: input.page ?? 1, perPage: input.perPage ?? 100 },
  );
  return { ...data, nextPage };
}

// ── Categories (entry/task categorisation) ──────────────────────────────────
//
// Capsule lets users tag entries and tasks with a category (Call,
// Email, Meeting, Follow-up, etc.) for reporting. Returns the configured
// category list with id, name, and colour.

export const listCategoriesSchema = z.object({ ...paginationFields });

export async function listCategories(input: z.infer<typeof listCategoriesSchema>) {
  const { data, nextPage } = await capsuleGet<{ categories: unknown[] }>("/categories", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ── Goals (sales targets) ───────────────────────────────────────────────────
//
// Per-user / per-team revenue / activity goals. Empty for accounts that
// don't use the feature, populated for those that do. Useful for
// progress reporting.

export const listGoalsSchema = z.object({ ...paginationFields });

export async function listGoals(input: z.infer<typeof listGoalsSchema>) {
  const { data, nextPage } = await capsuleGet<{ goals: unknown[] }>("/goals", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}
