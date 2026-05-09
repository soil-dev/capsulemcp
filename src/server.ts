import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isReadOnly } from "./capsule/client.js";
import { ICONS } from "./icon.js";

import {
  searchPartiesSchema, searchParties,
  getPartySchema, getParty,
  listPartyOpportunitiesSchema, listPartyOpportunities,
  listPartyProjectsSchema, listPartyProjects,
  createPartySchema, createParty,
  updatePartySchema, updateParty,
  deletePartySchema, deleteParty,
} from "./tools/parties.js";

import {
  searchOpportunitiesSchema, searchOpportunities,
  getOpportunitySchema, getOpportunity,
  createOpportunitySchema, createOpportunity,
  updateOpportunitySchema, updateOpportunity,
  deleteOpportunitySchema, deleteOpportunity,
} from "./tools/opportunities.js";

import {
  listProjectsSchema, listProjects,
  getProjectSchema, getProject,
  createProjectSchema, createProject,
  updateProjectSchema, updateProject,
  deleteProjectSchema, deleteProject,
} from "./tools/projects.js";

import {
  listTasksSchema, listTasks,
  createTaskSchema, createTask,
  updateTaskSchema, updateTask,
  completeTaskSchema, completeTask,
  deleteTaskSchema, deleteTask,
} from "./tools/tasks.js";

import {
  listPartyEntriesSchema, listPartyEntries,
  listOpportunityEntriesSchema, listOpportunityEntries,
  listProjectEntriesSchema, listProjectEntries,
  getEntrySchema, getEntry,
  listEntriesSchema, listEntries,
  addNoteSchema, addNote,
  updateEntrySchema, updateEntry,
  deleteEntrySchema, deleteEntry,
} from "./tools/entries.js";
import { listPipelinesSchema, listPipelines, listMilestonesSchema, listMilestones } from "./tools/pipelines.js";
import { listBoardsSchema, listBoards, listStagesSchema, listStages } from "./tools/boards.js";
import { listTagsSchema, listTags } from "./tools/tags.js";
import { listUsersSchema, listUsers } from "./tools/users.js";
import {
  filterPartiesSchema, filterParties,
  filterOpportunitiesSchema, filterOpportunities,
  filterProjectsSchema, filterProjects,
} from "./tools/filters.js";
import {
  listTeamsSchema, listTeams,
  listLostReasonsSchema, listLostReasons,
  listActivityTypesSchema, listActivityTypes,
  getSiteSchema, getSite,
  listTrackDefinitionsSchema, listTrackDefinitions,
  listCategoriesSchema, listCategories,
  listGoalsSchema, listGoals,
} from "./tools/metadata.js";
import {
  listEmployeesSchema, listEmployees,
  listDeletedPartiesSchema, listDeletedParties,
  listDeletedOpportunitiesSchema, listDeletedOpportunities,
  listDeletedProjectsSchema, listDeletedProjects,
} from "./tools/audit.js";
import {
  listAdditionalPartiesSchema, listAdditionalParties,
  addAdditionalPartySchema, addAdditionalParty,
  removeAdditionalPartySchema, removeAdditionalParty,
  listAssociatedProjectsSchema, listAssociatedProjects,
} from "./tools/relationships.js";
import {
  listCustomFieldsSchema, listCustomFields,
  getCustomFieldSchema, getCustomField,
} from "./tools/custom-fields.js";
import {
  listEntityTracksSchema, listEntityTracks,
  showTrackSchema, showTrack,
  applyTrackSchema, applyTrack,
  updateTrackSchema, updateTrack,
  removeTrackSchema, removeTrack,
} from "./tools/tracks.js";
import {
  listSavedFiltersSchema, listSavedFilters,
  runSavedFilterSchema, runSavedFilter,
} from "./tools/saved-filters.js";

/**
 * Build a fully-configured MCP server with all Capsule tools registered.
 *
 * Read-only mode is determined at call time (via CAPSULE_MCP_READONLY) so
 * that callers in long-lived processes — like the HTTP transport which
 * may construct one server per request — see fresh env state.
 *
 * Returns the server uninitialised; the caller is responsible for
 * connecting it to a transport.
 */
