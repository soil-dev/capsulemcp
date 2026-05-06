import { z } from "zod";
import { capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const listTasksSchema = z.object({
  status: z.enum(["OPEN", "COMPLETED", "PENDING"]).optional(),
  assignedToUserId: z.number().int().positive().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter by due date YYYY-MM-DD"),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listTasks(input: z.infer<typeof listTasksSchema>) {
  const { data, nextPage } = await capsuleGet<{ tasks: unknown[] }>("/tasks", {
    status: input.status,
    assignedToUserId: input.assignedToUserId,
    dueOn: input.dueOn,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
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
  status: z.enum(["OPEN", "COMPLETED", "PENDING"]).optional(),
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
