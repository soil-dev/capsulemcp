import { z } from "zod";
import { capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

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

// ── Write ───────────────────────────────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().min(1),
  partyId: z.number().int().positive().describe("ID of the party linked to this project"),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional().default("OPEN"),
  ownerId: z.number().int().positive().optional(),
});

export async function createProject(input: z.infer<typeof createProjectSchema>) {
  const { partyId, ownerId, ...rest } = input;

  const body: Record<string, unknown> = {
    ...rest,
    party: { id: partyId },
  };
  if (ownerId) body["owner"] = { id: ownerId };

  return capsulePost<{ kase: unknown }>("/kases", { kase: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  ownerId: z.number().int().positive().optional(),
  expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
});

export async function updateProject(input: z.infer<typeof updateProjectSchema>) {
  const { id, ownerId, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (ownerId) body["owner"] = { id: ownerId };

  return capsulePut<{ kase: unknown }>(`/kases/${id}`, { kase: body });
}
