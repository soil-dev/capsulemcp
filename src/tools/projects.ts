import { z } from "zod";
import { setNullableRef, setRef } from "./body-helpers.js";
import { defineBatch } from "./define-batch.js";
import { defineDelete } from "./define-delete.js";
import { readEntityRefs } from "./preserve-refs.js";
import { positiveId, paginationFields, embedParam, RECORD_EMBEDS } from "./shared-schemas.js";
import { capsuleGet, capsulePost, capsulePut, capsuleGetList } from "../capsule/client.js";
import { chunkedMultiGet } from "../capsule/multi-get.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./custom-field-helpers.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const searchProjectsSchema = z.object({
  q: z.string().optional().describe("Free-text search query"),
  embed: embedParam(RECORD_EMBEDS),
  ...paginationFields,
});

export async function searchProjects(input: z.infer<typeof searchProjectsSchema>) {
  // GET /kases ignores `q`; the search sub-resource is required for filtering.
  const path = input.q ? "/kases/search" : "/kases";
  return capsuleGetList<{ projects: unknown[] }>(path, {
    q: input.q,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
}

export const listProjectsSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  embed: embedParam(RECORD_EMBEDS),
  ...paginationFields,
});

export async function listProjects(input: z.infer<typeof listProjectsSchema>) {
  return capsuleGetList<{ projects: unknown[] }>("/kases", {
    status: input.status,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const getProjectSchema = z.object({
  id: positiveId,
  embed: embedParam(RECORD_EMBEDS),
});

export async function getProject(input: z.infer<typeof getProjectSchema>) {
  const { data } = await capsuleGet<{ project: unknown }>(`/kases/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 50 projects by id. Capsule's native multi-id path
// uses /kases and is capped at 10 ids per request, so larger inputs are
// split and fanned out in parallel; caller-facing shape unchanged.

export const getProjectsSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of project IDs (1–50). Capsule's native batch-fetch endpoint caps at 10 per request; the connector transparently splits larger sets into 10-id chunks and fans out the Capsule calls in parallel.",
    ),
  embed: embedParam(RECORD_EMBEDS),
});

export async function getProjects(input: z.infer<typeof getProjectsSchema>) {
  return chunkedMultiGet("/kases", "projects", input.ids, { embed: input.embed });
}

// ── Write ───────────────────────────────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().min(1),
  partyId: positiveId.describe("ID of the party linked to this project"),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional().describe("Defaults to OPEN when omitted."),
  ownerId: positiveId
    .optional()
    .describe(
      "Assign to user ID. Defaults to the API-token owner when omitted, same as create_party / create_opportunity / create_task. " +
        "NOTE: some Capsule tenants configure board-level **automation rules** that mutate `owner` (and `team`) on project creation — e.g. an automation that clears `owner` when a project enters a particular board. If you observe a project landing with unexpected `owner: null` after a create_project with `ownerId`, check the target board's automation configuration. Capsule's API itself does not drop `ownerId` when `stageId` is also supplied.",
    ),
  teamId: positiveId
    .optional()
    .describe(
      "Assign to team ID (discover via list_teams). Capsule projects must always have at least one of {owner, team} set — Capsule returns 422 'owner or team is required' otherwise. " +
        "Three ownership shapes are valid: owner alone, team alone, or owner+team (the user must be a member of the team — users can belong to multiple teams; 422 'owner is not a member of the team' otherwise). " +
        "Tenant-specific board automations may set the team field on project creation (e.g. 'when project enters board X, set team to T'). If you observe a team set despite omitting `teamId`, check the target board's automation rules.",
    ),
  stageId: positiveId
    .optional()
    .describe(
      "Stage (board column) to place the project on. Discover IDs via list_stages — each stage belongs to one Board, so picking a stageId implicitly picks the board. If omitted, the project is created with no stage assignment (and won't appear on any board). " +
        "NOTE: tenant-specific board automation rules may run on project creation and mutate `owner` / `team` fields. See `create_project.ownerId` / `create_project.teamId` for the automation caveat. Capsule's create endpoint itself preserves the `ownerId` / `teamId` you supply — any clearing you observe traces to board automations, not the API.",
    ),
  expectedCloseOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD"),
  fields: z
    .array(CustomFieldWriteSchema)
    .optional()
    .describe(
      fieldsArrayDescriptor("get_project") +
        " Verified empirically in v1.6.5 wire-trace: Capsule's project create endpoint accepts the same `fields[]` shape as PUT, so callers can set custom field values on creation without a follow-up update. Project-specific: setting a field whose definition lives under a 'data tag' populates the row's internal tagId but does NOT auto-add the data tag to the project's tags array — use add_tag explicitly if you want it visible via embed=tags.",
    ),
});

export async function createProject(input: z.infer<typeof createProjectSchema>) {
  const { partyId, ownerId, teamId, status, stageId, fields, ...rest } = input;

  // Default applied here (not via zod's .default()) so the inferred
  // input type keeps `status` optional. Same pattern as listTasks.
  const body: Record<string, unknown> = {
    ...rest,
    status: status ?? "OPEN",
    party: { id: partyId },
  };
  setRef(body, "owner", ownerId);
  setRef(body, "team", teamId);
  // Capsule's project create body uses `stage: <integer>` per the docs
  // example. The GET response uses the object form `stage: {id, name}`,
  // but we follow the documented request shape on the way in. So we
  // set the value directly (not via setRef which wraps in {id:...}).
  if (stageId) body["stage"] = stageId;
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePost<{ project: unknown }>("/kases", { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateProjectSchema = z.object({
  id: positiveId,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  partyId: positiveId
    .optional()
    .describe(
      "Reassign the project to a different primary party. Capsule requires every project to have a party — passing `null` is rejected with 422 'party is required' (verified empirically in v1.6.3 wire-trace). Discover ids via search_parties / filter_parties. " +
        "NOTE: parent-ref nullability differs by entity — `update_task.partyId` IS nullable (orphan task), but opportunities and projects must always have a parent party. The same applies to `update_opportunity.partyId`.",
    ),
  ownerId: positiveId
    .nullable()
    .optional()
    .describe(
      "Reassign owner: pass a user ID to set, or `null` to unassign (matches the 'Unassign' option in Capsule's web UI). " +
        "When you supply `ownerId` and omit `teamId` and/or `stageId`, the connector fetches the project's current omitted fields and includes them in the PUT body — this preserves them across the owner change (without it, Capsule's PUT would clear team; stage carry is defensive against the symmetric clear). " +
        "Supply `teamId` and/or `stageId` explicitly on the same call to change them instead. `teamId: null` clears the team as part of an owner change. " +
        "Constraints (Capsule enforces, 422 on violation): owner must be a member of the team if both are set; a project must always have at least one of {owner, team} set (cannot clear both).",
    ),
  teamId: positiveId
    .nullable()
    .optional()
    .describe(
      "Reassign team: pass a team ID (discover via list_teams) to set, or `null` to unassign. " +
        "Capsule preserves the existing owner across a team change (server-side), so `update_project { teamId }` alone is safe — the owner is carried through. " +
        "Owner must be a member of the new team or Capsule returns 422 'owner is not a member of the team'. " +
        "A project must always have at least one of {owner, team} set — `teamId: null` on a project whose owner is already null returns 422 'owner or team is required'.",
    ),
  stageId: positiveId
    .nullable()
    .optional()
    .describe(
      "Move the project to this stage (board column), or `null` to remove from all stages (verified empirically in v1.6.5 wire-trace — Capsule accepts `stage: null` on project update and the project no longer appears on any board). Discover IDs via list_stages. Owner and team are preserved across stage-only updates (Capsule's PUT semantic). " +
        "WARNING (cross-board): Capsule does NOT validate that the new stage belongs to the project's current board — passing a stageId from a different board silently relocates the project across boards. Team and other board-derived defaults are NOT updated to match the new board. Verify against the project's current board (read the project first, list its board's stages) before passing a cross-board id.",
    ),
  expectedCloseOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD"),
  fields: z
    .array(CustomFieldWriteSchema)
    .optional()
    .describe(
      fieldsArrayDescriptor("get_project") +
        " Project-specific: setting a field whose definition lives under a 'data tag' populates the row's internal tagId but does NOT auto-add the data tag to the project's tags array — use add_tag explicitly if you want it visible via embed=tags.",
    ),
});

export async function updateProject(input: z.infer<typeof updateProjectSchema>) {
  const { id, partyId, ownerId, teamId, stageId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  setRef(body, "party", partyId);

  // Defeat Capsule's owner→clears-team asymmetric PUT semantic on
  // /kases (NOTES-ON-CAPSULE-API.md §27). When ownerId is being
  // touched and team/stage are omitted, read the current values and
  // carry them forward. Stage carry is defensive (alpha.20-era
  // verification didn't directly probe the symmetric clear, but a
  // redundant stage in body is cheaper than risking a silent clear).
  // `stageId: null` is an explicit clear and bypasses the carry-forward
  // path — `undefined` means "don't touch", `null` means "remove from
  // all stages" (verified accepted in v1.6.5 wire-trace).
  let resolvedTeamId: number | null | undefined = teamId;
  let resolvedStageId: number | null | undefined = stageId;
  if (ownerId !== undefined && (teamId === undefined || stageId === undefined)) {
    const current = await readEntityRefs(`/kases/${id}`, "project");
    if (teamId === undefined) resolvedTeamId = current.teamId;
    if (stageId === undefined) resolvedStageId = current.stageId;
  }

  setNullableRef(body, "owner", ownerId);
  setNullableRef(body, "team", resolvedTeamId);
  // Capsule's stage uses a bare integer on the wire (not `{id: ...}`).
  // `null` clears the stage; `undefined` leaves it untouched.
  if (resolvedStageId === null) body["stage"] = null;
  else if (resolvedStageId !== undefined) body["stage"] = resolvedStageId;
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ project: unknown }>(`/kases/${id}`, { kase: body });
}

// ── batch_update_project (write, fan-out) ──────────────────────────────────

export const { schema: batchUpdateProjectSchema, handler: batchUpdateProject } = defineBatch({
  toolName: "batch_update_project",
  itemSchema: updateProjectSchema,
  itemDescription:
    "Array of 1–50 update_project inputs. Each item is the same shape as a single update_project call — id is required, every other field is optional. Capped at 50 so a single tool call can't burn an outsized share of Capsule's hourly per-token rate budget (~4000 req/h). Mirrors batch_update_party and batch_update_opportunity — same shape across the three entity types.",
  itemHandler: updateProject,
});

// ───────────────────────────────────────────────────────────────────────────

export const { schema: deleteProjectSchema, handler: deleteProject } = defineDelete({
  toolName: "delete_project",
  pathPrefix: "/kases",
  confirmHint:
    "Must be set to true. Permanently deletes the project. Consider update_project status='CLOSED' instead. Irreversible.",
});
