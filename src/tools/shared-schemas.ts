/**
 * Shared Zod schemas reused across tool definitions.
 *
 * The reason these live in a tiny module instead of being repeated
 * inline: when the validation semantic needs to change (as it just
 * did when we discovered LLM-driven MCP clients sometimes ship
 * positive-integer IDs as JSON strings rather than JSON numbers),
 * we update one definition and every tool picks it up.
 */

import { z } from "zod";

/**
 * Schema for Capsule entity IDs (positive integers).
 *
 * Coerces decimal digit strings → number BEFORE validation so
 * callers that ship IDs as strings (LLM-driven clients sometimes
 * do, regardless of what the JSON Schema says) are accepted instead
 * of being rejected with `expected number, received string`.
 *
 * The coercion is deliberately narrow: only JSON numbers and strings
 * matching `/^\d+$/` after trimming are accepted. Generic
 * `z.coerce.number()` also accepts JavaScript oddities like `true`
 * and `[1]` as `1`, which is not acceptable for ID fields,
 * especially on destructive tools.
 *
 * Use for every field that represents a Capsule entity ID — party,
 * opportunity, project, task, milestone, owner (user), team, etc.
 *
 * Do NOT use for non-ID positive integers like `page`, `perPage`,
 * `probability`, monetary `amount`, or page-size caps. Strict
 * typing on those preserves the signal that a caller-side bug is
 * passing the wrong shape.
 */
export const positiveId = z.preprocess((input) => {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : input;
}, z.number().int().positive());

/**
 * The standard pagination pair for list/filter/search tools, with the
 * connector-side defaults applied (`page: 1`, `perPage: 25`). Spread
 * into the tool's `z.object({...})` shape:
 *
 *   z.object({ q: z.string(), ...paginationFields })
 *
 * One definition so Capsule's `perPage` ceiling (100) and our defaults
 * can't drift between tools, and so an LLM-facing description tweak
 * lands everywhere at once. Deliberately strict (no string coercion) —
 * see the positiveId note above for why page numbers stay strictly
 * typed.
 */
export const paginationFields = {
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
};

/**
 * Pagination pair WITHOUT connector-side defaults — for reference-data
 * tools whose handlers apply their own default (e.g. `perPage: 100` on
 * small dictionary endpoints) and for schemas where an omitted value
 * should reach the handler as `undefined` rather than `1`/`25`.
 */
export const paginationFieldsNoDefaults = {
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
};

/**
 * Caller-facing entity vocabulary → Capsule path component.
 *
 * From v2 the tool surface says `projects` everywhere; Capsule's API
 * still uses its legacy name `kases` in paths. This map is the single
 * place that translation lives for the entity-parameterized tools
 * (tags, custom fields, saved filters, tracks, additional parties).
 * Response keys are normalized the other way at the client boundary —
 * see src/capsule/normalize.ts.
 */
export const ENTITY_PATH = {
  parties: "parties",
  opportunities: "opportunities",
  projects: "kases",
} as const;

export type EntityName = keyof typeof ENTITY_PATH;

/**
 * Validated `embed` parameter. Capsule SILENTLY IGNORES unknown embed
 * tokens (probed live: `embed=bogus_xyz` returns 200 with the default
 * shape), so a typo'd embed used to "succeed" while returning less
 * data than the caller believed it asked for — the worst failure mode
 * for an LLM caller. Tokens are validated against the per-resource
 * allow-list; the wire format (comma-joined string) is unchanged.
 *
 * HISTORY / METHODOLOGY WARNING: the original v2.0.0 allow-list
 * (tags / fields / missingImportantFields everywhere) was derived from
 * a probe that diffed TOP-LEVEL row keys with vs without each embed —
 * blind to embeds that enrich a NESTED ref instead of adding a key.
 * Capsule's docs list ref-enriching embeds per resource, re-verified
 * live 2026-08-16 by diffing the nested object's key count (e.g.
 * `embed=party` on an opportunity: party ref 4 → 15 keys; `milestone`
 * 2 → 9; `creator` on entries 5 → 16). See issue #112.
 *
 * Vocabulary: callers say `project`; Capsule's wire token for the
 * project ref is its legacy `kase`. The translation happens at the
 * client boundary (buildUrl in capsule/client.ts) so it applies on
 * every call path — schema-parsed MCP calls and direct handler calls
 * alike — mirroring the kase→project response-key normalization.
 */
export function embedParam(allowed: readonly string[]) {
  return z
    .string()
    .superRefine((value, ctx) => {
      const tokens = value.split(",").map((t) => t.trim());
      for (const token of tokens) {
        if (token === "" || !allowed.includes(token)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown embed token '${token}'. Valid tokens: ${allowed.join(", ")} (comma-separated). Capsule silently ignores unknown tokens, so this is rejected client-side to prevent silently-missing data.`,
          });
        }
      }
    })
    .describe(`Comma-separated embeds. Valid tokens: ${allowed.join(", ")}.`)
    .optional();
}

/**
 * Per-resource embed allow-lists, from Capsule's operations docs and
 * re-verified live 2026-08-16 (nested-ref enrichment measured for every
 * ref token). `project` is the caller-facing name for Capsule's `kase`
 * token (transformed on the wire by `embedParam`).
 *
 * `attachments` / `participants` on entries predate the docs' current
 * five-token list; they are retained for continuity (Capsule tolerates
 * them, and entry rows carry `attachments` regardless).
 */
export const PARTY_EMBEDS = ["tags", "fields", "organisation", "missingImportantFields"] as const;
export const OPPORTUNITY_EMBEDS = [
  "tags",
  "fields",
  "party",
  "milestone",
  "missingImportantFields",
] as const;
export const PROJECT_EMBEDS = [
  "tags",
  "fields",
  "party",
  "opportunity",
  "missingImportantFields",
] as const;
export const ENTRY_EMBEDS = [
  "attachments",
  "participants",
  "party",
  "project",
  "opportunity",
  "creator",
  "activityType",
] as const;
export const TASK_EMBEDS = ["party", "opportunity", "project", "owner", "nextTask"] as const;

/**
 * Entity-keyed embed lists for tools whose target entity is a runtime
 * parameter (run_saved_filter) — cross-field validation happens in an
 * object-level superRefine there, since the valid tokens depend on the
 * `entity` value.
 */
export const EMBEDS_BY_ENTITY: Record<EntityName, readonly string[]> = {
  parties: PARTY_EMBEDS,
  opportunities: OPPORTUNITY_EMBEDS,
  projects: PROJECT_EMBEDS,
};
