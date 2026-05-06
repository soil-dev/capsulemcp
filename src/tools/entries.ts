import { z } from "zod";
import { capsuleDelete, capsuleGet, capsulePost } from "../capsule/client.js";

// ── Read ────────────────────────────────────────────────────────────────────

const listEntriesPagination = {
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
  embed: z
    .string()
    .optional()
    .describe("Comma-separated embeds, e.g. 'attachments,participants'"),
};

export const listPartyEntriesSchema = z.object({
  partyId: z.number().int().positive(),
  ...listEntriesPagination,
});

export async function listPartyEntries(input: z.infer<typeof listPartyEntriesSchema>) {
  const { data, nextPage } = await capsuleGet<{ entries: unknown[] }>(
    `/parties/${input.partyId}/entries`,
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

export const listOpportunityEntriesSchema = z.object({
  opportunityId: z.number().int().positive(),
  ...listEntriesPagination,
});

export async function listOpportunityEntries(
  input: z.infer<typeof listOpportunityEntriesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{ entries: unknown[] }>(
    `/opportunities/${input.opportunityId}/entries`,
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

export const listProjectEntriesSchema = z.object({
  projectId: z.number().int().positive(),
  ...listEntriesPagination,
});

export async function listProjectEntries(
  input: z.infer<typeof listProjectEntriesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{ entries: unknown[] }>(
    `/kases/${input.projectId}/entries`,
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

export const getEntrySchema = z.object({
  id: z.number().int().positive(),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'attachments,participants'"),
});

export async function getEntry(input: z.infer<typeof getEntrySchema>) {
  const { data } = await capsuleGet<{ entry: unknown }>(`/entries/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ── Write ───────────────────────────────────────────────────────────────────

// MCP SDK needs a plain ZodObject shape; enforce the exactly-one constraint in the handler.
export const addNoteSchema = z.object({
  content: z.string().min(1).describe("Note body text"),
  partyId: z.number().int().positive().optional().describe("Link note to a party (mutually exclusive with opportunityId/projectId)"),
  opportunityId: z.number().int().positive().optional().describe("Link note to an opportunity (mutually exclusive with partyId/projectId)"),
  projectId: z.number().int().positive().optional().describe("Link note to a project (mutually exclusive with partyId/opportunityId)"),
});

export async function addNote(input: z.infer<typeof addNoteSchema>) {
  const { content, partyId, opportunityId, projectId } = input;

  const linked = [partyId, opportunityId, projectId].filter(Boolean);
  if (linked.length !== 1) {
    throw new Error("Provide exactly one of partyId, opportunityId, or projectId");
  }

  const body: Record<string, unknown> = { type: "note", content };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };

  return capsulePost<{ entry: unknown }>("/entries", { entry: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteEntrySchema = z.object({
  id: z.number().int().positive().describe("Entry (note/email/task-record) ID"),
  confirm: z
    .literal(true)
    .describe("Must be set to true. Permanently deletes the entry — use this to remove a note from a party/opportunity/project. Irreversible."),
});

export async function deleteEntry(input: z.infer<typeof deleteEntrySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_entry requires confirm: true");
  }
  await capsuleDelete(`/entries/${input.id}`);
  return { deleted: true, id: input.id };
}
