import { z } from "zod";
import {
  CapsuleApiError,
  capsuleDelete,
  capsuleGet,
  capsulePost,
  capsulePut,
} from "../capsule/client.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const listTasksSchema = z.object({
  // Note: Capsule has a third internal status `PENDING` (a task that's
  // part of an active track but not yet "open"), but it can only be
  // reached via track machinery — it is NOT directly settable by
  // /tasks PUT, and a list filter for it returns the same as OPEN
  // anyway. We expose only the two values that are actually filterable
  // by the v2 API.
  status: z
    .enum(["OPEN", "COMPLETED"])
    .optional()
    .describe(
      "Defaults to OPEN when omitted. Pass COMPLETED to filter to completed tasks, or 'OPEN' explicitly.",
    ),
  ownerId: z.number().int().positive().optional().describe("Filter to tasks owned by this user ID"),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listTasks(input: z.infer<typeof listTasksSchema>) {
  const { data, nextPage } = await capsuleGet<{ tasks: unknown[] }>("/tasks", {
    // Default 'OPEN' applied here (not via zod .default()) so that
    // z.infer keeps `status` optional for callers that omit it.
    status: input.status ?? "OPEN",
    // Capsule's owner filter is the bare query param `owner`, not `ownerId`/`assignedToUserId`.
    owner: input.ownerId,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const getTaskSchema = z.object({
  id: z.number().int().positive().describe("Task ID"),
});

export async function getTask(input: z.infer<typeof getTaskSchema>) {
  const { data } = await capsuleGet<{ task: unknown }>(`/tasks/${input.id}`);
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 10 tasks by id in a single call. Capsule's path
// syntax: GET /tasks/<id1>,<id2>,... — the server caps at 10 per call.

export const getTasksSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Array of task IDs (1–10). Capsule caps batch fetches at 10."),
});

export async function getTasks(input: z.infer<typeof getTasksSchema>) {
  const { data } = await capsuleGet<{ tasks: unknown[] }>(
    `/tasks/${input.ids.join(",")}`,
  );
  return data;
}

// ── Write ───────────────────────────────────────────────────────────────────

// MCP SDK needs a plain ZodObject shape; keep refine in the handler.
export const createTaskSchema = z.object({
  description: z.string().min(1),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM in user's timezone"),
  detail: z.string().optional(),
  ownerId: z.number().int().positive().optional(),
  partyId: z.number().int().positive().optional().describe("Link task to a party (mutually exclusive with opportunityId/projectId)"),
  opportunityId: z.number().int().positive().optional().describe("Link task to an opportunity (mutually exclusive with partyId/projectId)"),
  projectId: z.number().int().positive().optional().describe("Link task to a project (mutually exclusive with partyId/opportunityId)"),
});

export async function createTask(input: z.infer<typeof createTaskSchema>) {
  const linked = [input.partyId, input.opportunityId, input.projectId].filter(Boolean);
  if (linked.length > 1) {
    throw new Error("Provide at most one of partyId, opportunityId, or projectId");
  }
  const { ownerId, partyId, opportunityId, projectId, ...rest } = input;

  const body: Record<string, unknown> = { ...rest };
  if (ownerId) body["owner"] = { id: ownerId };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };

  return capsulePost<{ task: unknown }>("/tasks", { task: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateTaskSchema = z.object({
  id: z.number().int().positive(),
  description: z.string().min(1).optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM in user's timezone"),
  detail: z.string().optional(),
  // Capsule rejects direct sets of `PENDING` (which is a track-machinery
  // internal state) with 422 "cannot set task status to PENDING".
  // Only OPEN and COMPLETED are settable here.
  status: z
    .enum(["OPEN", "COMPLETED"])
    .optional()
    .describe(
      "Set to OPEN or COMPLETED. (PENDING exists internally for track-driven tasks but cannot be set directly via this tool — Capsule rejects it.) Setting status: OPEN on an already-open task is a true no-op (does not advance updatedAt).",
    ),
  ownerId: z.number().int().positive().optional(),
});

export async function updateTask(input: z.infer<typeof updateTaskSchema>) {
  const { id, ownerId, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (ownerId) body["owner"] = { id: ownerId };

  return capsulePut<{ task: unknown }>(`/tasks/${id}`, { task: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const completeTaskSchema = z.object({
  id: z.number().int().positive(),
});

export async function completeTask(input: z.infer<typeof completeTaskSchema>) {
  // Capsule uses PUT /tasks/{id} with status field — no dedicated /complete action
  return capsulePut<{ task: unknown }>(`/tasks/${input.id}`, {
    task: { status: "COMPLETED" },
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteTaskSchema = z.object({
  id: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe("Must be set to true. Permanently deletes the task. To mark done without losing history use complete_task. Irreversible."),
});

export async function deleteTask(input: z.infer<typeof deleteTaskSchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_task requires confirm: true");
  }
  try {
    await capsuleDelete(`/tasks/${input.id}`);
    return { deleted: true, alreadyDeleted: false, id: input.id };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return { deleted: true, alreadyDeleted: true, id: input.id };
    }
    throw err;
  }
}
