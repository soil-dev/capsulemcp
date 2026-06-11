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
 * for an LLM caller. From v2 the tokens are validated against the
 * per-surface allow-list; the wire format (comma-joined string) is
 * unchanged.
 *
 * Allow-lists verified empirically (2026-06-11, live tenant):
 * `tags` / `fields` / `missingImportantFields` are honored on parties,
 * opportunities, and projects; every other candidate (organisation,
 * party, milestone, …) is silently ignored. The entries surface
 * documents `attachments` / `participants`.
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

/** `embed` for the record surfaces (parties / opportunities / projects / filters / audit). */
export const RECORD_EMBEDS = ["tags", "fields", "missingImportantFields"] as const;

/** `embed` for the entries surface. */
export const ENTRY_EMBEDS = ["attachments", "participants"] as const;
