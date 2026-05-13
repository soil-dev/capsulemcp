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

/**
 * `embed` parameter description for tools whose embed surface is
 * dominated by `tags` and `fields`. Used on parties, opportunities,
 * projects, audit, filters, saved-filters, relationships.
 */
export const EMBED_TAGS_FIELDS_DESCRIPTION = "Comma-separated embeds, e.g. 'tags,fields'";

/**
 * `embed` parameter description for the entries surface, where the
 * useful embeds are `attachments` and `participants`. Used on
 * `list_*_entries`, `get_entry`, and the global `list_entries`.
 */
export const EMBED_ATTACHMENTS_PARTICIPANTS_DESCRIPTION =
  "Comma-separated embeds, e.g. 'attachments,participants'";
