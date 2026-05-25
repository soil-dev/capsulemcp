import { z } from "zod";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { confirmFlag } from "./confirm-flag.js";
import { positiveId } from "./shared-schemas.js";
import { capsuleDelete, capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";
import { type BatchOpts, batchExecute, chunk } from "../capsule/batch.js";
import { idempotent } from "../capsule/idempotent.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./custom-field-helpers.js";

// Capsule rejects {amount} without a currency on opportunity create/update
// (422 Validation Failed). Make currency required at the schema layer so
// the error surfaces before the HTTP call.
//
// The custom `error` on `currency` intercepts ONLY the
// missing-field (invalid_type / undefined) case to produce an
// operator-readable message; length/type errors still flow through the
// default Zod messages so callers see exactly which constraint failed.
const OpportunityValueSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z
    .string({
      error: (iss) =>
        iss.code === "invalid_type" && iss.input === undefined
          ? "currency is required when amount is set (3-letter ISO 4217 code, e.g. 'USD', 'EUR', 'GBP')"
          : undefined,
    })
    .length(3)
    .describe(
      "ISO 4217 currency code (3 letters), e.g. 'GBP', 'USD', 'EUR'. Required when amount is set.",
    ),
});

// ── Read ────────────────────────────────────────────────────────────────────

