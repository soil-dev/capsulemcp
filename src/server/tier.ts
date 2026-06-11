/**
 * Tool-catalog tiering (`CAPSULE_MCP_TIER`).
 *
 * The full 88-tool catalog serializes to ~155 KB of `tools/list` JSON —
 * the single biggest non-conversational token cost an MCP client pays
 * per session (roughly 35–40k tokens for clients that inject the
 * catalog into context). Most conversations touch a small core:
 * search/filter/get/create/update across the four resources, notes,
 * and tags.
 *
 * `CAPSULE_MCP_TIER=core` registers only that curated core (~25 tools,
 * picked from production `tool.call` analytics — see OPTIMIZATIONS.md).
 * Any other value (or unset) keeps the full catalog, so existing
 * deployments are unaffected.
 *
 * Tiering composes orthogonally with `CAPSULE_MCP_READONLY`: the
 * read-only gate decides whether write tools register at all; the tier
 * filters within whichever set survives that gate.
 */

const CORE_TOOLS: ReadonlySet<string> = new Set([
  // Parties
  "search_parties",
  "filter_parties",
  "get_party",
  "create_party",
  "update_party",
  "list_party_entries",
  // Opportunities
  "search_opportunities",
  "filter_opportunities",
  "get_opportunity",
  "create_opportunity",
  "update_opportunity",
  // Projects
  "search_projects",
  "filter_projects",
  "list_projects",
  "get_project",
  "create_project",
  "update_project",
  // Tasks
  "list_tasks",
  "get_task",
  "create_task",
  "update_task",
  "complete_task",
  // Timeline + tags + identity
  "add_note",
  "list_tags",
  "add_tag",
  "get_current_user",
]);

/**
 * True when a tool with this name should be registered under the
 * configured tier. Read at call time (registration happens once per
 * server construction) so tests can flip the env between spawns.
 */
export function shouldRegister(name: string): boolean {
  if (process.env["CAPSULE_MCP_TIER"] !== "core") return true;
  return CORE_TOOLS.has(name);
}
