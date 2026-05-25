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
 * Coerces string → number BEFORE validation so callers that ship
 * IDs as strings (LLM-driven clients sometimes do, regardless of
 * what the JSON Schema says) are accepted instead of being rejected
 * with `expected number, received string`. The coercion is safe:
 * `Number("123")` → 123 (passes `.int().positive()`),
 * `Number("abc")` → NaN (fails `.int()`), so garbage still reports
 * a clean validation error.
 *
 * Use for every field that represents a Capsule entity ID — party,
 * opportunity, project, task, milestone, owner (user), team, etc.
 *
 * Do NOT use for non-ID positive integers like `page`, `perPage`,
 * `probability`, monetary `amount`, or page-size caps. Strict
 * typing on those preserves the signal that a caller-side bug is
 * passing the wrong shape.
 */
export const positiveId = z.coerce.number().int().positive();