export const searchOpportunitiesSchema = z.object({
  q: z.string().optional().describe("Free-text search query"),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function searchOpportunities(input: z.infer<typeof searchOpportunitiesSchema>) {
  // GET /opportunities ignores `q`; the search sub-resource is required for filtering.
  const path = input.q ? "/opportunities/search" : "/opportunities";
  const { data, nextPage } = await capsuleGet<{ opportunities: unknown[] }>(path, {
    q: input.q,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const getOpportunitySchema = z.object({
  id: positiveId,
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getOpportunity(input: z.infer<typeof getOpportunitySchema>) {
  const { data } = await capsuleGet<{ opportunity: unknown }>(`/opportunities/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 50 opportunities by id. Capsule's native multi-id
// path caps at 10 per request; for larger sets the connector splits
// into 10-id chunks and fans out the Capsule GETs in parallel. Same
// caller-facing shape regardless of input size.

export const getOpportunitiesSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of opportunity IDs (1–50). Capsule's native batch-fetch endpoint caps at 10 per request; the connector transparently splits larger sets into 10-id chunks and fans out the Capsule calls in parallel.",
    ),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getOpportunities(input: z.infer<typeof getOpportunitiesSchema>) {
  const { ids, embed } = input;
  if (ids.length <= 10) {
    const { data } = await capsuleGet<{ opportunities: unknown[] }>(
      `/opportunities/${ids.join(",")}`,
      { embed },
    );
    return data;
  }
  const chunks = chunk(ids, 10);
  const responses = await Promise.all(
    chunks.map((chunkIds) =>
      capsuleGet<{ opportunities: unknown[] }>(`/opportunities/${chunkIds.join(",")}`, {
        embed,
      }),
    ),
  );
  return { opportunities: responses.flatMap((r) => r.data.opportunities) };
}

// ── Write ───────────────────────────────────────────────────────────────────

export const createOpportunitySchema = z.object({
  name: z.string().min(1),
  partyId: positiveId.describe("ID of the party this opportunity belongs to"),
  milestoneId: positiveId.describe(
    "ID of the pipeline milestone to place this opportunity at. The milestone implicitly determines the pipeline — there is no separate pipelineId parameter. Discover via list_pipelines / list_milestones. " +
      "NOTE: some Capsule tenants configure **pipeline / milestone-reached automation rules** that mutate `owner` and/or `team` immediately after creation — e.g. an 'Assign to a Team' action that fires on entry to a specific milestone and inherits the asymmetric write semantic documented in NOTES-ON-CAPSULE-API.md §27 (setting `team` server-side clears `owner` as a side-effect). If you observe a newly-created opp landing with `owner: null` despite passing `ownerId`, the cause is almost certainly a milestone automation on the destination pipeline rather than the connector. Documented workaround: follow `create_opportunity` with an immediate `batch_update_opportunity({items: [{id, ownerId, teamId}]})` carrying both fields — PUT does not re-fire milestone-reached triggers, so the owner sticks.",
  ),
  description: z.string().optional(),
  value: OpportunityValueSchema.optional(),
  expectedCloseOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD"),
  probability: z.number().int().min(0).max(100).optional(),
  ownerId: positiveId
    .optional()
    .describe(
      "Assign to user ID. Defaults to the API-token owner when omitted — note that opportunities do NOT inherit owner from the linked party, even though one might expect it. Once set, this connector cannot clear the owner back to null (use Capsule's web UI). Discover IDs via list_users. " +
        "WARNING: tenant pipeline / milestone-reached automation can mutate this field post-create — see the `milestoneId` description for details and the chained-PUT workaround.",
    ),
  teamId: positiveId
    .optional()
    .describe(
      "Assign to team ID (discover via list_teams). Independent from `ownerId` — setting one does NOT clear the other on create. Three ownership shapes are valid: owner alone, team alone, or owner+team (the owner must be a member of the team; users can belong to multiple teams — 422 'owner is not a member of the team' otherwise).",
    ),
});

export async function createOpportunity(input: z.infer<typeof createOpportunitySchema>) {
  const { partyId, milestoneId, ownerId, teamId, ...rest } = input;

  const body: Record<string, unknown> = {
    ...rest,
    party: { id: partyId },
    milestone: { id: milestoneId },
  };
  if (ownerId) body["owner"] = { id: ownerId };
  if (teamId) body["team"] = { id: teamId };

  return capsulePost<{ opportunity: unknown }>("/opportunities", { opportunity: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const updateOpportunitySchema = z.object({
  id: positiveId,
  name: z.string().min(1).optional(),
  milestoneId: positiveId
    .optional()
    .describe(
      "Move the opportunity to this milestone. Side effects depend on the target: " +
        "closing milestones (Won/Lost) auto-set `closedOn` to today and `probability` to the milestone default (100/0), preserving `lastOpenMilestone` as the previous open stage; moving back to an open milestone clears `closedOn` and re-applies the milestone's default probability (Won/Lost is reversible — no separate reopen tool). " +
        "WARNING: Capsule does NOT validate that the new milestone belongs to the opportunity's current pipeline. Passing a milestoneId from a different pipeline silently relocates the opportunity across pipelines, and `lastOpenMilestone` may then reference a milestone in the previous pipeline. Verify against the opportunity's current pipeline (read the opp first, list its pipeline's milestones via list_milestones) before passing a cross-pipeline id. " +
        "NOTE: changing `milestoneId` can fire **pipeline / milestone-reached automations** that mutate `owner` / `team` on the destination milestone (same shape as `create_opportunity` — see its `milestoneId` description for the asymmetric-write semantic that can clear `owner` as a side-effect). If a milestone-change-and-owner-set in the same call lands with `owner: null`, follow up with a second `update_opportunity` (or `batch_update_opportunity`) carrying both `ownerId` and `teamId` — milestone-reached triggers only fire on the transition, so a subsequent PUT preserves your values.",
    ),
  description: z.string().optional(),
  value: OpportunityValueSchema.optional(),
  expectedCloseOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  probability: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Win probability 0–100. On an open milestone this overrides the milestone's default probability. CANNOT be set in the same call as a closing milestone (Won/Lost) — Capsule processes the milestone change first, the opportunity becomes closed, then the probability update is rejected as edit-on-closed-opp with 422 'probability can be updated only for open opportunity'. To close an opportunity, leave probability out of the call: it auto-snaps to 100% (Won) or 0% (Lost).",
    ),
  lostReasonId: positiveId
    .optional()
    .describe(
      "Reason the opportunity was lost. Only meaningful when transitioning to a Lost milestone — Capsule silently drops it for other milestones. Without this set, a connector-driven Lost-close leaves `lostReason: null`. Discover IDs via list_lostreasons.",
    ),
  ownerId: positiveId
    .optional()
    .describe(
      "Reassign owner to user ID. Once set, this connector cannot clear an owner back to null — use Capsule's web UI for that. " +
        "When you supply `ownerId` and omit `teamId`, the connector fetches the opportunity's current team and includes it in the PUT body to preserve it across the owner change. Without this defensive read, Capsule's PUT would clear the existing team (see NOTES-ON-CAPSULE-API.md §27 — same asymmetric semantic as /kases). Supply `teamId` explicitly on the same call to change the team instead.",
    ),
  teamId: positiveId
    .nullable()
    .optional()
    .describe(
      "Reassign team: pass a team ID (discover via list_teams) to set, or `null` to unassign. " +
        "Capsule preserves the existing owner across a team change (server-side), so `update_opportunity { teamId }` alone is safe — the owner is carried through. " +
        "Owner must be a member of the new team or Capsule returns 422 'owner is not a member of the team'. " +
        "Independent from `ownerId` — setting `teamId` does NOT clear the owner.",
    ),
  fields: z
    .array(CustomFieldWriteSchema)
    .optional()
    .describe(fieldsArrayDescriptor("get_opportunity")),
});

export async function updateOpportunity(input: z.infer<typeof updateOpportunitySchema>) {
  const { id, milestoneId, ownerId, teamId, lostReasonId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (milestoneId) body["milestone"] = { id: milestoneId };

  // Capsule's PUT on /opportunities has the same asymmetric owner/team
  // semantic as /kases (see NOTES-ON-CAPSULE-API.md §27):
  //
  //   `owner` in body → Capsule clears `team` (unless `team` also in body)
  //   `team` in body  → Capsule preserves the existing `owner` (and
  //                     validates owner ∈ team)
  //
  // To make `update_opportunity { ownerId }` safe (so it doesn't
  // accidentally clear an existing team), the connector reads the
  // current opportunity and carries the omitted `team` into the PUT
  // body whenever `ownerId` is being touched. No extra GET when
  // `teamId` is also supplied explicitly.
  //
  // `null` on teamId means "unassign team" (matches Capsule's UI
  // "Unassign" option); `undefined` means "don't touch this field".
  let resolvedTeamId: number | null | undefined = teamId;
  if (ownerId !== undefined && teamId === undefined) {
    const { data } = await capsuleGet<{
      opportunity: { team?: { id: number } | null };
    }>(`/opportunities/${id}`);
    // Only carry forward when the opp actually has a team; if current
    // team is null, leave the field out entirely (sending team: null
    // would be a redundant clear).
    resolvedTeamId = data.opportunity?.team?.id ?? undefined;
  }

  if (ownerId) body["owner"] = { id: ownerId };
  if (resolvedTeamId === null) body["team"] = null;
  else if (resolvedTeamId !== undefined) body["team"] = { id: resolvedTeamId };
  // Capsule's body field is `lostReason: {id}`. Only meaningful when
  // closing to Lost; for other milestones Capsule drops it silently.
  if (lostReasonId) body["lostReason"] = { id: lostReasonId };
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ opportunity: unknown }>(`/opportunities/${id}`, {
    opportunity: body,
  });
}

// ── batch_update_opportunity (write, fan-out) ─────────────────────────────

export const batchUpdateOpportunitySchema = z.object({
  items: z
    .array(updateOpportunitySchema)
    .min(1)
    .max(50)
    .describe(
      "Array of 1–50 update_opportunity inputs. Each item is the same shape as a single update_opportunity call — id is required, every other field is optional. Capped at 50 so a single tool call can't burn an outsized share of Capsule's hourly per-token rate budget.",
    ),
});

export async function batchUpdateOpportunity(
  input: z.infer<typeof batchUpdateOpportunitySchema>,
  opts: BatchOpts = {},
) {
  return batchExecute(
    "batch_update_opportunity",
    input.items,
    (item) => updateOpportunity(item),
    opts,
  );
}

// ───────────────────────────────────────────────────────────────────────────

export const deleteOpportunitySchema = z.object({
  id: positiveId,
  confirm: confirmFlag().describe(
    "Must be set to true. Permanently deletes the opportunity. Irreversible.",
  ),
});

export async function deleteOpportunity(input: z.infer<typeof deleteOpportunitySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_opportunity requires confirm: true");
  }
  return idempotent(
    () => capsuleDelete(`/opportunities/${input.id}`),
    () => ({ deleted: true, alreadyDeleted: false, id: input.id }),
    () => ({ deleted: true, alreadyDeleted: true, id: input.id }),
  );
}
