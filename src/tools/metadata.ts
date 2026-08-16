import { z } from "zod";
import { paginationFieldsNoDefaults } from "./shared-schemas.js";
import { capsuleGetCached, capsuleGetCachedList } from "../capsule/client.js";

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
  ...paginationFieldsNoDefaults,
  perPage: paginationFieldsNoDefaults.perPage.describe(
    "Page size, max 100. Defaults to 100 for reference data.",
  ),
};

// ── Teams ───────────────────────────────────────────────────────────────────

export const listTeamsSchema = z.object({ ...paginationFields });

export async function listTeams(input: z.infer<typeof listTeamsSchema>) {
  return capsuleGetCachedList<{ teams: unknown[] }>("/teams", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Loss reasons ────────────────────────────────────────────────────────────

export const listLostReasonsSchema = z.object({ ...paginationFields });

export async function listLostReasons(input: z.infer<typeof listLostReasonsSchema>) {
  // Note response key: `lostReasons` (camelCase plural).
  return capsuleGetCachedList<{ lostReasons: unknown[] }>("/lostreasons", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Activity types ──────────────────────────────────────────────────────────

export const listActivityTypesSchema = z.object({ ...paginationFields });

export async function listActivityTypes(input: z.infer<typeof listActivityTypesSchema>) {
  // Note response key: `activityTypes` (camelCase plural).
  return capsuleGetCachedList<{ activityTypes: unknown[] }>("/activitytypes", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
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
  const { data } = await capsuleGetCached<{ site: unknown }>("/site");
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
  return capsuleGetCachedList<{ trackDefinitions: unknown[] }>("/trackdefinitions", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Categories (entry/task categorisation) ──────────────────────────────────
//
// Capsule lets users tag entries and tasks with a category (Call,
// Email, Meeting, Follow-up, etc.) for reporting. Returns the configured
// category list with id, name, and colour.

export const listCategoriesSchema = z.object({ ...paginationFields });

export async function listCategories(input: z.infer<typeof listCategoriesSchema>) {
  return capsuleGetCachedList<{ categories: unknown[] }>("/categories", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Goals (sales targets) ───────────────────────────────────────────────────
//
// Per-user / per-team revenue / activity goals. Empty for accounts that
// don't use the feature, populated for those that do. Useful for
// progress reporting.

export const listGoalsSchema = z.object({ ...paginationFields });

export async function listGoals(input: z.infer<typeof listGoalsSchema>) {
  return capsuleGetCachedList<{ goals: unknown[] }>("/goals", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Countries (address dictionary) ──────────────────────────────────────────
//
// GET /countries — 250 rows: name, alpha2Code, alpha3Code, numericCode,
// dialCode. Returned complete in one response (no pagination; verified
// live 2026-08-16). The `name` values are the exact spellings Capsule's
// address-country dictionary accepts — the authoritative answer to the
// 422 'address.country: unknown country' class documented in
// NOTES-ON-CAPSULE-API.md. This endpoint was previously believed not to
// exist (see the NOTES correction); discovered in the issue #112 sweep.

export const listCountriesSchema = z.object({});

export async function listCountries() {
  const { data } = await capsuleGetCached<{ countries: unknown[] }>("/countries");
  return data;
}

// ── Currencies (dictionary) ─────────────────────────────────────────────────
//
// GET /currencies — 80 rows: code (ISO 4217), symbol, name, pluralName
// (names null for some minor currencies). Complete in one response.

export const listCurrenciesSchema = z.object({});

export async function listCurrencies() {
  const { data } = await capsuleGetCached<{ currencies: unknown[] }>("/currencies");
  return data;
}
