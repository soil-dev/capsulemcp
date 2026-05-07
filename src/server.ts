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
  addNoteSchema, addNote,
  deleteEntrySchema, deleteEntry,
} from "./tools/entries.js";
import { listPipelinesSchema, listPipelines, listMilestonesSchema, listMilestones } from "./tools/pipelines.js";
import { listTagsSchema, listTags } from "./tools/tags.js";
import { listUsersSchema, listUsers } from "./tools/users.js";
import {
  filterPartiesSchema, filterParties,
  filterOpportunitiesSchema, filterOpportunities,
  filterProjectsSchema, filterProjects,
} from "./tools/filters.js";

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
    version: "0.3.4",
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
    "List all milestones (stages) within a specific pipeline.",
    listMilestonesSchema.shape,
    async (input) => {
      const result = await listMilestones(input);
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
