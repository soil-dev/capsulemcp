import { z } from "zod";
import { capsuleDelete, capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

// Capsule rejects {amount} without a currency on opportunity create/update
// (422 Validation Failed). Make currency required at the schema layer so
// the error surfaces before the HTTP call.
const OpportunityValueSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z
    .string()
    .length(3)
    .describe(
      "ISO 4217 currency code (3 letters), e.g. 'GBP', 'USD', 'EUR'. Required when amount is set.",
    ),
});

// ── Read ────────────────────────────────────────────────────────────────────

export const searchOpportunitiesSchema = z.object({
  q: z.string().optional().describe("Free-text search query"),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function searchOpportunities(
  input: z.infer<typeof searchOpportunitiesSchema>,
) {
  // GET /opportunities ignores `q`; the search sub-resource is required for filtering.
  const path = input.q ? "/opportunities/search" : "/opportunities";
  const { data, nextPage } = await capsuleGet<{ opportunities: unknown[] }>(
    path,
    { q: input.q, embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const getOpportunitySchema = z.object({
  id: z.number().int().positive(),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
});

export async function getOpportunity(input: z.infer<typeof getOpportunitySchema>) {
  const { data } = await capsuleGet<{ opportunity: unknown }>(
    `/opportunities/${input.id}`,
    { embed: input.embed },
  );
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 10 opportunities by id in a single call. Capsule's
// path syntax: GET /opportunities/<id1>,<id2>,... — capped at 10 per call.

export const getOpportunitiesSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Array of opportunity IDs (1–10). Capsule caps batch fetches at 10."),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
});

export async function getOpportunities(
  input: z.infer<typeof getOpportunitiesSchema>,
) {
  const { data } = await capsuleGet<{ opportunities: unknown[] }>(
    `/opportunities/${input.ids.join(",")}`,
    { embed: input.embed },
  );
  return data;
}

// ── Write ───────────────────────────────────────────────────────────────────

export const createOpportunitySchema = z.object({
  name: z.string().min(1),
  partyId: z.number().int().positive().describe("ID of the party this opportunity belongs to"),
  milestoneId: z
    .number()
    .int()
    .positive()
    .describe(
      "ID of the pipeline milestone to place this opportunity at. The milestone implicitly determines the pipeline — there is no separate pipelineId parameter. Discover via list_pipelines / list_milestones.",
    ),
  description: z.string().optional(),
  value: OpportunityValueSchema.optional(),
  expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
  probability: z.number().int().min(0).max(100).optional(),
  ownerId: z.number().int().positive().optional(),
});

export async function createOpportunity(
  input: z.infer<typeof createOpportunitySchema>,
) {
  const { partyId, milestoneId, ownerId, ...rest } = input;

  const body: Record<string, unknown> = {
    ...rest,
    party: { id: partyId },
    milestone: { id: milestoneId },
  };
  if (ownerId) body["owner"] = { id: ownerId };

  return capsulePost<{ opportunity: unknown }>("/opportunities", { opportunity: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateOpportunitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).optional(),
  milestoneId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Move the opportunity to this milestone. Side effects depend on the target: " +
        "closing milestones (Won/Lost) auto-set `closedOn` to today and `probability` to the milestone default (100/0), preserving `lastOpenMilestone` as the previous open stage; moving back to an open milestone clears `closedOn` and re-applies the milestone's default probability (Won/Lost is reversible — no separate reopen tool). " +
        "WARNING: Capsule does NOT validate that the new milestone belongs to the opportunity's current pipeline. Passing a milestoneId from a different pipeline silently relocates the opportunity across pipelines, and `lastOpenMilestone` may then reference a milestone in the previous pipeline. Verify against the opportunity's current pipeline (read the opp first, list its pipeline's milestones via list_milestones) before passing a cross-pipeline id.",
    ),
  description: z.string().optional(),
  value: OpportunityValueSchema.optional(),
  expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  probability: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Win probability 0–100. On an open milestone this overrides the milestone's default probability. CANNOT be set in the same call as a closing milestone (Won/Lost) — Capsule processes the milestone change first, the opportunity becomes closed, then the probability update is rejected as edit-on-closed-opp with 422 'probability can be updated only for open opportunity'. To close an opportunity, leave probability out of the call: it auto-snaps to 100% (Won) or 0% (Lost).",
    ),
  lostReasonId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Reason the opportunity was lost. Only meaningful when transitioning to a Lost milestone — Capsule silently drops it for other milestones. Without this set, a connector-driven Lost-close leaves `lostReason: null`. Discover IDs via list_lostreasons.",
    ),
  ownerId: z.number().int().positive().optional(),
  fields: z
    .array(
      z.object({
        definitionId: z.number().int().positive(),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    )
    .optional()
    .describe(
      "Set custom field values on this opportunity. PARTIAL UPDATE: only the definitions you list are touched; any field NOT in this array is left unchanged. Discover available definitions via list_custom_fields; read current values via get_opportunity with embed='fields'. Pass value:null to attempt clearing a field.",
    ),
});

export async function updateOpportunity(
  input: z.infer<typeof updateOpportunitySchema>,
) {
  const { id, milestoneId, ownerId, lostReasonId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (milestoneId) body["milestone"] = { id: milestoneId };
  if (ownerId) body["owner"] = { id: ownerId };
  // Capsule's body field is `lostReason: {id}`. Only meaningful when
  // closing to Lost; for other milestones Capsule drops it silently.
  if (lostReasonId) body["lostReason"] = { id: lostReasonId };
  if (fields !== undefined) {
    body["fields"] = fields.map((f) => ({
      definition: { id: f.definitionId },
      value: f.value,
    }));
  }

  return capsulePut<{ opportunity: unknown }>(`/opportunities/${id}`, {
    opportunity: body,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteOpportunitySchema = z.object({
  id: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe("Must be set to true. Permanently deletes the opportunity. Irreversible."),
});

export async function deleteOpportunity(input: z.infer<typeof deleteOpportunitySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_opportunity requires confirm: true");
  }
  await capsuleDelete(`/opportunities/${input.id}`);
  return { deleted: true, id: input.id };
}
