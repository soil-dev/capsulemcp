import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

// Small reference-data endpoints. None paginate in practice (Capsule
// accounts have a handful of teams, loss reasons, activity types) so
// we don't expose page/perPage. We surface the full response.

// ── Teams ───────────────────────────────────────────────────────────────────

export const listTeamsSchema = z.object({});

export async function listTeams(_input: z.infer<typeof listTeamsSchema>) {
  const { data } = await capsuleGet<{ teams: unknown[] }>("/teams");
  return data;
}

// ── Loss reasons ────────────────────────────────────────────────────────────

export const listLostReasonsSchema = z.object({});

export async function listLostReasons(
  _input: z.infer<typeof listLostReasonsSchema>,
) {
  // Note response key: `lostReasons` (camelCase plural).
  const { data } = await capsuleGet<{ lostReasons: unknown[] }>("/lostreasons");
  return data;
}

// ── Activity types ──────────────────────────────────────────────────────────

export const listActivityTypesSchema = z.object({});

export async function listActivityTypes(
  _input: z.infer<typeof listActivityTypesSchema>,
) {
  // Note response key: `activityTypes` (camelCase plural).
  const { data } = await capsuleGet<{ activityTypes: unknown[] }>(
    "/activitytypes",
  );
  return data;
}

// ── Site (account info) ─────────────────────────────────────────────────────
//
// Returns the Capsule account this connector is currently connected to:
// subdomain, display name, URL. Useful as a "which Capsule am I talking
// to?" diagnostic — Capsule v2 does not expose a /users/me endpoint, so
// /site is the closest equivalent for "who/where am I authenticated as".

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

export const listTrackDefinitionsSchema = z.object({});

export async function listTrackDefinitions(
  _input: z.infer<typeof listTrackDefinitionsSchema>,
) {
  // Note response key: `trackDefinitions` (camelCase plural). Each entry
  // includes nested taskDefinitions describing the auto-tasks the track
  // creates when applied.
  const { data } = await capsuleGet<{ trackDefinitions: unknown[] }>(
    "/trackdefinitions",
  );
  return data;
}

// ── Categories (entry/task categorisation) ──────────────────────────────────
//
// Capsule lets users tag entries and tasks with a category (Call,
// Email, Meeting, Follow-up, etc.) for reporting. Returns the configured
// category list with id, name, and colour.

export const listCategoriesSchema = z.object({});

export async function listCategories(
  _input: z.infer<typeof listCategoriesSchema>,
) {
  const { data } = await capsuleGet<{ categories: unknown[] }>("/categories");
  return data;
}

// ── Goals (sales targets) ───────────────────────────────────────────────────
//
// Per-user / per-team revenue / activity goals. Empty for accounts that
// don't use the feature, populated for those that do. Useful for
// progress reporting.

export const listGoalsSchema = z.object({});

export async function listGoals(_input: z.infer<typeof listGoalsSchema>) {
  const { data } = await capsuleGet<{ goals: unknown[] }>("/goals");
  return data;
}
