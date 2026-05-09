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
