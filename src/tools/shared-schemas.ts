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
