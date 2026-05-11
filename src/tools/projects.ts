import { z } from "zod";
import { capsuleDelete, capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

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
  ownerId: z.number().int().positive().optional(),
  stageId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Stage (board column) to place the project on. Discover IDs via list_stages — each stage belongs to one Board, so picking a stageId implicitly picks the board. If omitted, the project is created with no stage assignment (and won't appear on any board).",
    ),
  expectedCloseOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD"),
});

export async function createProject(input: z.infer<typeof createProjectSchema>) {
  const { partyId, ownerId, status, stageId, ...rest } = input;

  // Default applied here (not via zod's .default()) so the inferred
  // input type keeps `status` optional. Same pattern as listTasks.
  const body: Record<string, unknown> = {
    ...rest,
    status: status ?? "OPEN",
    party: { id: partyId },
  };
  if (ownerId) body["owner"] = { id: ownerId };
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
  ownerId: z.number().int().positive().optional(),
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
    .array(
      z.object({
        definitionId: z.number().int().positive(),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .describe(
            "String for TEXT/DATE/LIST/LARGE_TEXT/LINK, number for NUMBER, boolean for BOOLEAN. Clearing: null works for TEXT/NUMBER/DATE/LIST; BOOLEAN rejects null with 422 — set to false instead. NUMBER read-back via embed=fields returns as a STRING (e.g. '3' not 3). TEXT '' has the same effect as null (row removed). Note: setting a field under a 'data tag' (e.g. Support Agreement Details) populates the row's internal tagId but does NOT auto-add the data tag to the project's tags array — use add_tag explicitly if you want it visible via embed=tags.",
          ),
      }),
    )
    .optional()
    .describe(
      "Set custom field values on this project. PARTIAL UPDATE: only the definitions you list are touched; any field NOT in this array is left unchanged. Discover available definitions via list_custom_fields; read current values via get_project with embed='fields'.",
    ),
});

export async function updateProject(input: z.infer<typeof updateProjectSchema>) {
  const { id, ownerId, stageId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (ownerId) body["owner"] = { id: ownerId };
  if (stageId) body["stage"] = stageId;
  if (fields !== undefined) {
    body["fields"] = fields.map((f) => ({
      definition: { id: f.definitionId },
      value: f.value,
    }));
  }

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
  await capsuleDelete(`/kases/${input.id}`);
  return { deleted: true, id: input.id };
}
