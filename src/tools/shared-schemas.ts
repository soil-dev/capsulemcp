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
