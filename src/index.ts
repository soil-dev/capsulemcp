import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  searchPartiesSchema, searchParties,
  getPartySchema, getParty,
  listPartyOpportunitiesSchema, listPartyOpportunities,
  listPartyProjectsSchema, listPartyProjects,
  createPartySchema, createParty,
  updatePartySchema, updateParty,
} from "./tools/parties.js";

import {
  searchOpportunitiesSchema, searchOpportunities,
  getOpportunitySchema, getOpportunity,
  createOpportunitySchema, createOpportunity,
  updateOpportunitySchema, updateOpportunity,
} from "./tools/opportunities.js";

import {
  listProjectsSchema, listProjects,
  getProjectSchema, getProject,
  createProjectSchema, createProject,
} from "./tools/projects.js";

import {
  listTasksSchema, listTasks,
  createTaskSchema, createTask,
  completeTaskSchema, completeTask,
} from "./tools/tasks.js";

import { addNoteSchema, addNote } from "./tools/entries.js";
import { listPipelinesSchema, listPipelines, listMilestonesSchema, listMilestones } from "./tools/pipelines.js";
import { listTagsSchema, listTags } from "./tools/tags.js";
import { listUsersSchema, listUsers } from "./tools/users.js";

const server = new McpServer({
  name: "capsule-mcp",
  version: "0.1.0",
});

// ── Parties ─────────────────────────────────────────────────────────────────

server.tool(
  "search_parties",
  "Search or list people and organisations in Capsule CRM. Returns a page of matching parties and an optional nextPage cursor.",
  searchPartiesSchema.shape,
  async (input) => {
    const result = await searchParties(input);
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

// ── Opportunities ───────────────────────────────────────────────────────────

server.tool(
  "search_opportunities",
  "Search or list opportunities in Capsule CRM.",
  searchOpportunitiesSchema.shape,
  async (input) => {
    const result = await searchOpportunities(input);
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

// ── Projects ─────────────────────────────────────────────────────────────────

server.tool(
  "list_projects",
  "List projects (cases) in Capsule CRM, optionally filtered by status.",
  listProjectsSchema.shape,
  async (input) => {
    const result = await listProjects(input);
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
  "create_project",
  "Create a new project (case) in Capsule CRM linked to a party.",
  createProjectSchema.shape,
  async (input) => {
    const result = await createProject(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tasks ────────────────────────────────────────────────────────────────────

server.tool(
  "list_tasks",
  "List tasks in Capsule CRM, optionally filtered by status, assigned user, or due date.",
  listTasksSchema.shape,
  async (input) => {
    const result = await listTasks(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

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
  "complete_task",
  "Mark a task as completed.",
  completeTaskSchema.shape,
  async (input) => {
    const result = await completeTask(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Entries ──────────────────────────────────────────────────────────────────

server.tool(
  "add_note",
  "Add a note to a party, opportunity, or project. Provide exactly one of partyId, opportunityId, or projectId.",
  addNoteSchema.shape,
  async (input) => {
    const result = await addNote(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Pipelines & milestones ───────────────────────────────────────────────────

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

// ── Tags ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_tags",
  "List all tags available for a given entity type (parties, opportunities, or kases).",
  listTagsSchema.shape,
  async (input) => {
    const result = await listTags(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Users ────────────────────────────────────────────────────────────────────

server.tool(
  "list_users",
  "List all users in the Capsule account.",
  listUsersSchema.shape,
  async (input) => {
    const result = await listUsers(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // Write to stderr — stdout is reserved for MCP protocol traffic.
  console.error(`[capsule-mcp] Failed to start: ${message}`);
  process.exit(1);
}
