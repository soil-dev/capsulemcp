/**
 * Shared `confirm: true` literal for destructive write tools.
 *
 * Capsule's connector gates 8 destructive/removal tools behind an explicit
 * `confirm: true` flag (delete_party / _opportunity / _project / _task
 * / _entry / _tag_definition, plus remove_track and
 * remove_additional_party). Zod's
 * default error on a missing or `false` value of a `z.literal(true)`
 * reads `"Invalid input: expected true"` — technically correct but
 * unhelpful at a callsite, especially for an LLM caller trying to
 * self-correct (the wording sounds like "you passed false" even when
 * the field was simply missing).
 *
 * `confirmFlag()` overrides the message uniformly: any rejection
 * surfaces a single operator-readable sentence stating the contract
 * and what to do about it. The per-tool `.describe(...)` text is
 * still added at the callsite so each tool can spell out its own
 * irreversibility / cascade story.
 */

import { z } from "zod";

const CONFIRM_REQUIRED_MESSAGE =
  "confirm: true is required to perform this destructive operation (set the parameter explicitly to acknowledge the destructive intent)";

export function confirmFlag(): z.ZodLiteral<true> {
  return z.literal(true, { error: () => CONFIRM_REQUIRED_MESSAGE });
}
