import { z } from "zod";
import { EMBED_ATTACHMENTS_PARTICIPANTS_DESCRIPTION } from "./descriptions.js";
import { confirmFlag } from "./confirm-flag.js";
import { idempotent } from "../capsule/idempotent.js";
import {
  capsuleDelete,
  capsuleGet,
  capsulePost,
  capsulePut,
} from "../capsule/client.js";

// ── Read ────────────────────────────────────────────────────────────────────

const listEntriesPagination = {
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
  embed: z
    .string()
    .optional()
    .describe(EMBED_ATTACHMENTS_PARTICIPANTS_DESCRIPTION),
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
  embed: z.string().optional().describe(EMBED_ATTACHMENTS_PARTICIPANTS_DESCRIPTION),
});

export async function getEntry(input: z.infer<typeof getEntrySchema>) {
  const { data } = await capsuleGet<{ entry: unknown }>(`/entries/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ── Global entries feed ─────────────────────────────────────────────────────
//
// GET /entries returns every timeline entry in the account, paginated.
// Useful for "what activity happened across the company today/this week"
// without iterating over every party/opportunity/project. Default order
// is most-recent-first (Capsule's default for /entries specifically).

export const listEntriesSchema = z.object({
  ...listEntriesPagination,
});

export async function listEntries(input: z.infer<typeof listEntriesSchema>) {
  const { data, nextPage } = await capsuleGet<{ entries: unknown[] }>(
    "/entries",
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

// ── Write ───────────────────────────────────────────────────────────────────

// MCP SDK needs a plain ZodObject shape; enforce the exactly-one constraint in the handler.
export const addNoteSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "Note body text. Stored verbatim and treated as MARKDOWN — Capsule's web UI renders the markdown when displaying. Pass markdown source ('# Heading', '**bold**', '- bullet'), not HTML.",
    ),
  partyId: z.number().int().positive().optional().describe("Link note to a party (mutually exclusive with opportunityId/projectId)"),
  opportunityId: z.number().int().positive().optional().describe("Link note to an opportunity (mutually exclusive with partyId/projectId)"),
  projectId: z.number().int().positive().optional().describe("Link note to a project (mutually exclusive with partyId/opportunityId)"),
  entryAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/)
    .optional()
    .describe(
      "ISO-8601 timestamp for when this note actually happened (e.g. '2024-03-15T14:30:00Z'). Defaults to now. Use this for backdating historical notes when migrating from another system. `entryAt` is preserved across subsequent update_entry calls; only `updatedAt` advances on edits. Note attribution flows to the API-token owner — there is no way to record a note as authored by a different user via this connector (a `creatorId` parameter would enable audit-attribution spoofing on shared-connector deployments, so it is intentionally not exposed).",
    ),
});

export async function addNote(input: z.infer<typeof addNoteSchema>) {
  const { content, partyId, opportunityId, projectId, entryAt } = input;

  const linked = [partyId, opportunityId, projectId].filter(Boolean);
  if (linked.length !== 1) {
    throw new Error("Provide exactly one of partyId, opportunityId, or projectId");
  }

  const body: Record<string, unknown> = { type: "note", content };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };
  if (entryAt !== undefined) body["entryAt"] = entryAt;

  return capsulePost<{ entry: unknown }>("/entries", { entry: body });
}

// ───────────────────────────────────────────────────────────────────────────
//
// update_entry: edit an existing timeline entry (typically a note Claude
// or a user added previously). Capsule's PUT semantics are partial: only
// fields you provide are changed. The most common use case is editing
// `content` on a note. The `type` field is fixed at create time and
// can't be changed via this endpoint.

export const updateEntrySchema = z.object({
  id: z.number().int().positive().describe("Entry ID to update"),
  content: z
    .string()
    .min(1)
    .optional()
    .describe(
      "New body text for the entry. For notes, this is the markdown content; for emails, the body. Provide only if you want to change it.",
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "New subject line. Mostly meaningful on email-type entries; on plain notes Capsule accepts the call (HTTP 200) but **does not store the subject and does not advance `updatedAt`** — a true no-op for inapplicable fields. `entryAt` (when the note was authored) is preserved across edits; `updatedAt` advances only when an applicable field actually changes. To sort/filter by 'when did this happen', use `entryAt`; for 'last touched', use `updatedAt`.",
    ),
});

export async function updateEntry(input: z.infer<typeof updateEntrySchema>) {
  const { id, ...rest } = input;
  const body: Record<string, unknown> = {};
  if (rest.content !== undefined) body["content"] = rest.content;
  if (rest.subject !== undefined) body["subject"] = rest.subject;

  if (Object.keys(body).length === 0) {
    throw new Error(
      "update_entry: provide at least one field to update (content or subject)",
    );
  }

  return capsulePut<{ entry: unknown }>(`/entries/${id}`, { entry: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteEntrySchema = z.object({
  id: z.number().int().positive().describe("Entry (note/email/task-record) ID"),
  confirm: confirmFlag()
    .describe("Must be set to true. Permanently deletes the entry — use this to remove a note from a party/opportunity/project. Irreversible."),
});

export async function deleteEntry(input: z.infer<typeof deleteEntrySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_entry requires confirm: true");
  }
  return idempotent(
    () => capsuleDelete(`/entries/${input.id}`),
    () => ({ deleted: true, alreadyDeleted: false, id: input.id }),
    () => ({ deleted: true, alreadyDeleted: true, id: input.id }),
  );
}
