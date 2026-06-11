import { z } from "zod";
import { assertSingleParentRef, setNullableRef, setRef } from "./body-helpers.js";
import { defineDelete } from "./define-delete.js";
import { positiveId, paginationFields } from "./shared-schemas.js";
import { capsuleGet, capsulePost, capsulePut, capsuleGetList } from "../capsule/client.js";
import { type BatchOpts, batchExecute } from "../capsule/batch.js";
import { chunkedMultiGet } from "../capsule/multi-get.js";

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
  ownerId: positiveId.optional().describe("Filter to tasks owned by this user ID"),
  ...paginationFields,
});

export async function listTasks(input: z.infer<typeof listTasksSchema>) {
  return capsuleGetList<{ tasks: unknown[] }>("/tasks", {
    // Default 'OPEN' applied here (not via zod .default()) so that
    // z.infer keeps `status` optional for callers that omit it.
    status: input.status ?? "OPEN",
    // Capsule's owner filter is the bare query param `owner`, not `ownerId`/`assignedToUserId`.
    owner: input.ownerId,
    page: input.page,
    perPage: input.perPage,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const getTaskSchema = z.object({
  id: positiveId.describe("Task ID"),
});

export async function getTask(input: z.infer<typeof getTaskSchema>) {
  const { data } = await capsuleGet<{ task: unknown }>(`/tasks/${input.id}`);
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 50 tasks by id. Capsule's path syntax:
// GET /tasks/<id1>,<id2>,... caps at 10 ids per request, so larger
// caller batches are split into 10-id chunks and merged.

export const getTasksSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of task IDs (1–50). Capsule's native batch-fetch endpoint caps at 10 per request; the connector transparently splits larger sets into 10-id chunks and fans out the Capsule calls in parallel.",
    ),
});

export async function getTasks(input: z.infer<typeof getTasksSchema>) {
  return chunkedMultiGet("/tasks", "tasks", input.ids);
}

// ── Write ───────────────────────────────────────────────────────────────────

// MCP SDK needs a plain ZodObject shape; keep refine in the handler.
export const createTaskSchema = z.object({
  description: z.string().min(1),
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("YYYY-MM-DD"),
  dueTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("HH:MM in user's timezone"),
  detail: z.string().optional(),
  ownerId: positiveId
    .optional()
    .describe(
      "Assign to user ID. Defaults to the API-token owner when omitted. Once set, this connector cannot clear the owner back to null — use Capsule's web UI for that.",
    ),
  partyId: positiveId
    .optional()
    .describe("Link task to a party (mutually exclusive with opportunityId/projectId)"),
  opportunityId: positiveId
    .optional()
    .describe("Link task to an opportunity (mutually exclusive with partyId/projectId)"),
  projectId: positiveId
    .optional()
    .describe("Link task to a project (mutually exclusive with partyId/opportunityId)"),
});

export async function createTask(input: z.infer<typeof createTaskSchema>) {
  assertSingleParentRef("create_task", input);
  const { ownerId, partyId, opportunityId, projectId, ...rest } = input;

  const body: Record<string, unknown> = { ...rest };
  setRef(body, "owner", ownerId);
  setRef(body, "party", partyId);
  setRef(body, "opportunity", opportunityId);
  setRef(body, "kase", projectId);

  return capsulePost<{ task: unknown }>("/tasks", { task: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateTaskSchema = z.object({
  id: positiveId,
  description: z.string().min(1).optional(),
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD"),
  dueTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("HH:MM in user's timezone"),
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
  ownerId: positiveId
    .optional()
    .describe(
      "Reassign owner to user ID. Once set, this connector cannot clear an owner back to null — use Capsule's web UI for that.",
    ),
  partyId: positiveId
    .nullable()
    .optional()
    .describe(
      "Re-link the task to a party by id, or `null` to orphan it. Mutually exclusive with `opportunityId` / `projectId` — Capsule enforces 'task can be related to at most one entity' server-side (422 if two parent-refs are set at once, verified in v1.6.3 wire-trace). To swap parent type atomically, pass the old one as `null` and the new one as an id in the same call. " +
        "NOTE: orphaning is unique to tasks — `update_opportunity.partyId` and `update_project.partyId` are NOT nullable (Capsule rejects with 422 'party is required'). Tasks are the only entity in Capsule's data model that can exist without any parent.",
    ),
  opportunityId: positiveId
    .nullable()
    .optional()
    .describe(
      "Re-link the task to an opportunity by id, or `null` to orphan it. Mutually exclusive with `partyId` / `projectId` — see `partyId` for the XOR semantic.",
    ),
  projectId: positiveId
    .nullable()
    .optional()
    .describe(
      "Re-link the task to a project by id, or `null` to orphan it. Mutually exclusive with `partyId` / `opportunityId` — see `partyId` for the XOR semantic.",
    ),
});

export async function updateTask(input: z.infer<typeof updateTaskSchema>) {
  const { id, ownerId, partyId, opportunityId, projectId, ...rest } = input;

  // Capsule enforces "at most one related entity" with a 422 on the PUT
  // itself; the shared client-side check gives callers a cleaner error
  // before the HTTP round-trip. `null` (explicit unlink) does NOT count
  // toward the cap — callers can pass `partyId: null, opportunityId: 123`
  // to swap parent type.
  assertSingleParentRef("update_task", { partyId, opportunityId, projectId });

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  setRef(body, "owner", ownerId);
  setNullableRef(body, "party", partyId);
  setNullableRef(body, "opportunity", opportunityId);
  setNullableRef(body, "kase", projectId);

  return capsulePut<{ task: unknown }>(`/tasks/${id}`, { task: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const completeTaskSchema = z.object({
  id: positiveId,
});

export async function completeTask(input: z.infer<typeof completeTaskSchema>) {
  // Capsule uses PUT /tasks/{id} with status field — no dedicated /complete action
  return capsulePut<{ task: unknown }>(`/tasks/${input.id}`, {
    task: { status: "COMPLETED" },
  });
}

// ── batch_complete_task (write, fan-out) ──────────────────────────────────

export const batchCompleteTaskSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of 1–50 task ids to mark COMPLETED in parallel. Each id resolves to one PUT /tasks/{id}; failures (e.g. 404 for a deleted task) surface per-item in the result array, the rest still complete. Capped at 50.",
    ),
});

export async function batchCompleteTask(
  input: z.infer<typeof batchCompleteTaskSchema>,
  opts: BatchOpts = {},
) {
  return batchExecute("batch_complete_task", input.ids, (id) => completeTask({ id }), opts);
}

// ───────────────────────────────────────────────────────────────────────────

export const { schema: deleteTaskSchema, handler: deleteTask } = defineDelete({
  toolName: "delete_task",
  pathPrefix: "/tasks",
  confirmHint:
    "Must be set to true. Permanently deletes the task. To mark done without losing history use complete_task. Irreversible.",
});
