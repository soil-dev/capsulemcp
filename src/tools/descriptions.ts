/**
 * Shared description constants for tool parameters that are repeated
 * verbatim (or near-verbatim) across many tools.
 *
 * Kept here so that updates to caller-facing text — the kind of polish
 * we make when an LLM caller surfaces a misunderstanding — land in one
 * place instead of fanning out across a dozen schemas.
 *
 * Adding to this file is a judgement call: extract only when the same
 * string appears in ≥3 sites AND a future update would want to track
 * across all of them. Per-tool descriptions with domain-specific
 * meaning (e.g. mutex notes on `create_task`) stay inline.
 */
