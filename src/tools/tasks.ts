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

export const createTaskSchema = z
  .object({
    description: z.string().min(1),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM in user's timezone"),
    detail: z.string().optional(),
    ownerId: z.number().int().positive().optional(),
    partyId: z.number().int().positive().optional(),
    opportunityId: z.number().int().positive().optional(),
    projectId: z.number().int().positive().optional(),
  })
  .refine(
    (d) => [d.partyId, d.opportunityId, d.projectId].filter(Boolean).length <= 1,
    { message: "Provide at most one of partyId, opportunityId, or projectId" },
  );

export async function createTask(input: z.infer<typeof createTaskSchema>) {
  const { ownerId, partyId, opportunityId, projectId, ...rest } = input;

  const body: Record<string, unknown> = { ...rest };
  if (ownerId) body["owner"] = { id: ownerId };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };

  return capsulePost<{ task: unknown }>("/tasks", { task: body });
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
