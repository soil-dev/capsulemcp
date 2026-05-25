import { z } from "zod";
import { setNullableRef, setRef } from "./body-helpers.js";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { defineDelete } from "./define-delete.js";
import { readEntityRefs } from "./preserve-refs.js";
import { positiveId } from "./shared-schemas.js";
import { capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";
import { chunk } from "../capsule/batch.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./custom-field-helpers.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const listProjectsSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listProjects(input: z.infer<typeof listProjectsSchema>) {
  const { data, nextPage } = await capsuleGet<{ kases: unknown[] }>("/kases", {
    status: input.status,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const getProjectSchema = z.object({
  id: positiveId,
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getProject(input: z.infer<typeof getProjectSchema>) {
  const { data } = await capsuleGet<{ kase: unknown }>(`/kases/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 10 projects by id in a single call. Capsule's path
// uses /kases (its legacy projects naming): GET /kases/<id1>,<id2>,...
// capped at 10 per request. For larger sets the connector splits and
// fans out in parallel; caller-facing shape unchanged.

export const getProjectsSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of project IDs (1–50). Capsule's native batch-fetch endpoint caps at 10 per request; the connector transparently splits larger sets into 10-id chunks and fans out the Capsule calls in parallel.",
    ),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getProjects(input: z.infer<typeof getProjectsSchema>) {
  const { ids, embed } = input;
  if (ids.length <= 10) {
    const { data } = await capsuleGet<{ kases: unknown[] }>(`/kases/${ids.join(",")}`, {
      embed,
    });
    return data;
  }
  const chunks = chunk(ids, 10);
  const responses = await Promise.all(
    chunks.map((chunkIds) =>
      capsuleGet<{ kases: unknown[] }>(`/kases/${chunkIds.join(",")}`, { embed }),
    ),
  );
  return { kases: responses.flatMap((r) => r.data.kases) };
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
});

export async function createProject(input: z.infer<typeof createProjectSchema>) {
  const { partyId, ownerId, teamId, status, stageId, ...rest } = input;

  // Default applied here (not via zod's .default()) so the inferred
  // input type keeps `status` optional. Same pattern as listTasks.
  const body: Record<string, unknown> = {
    ...rest,
    status: status ?? "OPEN",
    party: { id: partyId },
  };
  setRef(body, "owner", ownerId);
  setRef(body, "team", teamId);
  // Capsule's create-case body uses `stage: <integer>` per the docs
  // example. The GET response uses the object form `stage: {id, name}`,
  // but we follow the documented request shape on the way in. So we
  // set the value directly (not via setRef which wraps in {id:...}).
  if (stageId) body["stage"] = stageId;

  return capsulePost<{ kase: unknown }>("/kases", { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateProjectSchema = z.object({
  id: positiveId,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
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
    .optional()
    .describe(
      "Move the project to this stage (board column). Discover IDs via list_stages. Owner and team are preserved across stage-only updates (Capsule's PUT semantic). " +
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
  const { id, ownerId, teamId, stageId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }

  // Capsule's PUT on /kases has an asymmetric owner/team semantic:
  //
  //   `owner` in body          → Capsule clears `team` (unless `team` also in body)
  //   `team` in body           → Capsule preserves the existing `owner` (and validates owner ∈ team)
  //
  // To make `update_project { ownerId }` safe (so it doesn't accidentally
  // clear an existing team — or, defensively, stage), the connector reads
  // the current project and carries any omitted `team` / `stage` into the
  // PUT body whenever `ownerId` is being touched. Carrying stage is
  // defensive: alpha.20-era verification didn't directly probe whether
  // owner-in-body PUTs clear stage the way they clear team, but the cost
  // of a redundant `stage: <currentId>` is one extra integer in the body,
  // so we err on the safe side rather than risk a silent stage clear.
  //
  // `null` means "unassign" on either owner/team (matches Capsule's UI
  // "Unassign" option); `undefined` means "don't touch this field".
  let resolvedTeamId: number | null | undefined = teamId;
  let resolvedStageId: number | undefined = stageId;
  if (ownerId !== undefined && (teamId === undefined || stageId === undefined)) {
    // Only carry forward when the project actually has a value; if
    // current team/stage is null, leave the field out of the body
    // entirely (sending `team: null` would be a redundant clear and
    // could surprise on the owner-or-team-required 422 path; same
    // idea for stage).
    const current = await readEntityRefs(`/kases/${id}`, "kase");
    if (teamId === undefined) resolvedTeamId = current.teamId;
    if (stageId === undefined) resolvedStageId = current.stageId;
  }

  setNullableRef(body, "owner", ownerId);
  setNullableRef(body, "team", resolvedTeamId);
  if (resolvedStageId) body["stage"] = resolvedStageId;
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ kase: unknown }>(`/kases/${id}`, { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const { schema: deleteProjectSchema, handler: deleteProject } = defineDelete({
  toolName: "delete_project",
  pathPrefix: "/kases",
  confirmHint:
    "Must be set to true. Permanently deletes the project (case). Consider update_project status='CLOSED' instead. Irreversible.",
});