export function createCapsuleMcpServer(): McpServer {
  const readOnly = isReadOnly();
  const server = new McpServer({
    name: "capsulemcp",
    version: "0.5.1",
    description: "Read and (optionally) modify Capsule CRM data — parties, opportunities, projects, tasks, timeline entries, pipelines, tags.",
    websiteUrl: "https://github.com/arapov/capsulemcp",
    icons: ICONS,
  });

  // ── Parties ───────────────────────────────────────────────────────────────

  server.tool(
    "search_parties",
    "Free-text search or list people and organisations in Capsule CRM. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent', 'tagged X', 'added this month' — use filter_parties instead.",
    searchPartiesSchema.shape,
    async (input) => {
      const result = await searchParties(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "filter_parties",
    "Filter parties by structured conditions (date ranges, tags, fields). Use this — not search_parties — for questions like 'most recent client', 'parties added this week', 'parties tagged VIP'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field (e.g. {field: 'addedOn', operator: 'is within last', value: 30}) and pick the highest-id row from the result — Capsule IDs are monotonic, so newest id = newest record.",
    filterPartiesSchema.shape,
    async (input) => {
      const result = await filterParties(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_party",
    "Fetch a single party (person or organisation) by its numeric ID.",
    getPartySchema.shape,
    async (input) => {
      const result = await getParty(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_party_opportunities",
    "List all opportunities linked to a given party.",
    listPartyOpportunitiesSchema.shape,
    async (input) => {
      const result = await listPartyOpportunities(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_party_projects",
    "List all projects (cases) linked to a given party.",
    listPartyProjectsSchema.shape,
    async (input) => {
      const result = await listPartyProjects(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_employees",
    "List the people who work at a given organisation party. Returns the parties whose `organisation` field references the given partyId. Use this to answer 'who works at X?' rather than enumerating all parties.",
    listEmployeesSchema.shape,
    async (input) => {
      const result = await listEmployees(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_custom_fields",
    "List custom field DEFINITIONS for an entity type (parties, opportunities, or projects/kases). Returns the schema — name, type, options for list-type fields, etc. — NOT the values on any specific record. To read values on a record, use get_party / get_opportunity / get_project with embed=fields.",
    listCustomFieldsSchema.shape,
    async (input) => {
      const result = await listCustomFields(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_custom_field",
    "Show a single custom field DEFINITION by id. Use list_custom_fields first to discover field ids.",
    getCustomFieldSchema.shape,
    async (input) => {
      const result = await getCustomField(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_deleted_parties",
    "Audit feature: list parties deleted on or after a given timestamp. The `since` parameter is REQUIRED (Capsule rejects the call without it). Response also includes a `restrictedParties` key — records the integration user can see were deleted but cannot read fully.",
    listDeletedPartiesSchema.shape,
    async (input) => {
      const result = await listDeletedParties(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  if (!readOnly) {
    server.tool(
      "create_party",
      "Create a new person or organisation in Capsule CRM.",
      createPartySchema.shape,
      async (input) => {
        const result = await createParty(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_party",
      "Update fields on an existing party. Only the fields you provide are changed.",
      updatePartySchema.shape,
      async (input) => {
        const result = await updateParty(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "delete_party",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a party (person or organisation). This also removes all linked notes, tasks, and opportunities. Requires confirm=true. Always read the party first with get_party and confirm with the user before calling.",
      deletePartySchema.shape,
      async (input) => {
        const result = await deleteParty(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  server.tool(
    "search_opportunities",
    "Free-text search or list opportunities in Capsule CRM. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent', 'won this quarter', 'in pipeline X at milestone Y' — use filter_opportunities instead.",
    searchOpportunitiesSchema.shape,
    async (input) => {
      const result = await searchOpportunities(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "filter_opportunities",
    "Filter opportunities by structured conditions (milestone, value, close date, tags). Use this — not search_opportunities — for questions like 'last won deal', 'opportunities closed this month', 'pipeline X at milestone Y'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field (e.g. {field: 'closedOn', operator: 'is within last', value: 90}) and pick the highest-id row — Capsule IDs are monotonic, so newest id = newest record.",
    filterOpportunitiesSchema.shape,
    async (input) => {
      const result = await filterOpportunities(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_opportunity",
    "Fetch a single opportunity by its numeric ID.",
    getOpportunitySchema.shape,
    async (input) => {
      const result = await getOpportunity(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_deleted_opportunities",
    "Audit feature: list opportunities deleted on or after a given timestamp. The `since` parameter is REQUIRED. Response also includes a `restrictedOpportunities` key for records the integration user can't read fully.",
    listDeletedOpportunitiesSchema.shape,
    async (input) => {
      const result = await listDeletedOpportunities(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_additional_parties",
    "List secondary party links on an opportunity or project. The 'main' party is on the entity itself (opportunity.party); additional parties are e.g. partners, consultants, or referrers also involved in the deal. Set entity to 'opportunities' or 'kases' (Capsule's term for projects).",
    listAdditionalPartiesSchema.shape,
    async (input) => {
      const result = await listAdditionalParties(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_associated_projects",
    "List projects (cases) associated with a given opportunity. The inverse direction (project → opportunity) is on each project's `opportunity` field directly.",
    listAssociatedProjectsSchema.shape,
    async (input) => {
      const result = await listAssociatedProjects(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  if (!readOnly) {
    server.tool(
      "create_opportunity",
      "Create a new opportunity linked to a party and a pipeline milestone.",
      createOpportunitySchema.shape,
      async (input) => {
        const result = await createOpportunity(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_opportunity",
      "Update fields on an existing opportunity. Only the fields you provide are changed.",
      updateOpportunitySchema.shape,
      async (input) => {
        const result = await updateOpportunity(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "delete_opportunity",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete an opportunity. Requires confirm=true. Always read the opportunity first with get_opportunity and confirm with the user before calling.",
      deleteOpportunitySchema.shape,
      async (input) => {
        const result = await deleteOpportunity(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  server.tool(
    "list_projects",
    "List projects (cases) in Capsule CRM, optionally filtered by status. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent project', 'projects opened this month', 'projects tagged X' — use filter_projects instead.",
    listProjectsSchema.shape,
    async (input) => {
      const result = await listProjects(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "filter_projects",
    "Filter projects (cases) by structured conditions (date ranges, status, tags, owner). Use this — not list_projects — for questions like 'most recent project', 'projects opened this month'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field and pick the highest-id row — Capsule IDs are monotonic, so newest id = newest record.",
    filterProjectsSchema.shape,
    async (input) => {
      const result = await filterProjects(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_project",
    "Fetch a single project (case) by its numeric ID.",
    getProjectSchema.shape,
    async (input) => {
      const result = await getProject(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_deleted_projects",
    "Audit feature: list projects deleted on or after a given timestamp. The `since` parameter is REQUIRED. Response also includes a `restrictedKases` key for records the integration user can't read fully.",
    listDeletedProjectsSchema.shape,
    async (input) => {
      const result = await listDeletedProjects(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  if (!readOnly) {
    server.tool(
      "create_project",
      "Create a new project (case) in Capsule CRM linked to a party.",
      createProjectSchema.shape,
      async (input) => {
        const result = await createProject(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_project",
      "Update fields on an existing project. Only the fields you provide are changed. Use status='CLOSED' to close a project.",
      updateProjectSchema.shape,
      async (input) => {
        const result = await updateProject(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "delete_project",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a project (case). Prefer update_project with status='CLOSED' to close a project while preserving history. Requires confirm=true. Always read the project first with get_project and confirm with the user before calling.",
      deleteProjectSchema.shape,
      async (input) => {
        const result = await deleteProject(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // ── Relationships (writes) ──────────────────────────────────────────────

    server.tool(
      "add_additional_party",
      "Link an existing party as an additional (secondary) party on an opportunity or project. The 'main' party is set via update_opportunity / update_project; this adds *additional* parties beyond the main one. Idempotent — re-adding a linked party is harmless.",
      addAdditionalPartySchema.shape,
      async (input) => {
        const result = await addAdditionalParty(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "remove_additional_party",
      "Remove an additional-party link between an opportunity/project and a party. The party itself is NOT deleted. Requires confirm=true. Reversible by re-adding via add_additional_party.",
      removeAdditionalPartySchema.shape,
      async (input) => {
        const result = await removeAdditionalParty(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // ── Tracks (writes) ─────────────────────────────────────────────────────

    server.tool(
      "apply_track",
      "Apply a track definition to an opportunity or project. This creates a track instance and auto-creates tasks per the track's task definitions. Use list_track_definitions to discover available templates.",
      applyTrackSchema.shape,
      async (input) => {
        const result = await applyTrack(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_track",
      "Update a track instance. Capsule's PUT semantics are partial — provide only the fields you want to change in `fields`. Common: { complete: true } to mark a track completed.",
      updateTrackSchema.shape,
      async (input) => {
        const result = await updateTrack(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "remove_track",
      "Remove a track instance from its entity. Tasks already created by the track stay on the entity and must be deleted separately if desired. Requires confirm=true.",
      removeTrackSchema.shape,
      async (input) => {
        const result = await removeTrack(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_tasks",
    "List tasks in Capsule CRM, optionally filtered by status, assigned user, or due date.",
    listTasksSchema.shape,
    async (input) => {
      const result = await listTasks(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  if (!readOnly) {
    server.tool(
      "create_task",
      "Create a new task, optionally linked to a party, opportunity, or project.",
      createTaskSchema.shape,
      async (input) => {
        const result = await createTask(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_task",
      "Update fields on an existing task. Only the fields you provide are changed. To mark a task done prefer complete_task.",
      updateTaskSchema.shape,
      async (input) => {
        const result = await updateTask(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "complete_task",
      "Mark a task as completed.",
      completeTaskSchema.shape,
      async (input) => {
        const result = await completeTask(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "delete_task",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a task. Prefer complete_task to mark a task done while keeping it in history. Requires confirm=true.",
      deleteTaskSchema.shape,
      async (input) => {
        const result = await deleteTask(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Entries (notes, captured emails, completed-task records) ──────────────

  server.tool(
    "list_party_entries",
    "List timeline entries (notes, captured emails, completed-task records) for a party. Use this to read the conversation history with a contact or organisation.",
    listPartyEntriesSchema.shape,
    async (input) => {
      const result = await listPartyEntries(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_opportunity_entries",
    "List timeline entries (notes, captured emails, completed-task records) for an opportunity.",
    listOpportunityEntriesSchema.shape,
    async (input) => {
      const result = await listOpportunityEntries(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_project_entries",
    "List timeline entries (notes, captured emails, completed-task records) for a project (case).",
    listProjectEntriesSchema.shape,
    async (input) => {
      const result = await listProjectEntries(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_entry",
    "Fetch a single timeline entry by its numeric ID. Returns full content (note body, email subject + body, etc.).",
    getEntrySchema.shape,
    async (input) => {
      const result = await getEntry(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_entries",
    "Global timeline feed: every note, captured email, and completed-task record across the whole Capsule account, paginated. Default order is most-recent-first. Use this for 'what activity happened today/this week across the company?' rather than iterating list_party_entries / list_opportunity_entries / list_project_entries.",
    listEntriesSchema.shape,
    async (input) => {
      const result = await listEntries(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  if (!readOnly) {
    server.tool(
      "add_note",
      "Add a note to a party, opportunity, or project. Provide exactly one of partyId, opportunityId, or projectId.",
      addNoteSchema.shape,
      async (input) => {
        const result = await addNote(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "update_entry",
      "Edit an existing timeline entry — typically a note. Provide the entry id plus the fields you want to change (content, subject). Only the fields you supply are modified; other fields keep their current values. Cannot change the entry's type. Use this to correct or extend a note added previously.",
      updateEntrySchema.shape,
      async (input) => {
        const result = await updateEntry(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      "delete_entry",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a note (or other entry) by its ID. Requires confirm=true.",
      deleteEntrySchema.shape,
      async (input) => {
        const result = await deleteEntry(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Pipelines & milestones ────────────────────────────────────────────────

  server.tool(
    "list_pipelines",
    "List all sales pipelines defined in Capsule CRM.",
    listPipelinesSchema.shape,
    async (input) => {
      const result = await listPipelines(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_milestones",
    "List all milestones (stages) within a specific opportunity pipeline.",
    listMilestonesSchema.shape,
    async (input) => {
      const result = await listMilestones(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Boards & stages (project workflow metadata) ───────────────────────────
  //
  // Boards/stages are to projects what pipelines/milestones are to
  // opportunities. A project sits at one stage at a time on one board.

  server.tool(
    "list_boards",
    "List all project (kase) boards defined in Capsule. A board is a grouping of stages that projects flow through — the project equivalent of an opportunity pipeline.",
    listBoardsSchema.shape,
    async (input) => {
      const result = await listBoards(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_stages",
    "List project stages. Without arguments returns every stage across every board (each carries a .board reference). Pass boardId to scope to one specific board.",
    listStagesSchema.shape,
    async (input) => {
      const result = await listStages(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Reference metadata (teams, lost reasons, activity types) ──────────────

  server.tool(
    "list_teams",
    "List all teams configured in the Capsule account. Useful as input for filter_* queries that scope by team, and for reporting.",
    listTeamsSchema.shape,
    async (input) => {
      const result = await listTeams(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_lostreasons",
    "List all configured opportunity-loss reasons (e.g. 'Poor Qualification', 'Lost to competitor'). Useful for analysing closed-lost opportunities by reason.",
    listLostReasonsSchema.shape,
    async (input) => {
      const result = await listLostReasons(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_activitytypes",
    "List all configured activity types (e.g. Call, Meeting, Email). These are the categories used when logging timeline entries.",
    listActivityTypesSchema.shape,
    async (input) => {
      const result = await listActivityTypes(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_categories",
    "List configured entry/task categories (Call, Email, Meeting, Follow-up, etc.) with their colours. Used to label and filter timeline entries and tasks.",
    listCategoriesSchema.shape,
    async (input) => {
      const result = await listCategories(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_track_definitions",
    "List workflow track definitions: reusable templates that auto-create tasks at configured intervals when applied to an opportunity or project. Each track includes nested taskDefinitions specifying what to create and when. Use this to understand what automations exist.",
    listTrackDefinitionsSchema.shape,
    async (input) => {
      const result = await listTrackDefinitions(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_entity_tracks",
    "List track INSTANCES on a specific record — i.e., which tracks have been applied to this opportunity / project / party. Distinct from list_track_definitions, which lists the templates.",
    listEntityTracksSchema.shape,
    async (input) => {
      const result = await listEntityTracks(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "show_track",
    "Fetch a single track instance by id. Returns the track's link to its trackDefinition, the entity it's applied to, dates, and completion status.",
    showTrackSchema.shape,
    async (input) => {
      const result = await showTrack(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "list_goals",
    "List sales / activity goals configured in the account (per-user or per-team revenue or activity targets). Returns an empty list for accounts that don't use the Goals feature.",
    listGoalsSchema.shape,
    async (input) => {
      const result = await listGoals(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_site",
    "Return the Capsule account this connector is currently authenticated against (subdomain, display name, URL). Diagnostic — Capsule v2 has no /users/me endpoint, so this is the closest 'where am I?' check.",
    getSiteSchema.shape,
    async (input) => {
      const result = await getSite(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Saved filters (UI-defined filters; support sort, unlike ad-hoc) ───────

  server.tool(
    "list_saved_filters",
    "List all filters that users have saved in Capsule's web UI for an entity type. Saved filters are reusable — they bundle conditions, columns, and (importantly) sort. Use this to discover what queries are already configured before building a one-off filter_* call.",
    listSavedFiltersSchema.shape,
    async (input) => {
      const result = await listSavedFilters(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "run_saved_filter",
    "Run a saved filter by id and return its results, paginated. Unlike filter_parties / filter_opportunities / filter_projects (which use the ad-hoc filter endpoint and CANNOT sort), saved filters DO support sort — the orderBy is configured in Capsule's web UI when the filter is created. So 'most recent X by Y' questions are answerable in one call IF a saved filter exists; use list_saved_filters first to find one.",
    runSavedFilterSchema.shape,
    async (input) => {
      const result = await runSavedFilter(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Tags ──────────────────────────────────────────────────────────────────

  server.tool(
    "list_tags",
    "List all tags available for a given entity type (parties, opportunities, or kases).",
    listTagsSchema.shape,
    async (input) => {
      const result = await listTags(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Users ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_users",
    "List all users in the Capsule account.",
    listUsersSchema.shape,
    async (input) => {
      const result = await listUsers(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
