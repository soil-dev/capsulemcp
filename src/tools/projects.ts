import { z } from "zod";
import {
  capsuleDelete,
  capsuleGet,
  capsulePost,
  capsulePut,
} from "../capsule/client.js";
import { idempotent } from "../capsule/idempotent.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./_custom-fields.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const listProjectsSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
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
  id: z.number().int().positive(),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
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
// Capped at 10 per call.

export const getProjectsSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Array of project IDs (1–10). Capsule caps batch fetches at 10."),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
});

export async function getProjects(input: z.infer<typeof getProjectsSchema>) {
  const { data } = await capsuleGet<{ kases: unknown[] }>(
    `/kases/${input.ids.join(",")}`,
    { embed: input.embed },
  );
  return data;
}

// ── Write ───────────────────────────────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().min(1),
  partyId: z.number().int().positive().describe("ID of the party linked to this project"),
  description: z.string().optional(),
  status: z
    .enum(["OPEN", "CLOSED"])
    .optional()
    .describe("Defaults to OPEN when omitted."),
  ownerId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Assign to user ID. Defaults to NO owner when omitted (unlike create_party / create_opportunity / create_task which default to the API-token owner). " +
        "WARNING: when `stageId` is also supplied and the chosen stage's board has a default team, Capsule's create endpoint silently drops `ownerId` and keeps the board's team — the resulting project has owner=null. " +
        "To create a project with both an owner and a team, supply `ownerId` together with an explicit `teamId` (and either omit `stageId` or use a stage on a board with no default team). " +
        "To set an owner on a board-driven project after the fact, create it first, then `update_project { ownerId, teamId }` together — supplying `ownerId` alone on update will clear the team.",
    ),
  teamId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Assign to team ID (discover via list_teams). Capsule projects support three ownership shapes: owner alone, team alone, or owner+team (the user must be a member of the team — users can belong to multiple teams). " +
        "Supplying `teamId` overrides any team that would otherwise be auto-inherited from the board's default. " +
        "If you also supply `ownerId`, ensure the owner is a member of this team; otherwise Capsule rejects or silently coerces the combination.",
    ),
  stageId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Stage (board column) to place the project on. Discover IDs via list_stages — each stage belongs to one Board, so picking a stageId implicitly picks the board. If omitted, the project is created with no stage assignment (and won't appear on any board). The board's default team is auto-applied to the project's `team` field unless you supply an explicit `teamId`. Capsule's create endpoint resolves owner/team conflicts in favour of team: if you supply `ownerId` alongside a stageId whose board has a default team and no explicit `teamId`, the owner is silently dropped — supply `teamId` explicitly to keep both.",
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
  if (ownerId) body["owner"] = { id: ownerId };
  if (teamId) body["team"] = { id: teamId };
  // Capsule's create-case body uses `stage: <integer>` per the docs
  // example. The GET response uses the object form `stage: {id, name}`,
  // but we follow the documented request shape on the way in.
  if (stageId) body["stage"] = stageId;

  return capsulePost<{ kase: unknown }>("/kases", { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  ownerId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Reassign owner: pass a user ID to set, or `null` to unassign (matches the 'Unassign' option in Capsule's web UI). " +
        "WARNING: Capsule's PUT on /kases treats an absent `team` field in the request body as 'clear team to null', NOT 'leave unchanged'. " +
        "So `update_project { ownerId }` on a project that currently has a team will clear that team as a side effect — even if the new owner is a valid member of it. " +
        "To preserve (or change) team-scope across an owner change, supply `teamId` on the same call: `update_project { ownerId, teamId }`. " +
        "When both are supplied the owner must be a member of the team (users can belong to multiple teams).",
    ),
  teamId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Reassign team: pass a team ID (discover via list_teams) to set, or `null` to unassign. " +
        "WARNING: Capsule's PUT on /kases treats an absent `owner` field in the request body as 'clear owner to null', NOT 'leave unchanged'. " +
        "So `update_project { teamId }` on a project that currently has an owner will clear that owner as a side effect. " +
        "To preserve (or change) the owner across a team change, supply `ownerId` on the same call: `update_project { ownerId, teamId }`. " +
        "When both are supplied the owner must be a member of the team.",
    ),
  stageId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Move the project to this stage (board column). Discover IDs via list_stages. WARNING: Capsule does NOT validate that the new stage belongs to the project's current board — passing a stageId from a different board silently relocates the project across boards. Team and other board-derived defaults are NOT updated to match the new board. Verify against the project's current board (read the project first, list its board's stages) before passing a cross-board id.",
    ),
  expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
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
  // `null` means "unassign" (matches Capsule's UI "Unassign" option);
  // `undefined` means "don't touch this field in the body".
  if (ownerId === null) body["owner"] = null;
  else if (ownerId !== undefined) body["owner"] = { id: ownerId };
  if (teamId === null) body["team"] = null;
  else if (teamId !== undefined) body["team"] = { id: teamId };
  if (stageId) body["stage"] = stageId;
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ kase: unknown }>(`/kases/${id}`, { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteProjectSchema = z.object({
  id: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe("Must be set to true. Permanently deletes the project (case). Consider update_project status='CLOSED' instead. Irreversible."),
});

export async function deleteProject(input: z.infer<typeof deleteProjectSchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_project requires confirm: true");
  }
  return idempotent(
    () => capsuleDelete(`/kases/${input.id}`),
    () => ({ deleted: true, alreadyDeleted: false, id: input.id }),
    () => ({ deleted: true, alreadyDeleted: true, id: input.id }),
  );
}
