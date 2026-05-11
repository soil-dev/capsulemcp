import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isReadOnly } from "./capsule/client.js";
import { ICONS } from "./icon.js";
import { registerTool } from "./server/register-tool.js";

import {
  searchPartiesSchema, searchParties,
  getPartySchema, getParty,
  getPartiesSchema, getParties,
  listPartyOpportunitiesSchema, listPartyOpportunities,
  listPartyProjectsSchema, listPartyProjects,
  createPartySchema, createParty,
  updatePartySchema, updateParty,
  deletePartySchema, deleteParty,
  addPartyEmailAddressSchema, addPartyEmailAddress,
  removePartyEmailAddressByIdSchema, removePartyEmailAddressById,
  addPartyPhoneNumberSchema, addPartyPhoneNumber,
  removePartyPhoneNumberByIdSchema, removePartyPhoneNumberById,
  addPartyAddressSchema, addPartyAddress,
  removePartyAddressByIdSchema, removePartyAddressById,
  addPartyWebsiteSchema, addPartyWebsite,
  removePartyWebsiteByIdSchema, removePartyWebsiteById,
} from "./tools/parties.js";

import {
  searchOpportunitiesSchema, searchOpportunities,
  getOpportunitySchema, getOpportunity,
  getOpportunitiesSchema, getOpportunities,
  createOpportunitySchema, createOpportunity,
  updateOpportunitySchema, updateOpportunity,
  deleteOpportunitySchema, deleteOpportunity,
} from "./tools/opportunities.js";

import {
  listProjectsSchema, listProjects,
  getProjectSchema, getProject,
  getProjectsSchema, getProjects,
  createProjectSchema, createProject,
  updateProjectSchema, updateProject,
  deleteProjectSchema, deleteProject,
} from "./tools/projects.js";

import {
  listTasksSchema, listTasks,
  getTaskSchema, getTask,
  getTasksSchema, getTasks,
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
import {
  listTagsSchema, listTags,
  addTagSchema, addTag,
  removeTagByIdSchema, removeTagById,
} from "./tools/tags.js";
import {
  listUsersSchema, listUsers,
  getCurrentUserSchema, getCurrentUser,
} from "./tools/users.js";
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
  getAttachmentSchema, getAttachment,
  uploadAttachmentSchema, uploadAttachment,
} from "./tools/attachments.js";
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
 *
 * Tool registrations use the `registerTool` helper from
 * src/server/register-tool.ts to keep each registration on a single
 * line — collapses the ~8-line `server.tool(...)` boilerplate that
 * grew through the alpha series, and incidentally eliminates the
 * "Edit collapses two adjacent string lines" footgun by putting the
 * name and description on the same call. The one exception is
 * `get_attachment` (further down): its handler does content-type-aware
 * response shaping and stays as a raw `server.tool(...)` call.
 */
export function createCapsuleMcpServer(): McpServer {
  const readOnly = isReadOnly();
  const server = new McpServer({
    name: "capsulemcp",
    version: "1.0.0-alpha.13",
    description: "Read and (optionally) modify Capsule CRM data — parties, opportunities, projects, tasks, timeline entries, pipelines, tags.",
    websiteUrl: "https://github.com/soil-dev/capsulemcp",
    icons: ICONS,
  });

  // ── Parties ───────────────────────────────────────────────────────────────

  registerTool(server, "search_parties",
    "Free-text search or list people and organisations in Capsule CRM. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent', 'tagged X', 'added this month' — use filter_parties instead.",
    searchPartiesSchema, searchParties);

  registerTool(server, "filter_parties",
    "Filter parties by structured conditions (date ranges, tags, fields). Use this — not search_parties — for questions like 'most recent client', 'parties added this week', 'parties tagged VIP'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field (e.g. {field: 'addedOn', operator: 'is within last', value: 30}) and pick the highest-id row from the result — Capsule IDs are monotonic, so newest id = newest record.",
    filterPartiesSchema, filterParties);

  registerTool(server, "get_party",
    "Fetch a single party (person or organisation) by its numeric ID.",
    getPartySchema, getParty);

  registerTool(server, "get_parties",
    "Batch-fetch up to 10 parties by ID in a single call. Use this when Claude already knows several party IDs to avoid N round trips of get_party.",
    getPartiesSchema, getParties);

  registerTool(server, "list_party_opportunities",
    "List all opportunities linked to a given party.",
    listPartyOpportunitiesSchema, listPartyOpportunities);

  registerTool(server, "list_party_projects",
    "List all projects (cases) linked to a given party.",
    listPartyProjectsSchema, listPartyProjects);

  registerTool(server, "list_employees",
    "List the people who work at a given organisation party. Returns the parties whose `organisation` field references the given partyId. Use this to answer 'who works at X?' rather than enumerating all parties.",
    listEmployeesSchema, listEmployees);

  registerTool(server, "list_custom_fields",
    "List custom field DEFINITIONS for an entity type (parties, opportunities, or projects/kases). Returns the schema — name, type, options for list-type fields, etc. — NOT the values on any specific record. To read values on a record, use get_party / get_opportunity / get_project with embed=fields.",
    listCustomFieldsSchema, listCustomFields);

  registerTool(server, "get_custom_field",
    "Show a single custom field DEFINITION by id. Use list_custom_fields first to discover field ids.",
    getCustomFieldSchema, getCustomField);

  registerTool(server, "list_deleted_parties",
    "Audit feature: list parties deleted on or after a given timestamp. The `since` parameter is REQUIRED (Capsule rejects the call without it). Response also includes a `restrictedParties` key — records the integration user can see were deleted but cannot read fully.",
    listDeletedPartiesSchema, listDeletedParties);

  if (!readOnly) {
    registerTool(server, "create_party",
      "Create a new person or organisation in Capsule CRM. For type='person', firstName or lastName is required (one suffices); the `name` field is silently ignored. For type='organisation', `name` is required and firstName/lastName/title/jobTitle are silently ignored. Passing organisationId pointing at a non-organisation party (e.g. another person's id) returns 404 'organisation not found' — Capsule filters lookups by type.",
      createPartySchema, createParty);

    registerTool(server, "update_party",
      "Update top-level fields on an existing party (about, firstName/lastName/name/title/jobTitle, ownerId). Only the fields you provide are changed. Child arrays (emailAddresses / phoneNumbers / addresses / websites) on this tool are APPEND-ONLY: items are merged into the existing list, not replaced. For surgical changes — replacing one email, removing one phone number, fixing the type on one address — use the dedicated atomic tools: add_party_email_address / remove_party_email_address_by_id (and the phone/address/website equivalents).",
      updatePartySchema, updateParty);

    registerTool(server, "delete_party",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a party (person or organisation). Cascades to all linked notes, tasks, opportunities, AND projects (kases). Deleting an organisation does NOT delete people linked to it via organisationId — their `organisation` field is silently cleared to null and they survive as standalone records. Requires confirm=true. Always read the party first with get_party and confirm with the user before calling. Idempotent on retry: response is `{deleted: true, alreadyDeleted: false, id}` on a fresh delete or `{deleted: true, alreadyDeleted: true, id}` if the party was already gone (Capsule's 404 is caught internally so reconciliation loops can re-issue safely).",
      deletePartySchema, deleteParty);

    // ── Atomic child-array operations (avoid append-only surprises) ─────
    registerTool(server, "add_party_email_address",
      "Append a single email address to a party. Atomic — one PUT to Capsule. Use this instead of update_party.emailAddresses when you want to add exactly one entry; the bulk array on update_party is append-only and won't replace.",
      addPartyEmailAddressSchema, addPartyEmailAddress);

    registerTool(server, "remove_party_email_address_by_id",
      "Remove one email-address entry from a party by its row id. Atomic. Discover the id via get_party — each entry in the emailAddresses array carries one. Use this to replace an existing entry: remove the old id, then call add_party_email_address with the new value (any associated server-side metadata on the old row is discarded along with the row). Idempotent on retry: response is `{removed: true, alreadyRemoved: false, partyId, emailAddressId, party}` on a fresh remove (the updated party shape is included) or `{removed: true, alreadyRemoved: true, partyId, emailAddressId}` if the row was already gone (Capsule's 404 is caught).",
      removePartyEmailAddressByIdSchema, removePartyEmailAddressById);

    registerTool(server, "add_party_phone_number",
      "Append a single phone number to a party. Atomic — one PUT to Capsule. Use this instead of update_party.phoneNumbers for single-entry adds.",
      addPartyPhoneNumberSchema, addPartyPhoneNumber);

    registerTool(server, "remove_party_phone_number_by_id",
      "Remove one phone-number entry from a party by its row id. Atomic. Discover the id via get_party. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, partyId, phoneNumberId, party}` on a fresh remove or `{removed: true, alreadyRemoved: true, partyId, phoneNumberId}` if the row was already gone.",
      removePartyPhoneNumberByIdSchema, removePartyPhoneNumberById);

    registerTool(server, "add_party_address",
      "Append a single postal address to a party. Atomic — one PUT to Capsule. Use this instead of update_party.addresses for single-entry adds.",
      addPartyAddressSchema, addPartyAddress);

    registerTool(server, "remove_party_address_by_id",
      "Remove one address entry from a party by its row id. Atomic. Discover the id via get_party. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, partyId, addressId, party}` on a fresh remove or `{removed: true, alreadyRemoved: true, partyId, addressId}` if the row was already gone.",
      removePartyAddressByIdSchema, removePartyAddressById);

    registerTool(server, "add_party_website",
      "Append a single website / social handle to a party. Atomic — one PUT to Capsule. Use this instead of update_party.websites for single-entry adds. The 'address' field is a URL when service='URL' or a handle (e.g. '@anton') for social services.",
      addPartyWebsiteSchema, addPartyWebsite);

    registerTool(server, "remove_party_website_by_id",
      "Remove one website entry from a party by its row id. Atomic. Discover the id via get_party. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, partyId, websiteId, party}` on a fresh remove or `{removed: true, alreadyRemoved: true, partyId, websiteId}` if the row was already gone.",
      removePartyWebsiteByIdSchema, removePartyWebsiteById);
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  registerTool(server, "search_opportunities",
    "Free-text search or list opportunities in Capsule CRM. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent', 'won this quarter', 'in pipeline X at milestone Y' — use filter_opportunities instead.",
    searchOpportunitiesSchema, searchOpportunities);

  registerTool(server, "filter_opportunities",
    "Filter opportunities by structured conditions (milestone, value, close date, tags). Use this — not search_opportunities — for questions like 'last won deal', 'opportunities closed this month', 'pipeline X at milestone Y'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field (e.g. {field: 'closedOn', operator: 'is within last', value: 90}) and pick the highest-id row — Capsule IDs are monotonic, so newest id = newest record.",
    filterOpportunitiesSchema, filterOpportunities);

  registerTool(server, "get_opportunity",
    "Fetch a single opportunity by its numeric ID.",
    getOpportunitySchema, getOpportunity);

  registerTool(server, "get_opportunities",
    "Batch-fetch up to 10 opportunities by ID in a single call.",
    getOpportunitiesSchema, getOpportunities);

  registerTool(server, "list_deleted_opportunities",
    "Audit feature: list opportunities deleted on or after a given timestamp. The `since` parameter is REQUIRED. Response also includes a `restrictedOpportunities` key for records the integration user can't read fully.",
    listDeletedOpportunitiesSchema, listDeletedOpportunities);

  registerTool(server, "list_additional_parties",
    "List secondary party links on an opportunity or project. The 'main' party is on the entity itself (opportunity.party); additional parties are e.g. partners, consultants, or referrers also involved in the deal. Set entity to 'opportunities' or 'kases' (Capsule's term for projects).",
    listAdditionalPartiesSchema, listAdditionalParties);

  registerTool(server, "list_associated_projects",
    "List projects (cases) associated with a given opportunity. The inverse direction (project → opportunity) is on each project's `opportunity` field directly.",
    listAssociatedProjectsSchema, listAssociatedProjects);

  if (!readOnly) {
    registerTool(server, "create_opportunity",
      "Create a new opportunity linked to a party and a pipeline milestone.",
      createOpportunitySchema, createOpportunity);

    registerTool(server, "update_opportunity",
      "Update fields on an existing opportunity. Only the fields you provide are changed. Closed (Won/Lost) opportunities ARE editable — Capsule does not enforce closed-record immutability, so `value`, `description`, etc. can be changed on a Won opp without warning. If the workflow needs historical revenue numbers to be stable, enforce that caller-side.",
      updateOpportunitySchema, updateOpportunity);

    registerTool(server, "delete_opportunity",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete an opportunity. Requires confirm=true. Always read the opportunity first with get_opportunity and confirm with the user before calling. Idempotent on retry: response is `{deleted: true, alreadyDeleted: false, id}` on a fresh delete or `{deleted: true, alreadyDeleted: true, id}` if the opportunity was already gone.",
      deleteOpportunitySchema, deleteOpportunity);
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  registerTool(server, "list_projects",
    "List projects (cases) in Capsule CRM, optionally filtered by status. Returns results in Capsule's default order (no sort parameter is supported here). For structured queries — 'most recent project', 'projects opened this month', 'projects tagged X' — use filter_projects instead.",
    listProjectsSchema, listProjects);

  registerTool(server, "filter_projects",
    "Filter projects (cases) by structured conditions (date ranges, status, tags, owner). Use this — not list_projects — for questions like 'most recent project', 'projects opened this month'. Capsule's API does not support ad-hoc sort, but for 'most recent X' you can filter by a date field and pick the highest-id row — Capsule IDs are monotonic, so newest id = newest record.",
    filterProjectsSchema, filterProjects);

  registerTool(server, "get_project",
    "Fetch a single project (case) by its numeric ID.",
    getProjectSchema, getProject);

  registerTool(server, "get_projects",
    "Batch-fetch up to 10 projects (cases) by ID in a single call.",
    getProjectsSchema, getProjects);

  registerTool(server, "list_deleted_projects",
    "Audit feature: list projects deleted on or after a given timestamp. The `since` parameter is REQUIRED. Response also includes a `restrictedKases` key for records the integration user can't read fully.",
    listDeletedProjectsSchema, listDeletedProjects);

  if (!readOnly) {
    registerTool(server, "create_project",
      "Create a new project (case) in Capsule CRM linked to a party.",
      createProjectSchema, createProject);

    registerTool(server, "update_project",
      "Update fields on an existing project. Only the fields you provide are changed. Use status='CLOSED' to close a project. CLOSED projects remain fully editable — Capsule does not enforce closed-record immutability. Stage moves and description edits on a CLOSED project are accepted without warning.",
      updateProjectSchema, updateProject);

    registerTool(server, "delete_project",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a project (case). Prefer update_project with status='CLOSED' to close a project while preserving history. Requires confirm=true. Always read the project first with get_project and confirm with the user before calling. Idempotent on retry: response is `{deleted: true, alreadyDeleted: false, id}` on a fresh delete or `{deleted: true, alreadyDeleted: true, id}` if the project was already gone.",
      deleteProjectSchema, deleteProject);

    // ── Relationships (writes) ──────────────────────────────────────────────
    registerTool(server, "add_additional_party",
      "Link an existing party as an additional (secondary) party on an opportunity or project. The 'main' party is set via update_opportunity / update_project; this adds *additional* parties beyond the main one. Idempotent — re-adding a linked party is harmless. Response: `{linked: true, alreadyLinked: false}` on a fresh link, `{linked: true, alreadyLinked: true}` if the party was already linked (Capsule's 422 'already a contact' / 'already related' is caught internally and converted).",
      addAdditionalPartySchema, addAdditionalParty);

    registerTool(server, "remove_additional_party",
      "Remove an additional-party link between an opportunity/project and a party. The party itself is NOT deleted. Requires confirm=true. Reversible by re-adding via add_additional_party. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, entity, entityId, partyId}` on a fresh remove or `{removed: true, alreadyRemoved: true, ...}` if the link was already gone (Capsule's 404 is caught and converted).",
      removeAdditionalPartySchema, removeAdditionalParty);

    // ── Tracks (writes) ─────────────────────────────────────────────────────
    registerTool(server, "apply_track",
      "Apply a track definition to an opportunity or project. Creates a track instance and auto-creates tasks per the track's task definitions; tasks' `dueOn` is computed from `startDate` (defaults to today) plus each task's `daysAfter` offset. Use list_track_definitions to discover available templates. NOT IDEMPOTENT — applying the same trackDefinitionId twice creates two independent track instances and two sets of auto-tasks (no de-duplication). If you want to apply only once, call list_entity_tracks first and check for an existing instance with the same trackDefinition.id (but mind that list_entity_tracks can include auto-applied tracks from board stage rules, not just manual applies).",
      applyTrackSchema, applyTrack);

    registerTool(server, "update_track",
      "Update a track instance. Capsule's PUT semantics are partial — provide only the fields you want to change in `fields`. Common: { complete: true } to mark a track completed.",
      updateTrackSchema, updateTrack);

    registerTool(server, "remove_track",
      "Remove a track instance from its entity. Tasks already created by the track stay on the entity and must be deleted separately if desired. Requires confirm=true. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, trackId}` on a fresh remove or `{removed: true, alreadyRemoved: true, trackId}` if the track was already gone.",
      removeTrackSchema, removeTrack);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  registerTool(server, "list_tasks",
    "List tasks in Capsule CRM. Defaults to OPEN tasks; pass status to broaden. Optionally filter to a specific owner via ownerId. Capsule does not expose a due-date filter on this endpoint — for that use filter_* tools elsewhere or iterate.",
    listTasksSchema, listTasks);

  registerTool(server, "get_task",
    "Fetch a single task by its numeric ID.",
    getTaskSchema, getTask);

  registerTool(server, "get_tasks",
    "Batch-fetch up to 10 tasks by ID in a single call.",
    getTasksSchema, getTasks);

  if (!readOnly) {
    registerTool(server, "create_task",
      "Create a new task, optionally linked to a party, opportunity, or project.",
      createTaskSchema, createTask);

    registerTool(server, "update_task",
      "Update fields on an existing task. Only the fields you provide are changed. To mark a task done prefer complete_task.",
      updateTaskSchema, updateTask);

    registerTool(server, "complete_task",
      "Mark a task as done / completed / finished. Sets status=COMPLETED on the task, populating completedBy and completedAt while preserving the task in history (unlike delete_task which removes it permanently). Use this whenever a user says 'mark done', 'complete', 'finish', or similar — equivalent to update_task with status:COMPLETED but more discoverable.",
      completeTaskSchema, completeTask);

    registerTool(server, "delete_task",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a task. Prefer complete_task to mark a task done while keeping it in history. Requires confirm=true. Idempotent on retry: response is `{deleted: true, alreadyDeleted: false, id}` on a fresh delete or `{deleted: true, alreadyDeleted: true, id}` if the task was already gone.",
      deleteTaskSchema, deleteTask);
  }

  // ── Entries (notes, captured emails, completed-task records) ──────────────

  registerTool(server, "list_party_entries",
    "List timeline entries (notes, captured emails, completed-task records) for a party. Use this to read the conversation history with a contact or organisation.",
    listPartyEntriesSchema, listPartyEntries);

  registerTool(server, "list_opportunity_entries",
    "List timeline entries (notes, captured emails, completed-task records) for an opportunity.",
    listOpportunityEntriesSchema, listOpportunityEntries);

  registerTool(server, "list_project_entries",
    "List timeline entries (notes, captured emails, completed-task records) for a project (case).",
    listProjectEntriesSchema, listProjectEntries);

  registerTool(server, "get_entry",
    "Fetch a single timeline entry by its numeric ID. Returns full content (note body, email subject + body, etc.).",
    getEntrySchema, getEntry);

  registerTool(server, "list_entries",
    "Global timeline feed: every note, captured email, and completed-task record across the whole Capsule account, paginated. Default order is most-recent-first. Use this for 'what activity happened today/this week across the company?' rather than iterating list_party_entries / list_opportunity_entries / list_project_entries.",
    listEntriesSchema, listEntries);

  // ── Attachments ──────────────────────────────────────────────────────────
  //
  // get_attachment can't use registerTool because its handler does
  // content-type-aware response shaping (image → MCP image content,
  // text → text content, binary → metadata + base64). The raw
  // server.tool call stays here so the content shape can vary.

  server.tool(
    "get_attachment",
    "Download an attachment by id. Returns image content for image/* types (Claude can describe it natively); decoded text for text/* and application/json (small files); JSON metadata + base64 payload for other binary types (PDF, Office docs, etc.). Files exceeding maxSizeBytes (default 5MB) return metadata only with a `truncated: true` flag.",
    getAttachmentSchema.shape,
    async (input) => {
      const result = await getAttachment(input);

      // Truncated: return metadata only.
      if (result.truncated) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: input.id,
                  contentType: result.contentType,
                  sizeBytes: result.sizeBytes,
                  truncated: true,
                  message: `File exceeds the size cap (${input.maxSizeBytes ?? "default"} bytes). Increase maxSizeBytes if you need the bytes; max is 25MB.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Strip any Content-Type parameters (e.g. "; charset=UTF-8") before
      // comparing — Capsule routinely returns "image/png; charset=UTF-8"
      // and "application/json; charset=UTF-8". Without this, the
      // application/json branch would miss the charset variant and the
      // file would fall through to the binary base64 branch, which Claude
      // can't read directly.
      const baseType = result.contentType.split(";")[0]!.trim().toLowerCase();

      // Image: return as MCP image content so Claude can see it.
      if (baseType.startsWith("image/")) {
        return {
          content: [
            {
              type: "image",
              data: result.buffer.toString("base64"),
              mimeType: result.contentType,
            },
          ],
        };
      }

      // Text-ish: decode as UTF-8 alongside metadata.
      const isText =
        baseType.startsWith("text/") ||
        baseType === "application/json" ||
        baseType === "application/xml";
      if (isText) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: input.id,
                  contentType: result.contentType,
                  sizeBytes: result.sizeBytes,
                },
                null,
                2,
              ),
            },
            { type: "text", text: result.buffer.toString("utf8") },
          ],
        };
      }

      // Other binary (PDF, Office, archive): metadata + base64 payload
      // for downstream tools (Claude itself can't read PDF bytes
      // directly, but can pass the base64 to other tools).
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: input.id,
                contentType: result.contentType,
                sizeBytes: result.sizeBytes,
                base64: result.buffer.toString("base64"),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  if (!readOnly) {
    registerTool(server, "add_note",
      "Add a note to a party, opportunity, or project. Provide exactly one of partyId, opportunityId, or projectId.",
      addNoteSchema, addNote);

    registerTool(server, "update_entry",
      "Edit an existing timeline entry — typically a note. Provide the entry id plus the fields you want to change (content, subject). Only the fields you supply are modified; other fields keep their current values. Cannot change the entry's type. Use this to correct or extend a note added previously.",
      updateEntrySchema, updateEntry);

    registerTool(server, "upload_attachment",
      "Upload a file as a new note attachment, linked to a party, opportunity, or project. Provide the file as base64-encoded `dataBase64` along with `filename` and `contentType` (MIME). Also provide exactly one of partyId / opportunityId / projectId to anchor the note. Optionally pass `content` to set the note body (defaults to '[attachment]'). Two-step orchestration server-side: bytes upload → token → note creation. Adding to an existing entry is not supported.",
      uploadAttachmentSchema, uploadAttachment);

    registerTool(server, "delete_entry",
      "DESTRUCTIVE & IRREVERSIBLE: permanently delete a note (or other entry) by its ID. Requires confirm=true. Idempotent on retry: response is `{deleted: true, alreadyDeleted: false, id}` on a fresh delete or `{deleted: true, alreadyDeleted: true, id}` if the entry was already gone.",
      deleteEntrySchema, deleteEntry);
  }

  // ── Pipelines & milestones ────────────────────────────────────────────────

  registerTool(server, "list_pipelines",
    "List all sales pipelines defined in Capsule CRM.",
    listPipelinesSchema, listPipelines);

  registerTool(server, "list_milestones",
    "List all milestones (stages) within a specific opportunity pipeline.",
    listMilestonesSchema, listMilestones);

  // ── Boards & stages (project workflow metadata) ───────────────────────────
  //
  // Boards/stages are to projects what pipelines/milestones are to
  // opportunities. A project sits at one stage at a time on one board.

  registerTool(server, "list_boards",
    "List all project (kase) boards defined in Capsule. A board is a grouping of stages that projects flow through — the project equivalent of an opportunity pipeline.",
    listBoardsSchema, listBoards);

  registerTool(server, "list_stages",
    "List project stages. Without arguments returns every stage across every board (each carries a .board reference). Pass boardId to scope to one specific board.",
    listStagesSchema, listStages);

  // ── Reference metadata (teams, lost reasons, activity types) ──────────────

  registerTool(server, "list_teams",
    "List all teams configured in the Capsule account. Useful as input for filter_* queries that scope by team, and for reporting.",
    listTeamsSchema, listTeams);

  registerTool(server, "list_lostreasons",
    "List all configured opportunity-loss reasons (e.g. 'Poor Qualification', 'Lost to competitor'). Useful for analysing closed-lost opportunities by reason.",
    listLostReasonsSchema, listLostReasons);

  registerTool(server, "list_activitytypes",
    "List all configured activity types (e.g. Call, Meeting, Email). These are the categories used when logging timeline entries.",
    listActivityTypesSchema, listActivityTypes);

  registerTool(server, "list_categories",
    "List configured entry/task categories (Call, Email, Meeting, Follow-up, etc.) with their colours. Used to label and filter timeline entries and tasks.",
    listCategoriesSchema, listCategories);

  registerTool(server, "list_track_definitions",
    "List workflow track definitions: reusable templates that auto-create tasks at configured intervals when applied to an opportunity or project. Each track includes nested taskDefinitions specifying what to create and when. Use this to understand what automations exist.",
    listTrackDefinitionsSchema, listTrackDefinitions);

  registerTool(server, "list_entity_tracks",
    "List track INSTANCES on a specific record — i.e., which tracks have been applied to this opportunity / project / party. Distinct from list_track_definitions, which lists the templates. NOTE: some boards have stage-triggered automation that auto-applies tracks when an entity enters specific stages — tracks returned here may include BOTH manually-applied tracks (via apply_track) and auto-applied tracks from Capsule board rules. To distinguish, compare each track's `trackDefinition.id` against your application's apply_track call history.",
    listEntityTracksSchema, listEntityTracks);

  registerTool(server, "show_track",
    "Fetch a single track instance by id. Returns the minimal Capsule projection: id, description, trackDateOn, direction, and the array of tasks attached to the track. Capsule's GET /tracks/{id} does NOT include a trackDefinition link, an entity reference, or a completion field — to find the entity a track is applied to, use list_entity_tracks (which lists track instances by their parent entity); to check completion, the track-tasks' own statuses are the proxy.",
    showTrackSchema, showTrack);

  registerTool(server, "list_goals",
    "List sales / activity goals configured in the account (per-user or per-team revenue or activity targets). Returns an empty list for accounts that don't use the Goals feature.",
    listGoalsSchema, listGoals);

  registerTool(server, "get_site",
    "Return the Capsule account this connector is currently authenticated against (subdomain, display name, URL). Diagnostic for 'which Capsule account is this?'. For the PAT owner's user identity, use get_current_user.",
    getSiteSchema, getSite);

  // ── Saved filters (UI-defined filters; support sort, unlike ad-hoc) ───────

  registerTool(server, "list_saved_filters",
    "List all filters that users have saved in Capsule's web UI for an entity type. Saved filters are reusable — they bundle conditions, columns, and (importantly) sort. Use this to discover what queries are already configured before building a one-off filter_* call.",
    listSavedFiltersSchema, listSavedFilters);

  registerTool(server, "run_saved_filter",
    "Run a saved filter by id and return its results, paginated. Unlike filter_parties / filter_opportunities / filter_projects (which use the ad-hoc filter endpoint and CANNOT sort), saved filters DO support sort — the orderBy is configured in Capsule's web UI when the filter is created. So 'most recent X by Y' questions are answerable in one call IF a saved filter exists; use list_saved_filters first to find one.",
    runSavedFilterSchema, runSavedFilter);

  // ── Tags ──────────────────────────────────────────────────────────────────

  registerTool(server, "list_tags",
    "List all tags available for a given entity type (parties, opportunities, or kases).",
    listTagsSchema, listTags);

  if (!readOnly) {
    registerTool(server, "add_tag",
      "Attach a tag to a party, opportunity, or project (kase) by NAME. Capsule resolves to an existing tag in the tenant or creates a fresh one with this name. Matching is case-insensitive — 'Zendesk' and 'zendesk' attach the same tag, preserving the canonical casing from whichever variant was created first. To avoid creating a genuinely-distinct near-duplicate (e.g. 'Zendesk' vs 'Zen Desk'), call list_tags first and reuse the exact name. Idempotent — re-attaching an already-attached tag is harmless. To DETACH a tag, use remove_tag_by_id with the tag's id (read via get_party/get_opportunity/get_project with embed='tags').",
      addTagSchema, addTag);

    registerTool(server, "remove_tag_by_id",
      "Detach a tag from a party, opportunity, or project (kase). Atomic — one PUT to Capsule. The `tagId` parameter is the tag's id, readable via get_party/get_opportunity/get_project with embed='tags' (list_tags returns the same ids and also works, but reading via embed first confirms the tag is actually attached to this entity). The tag definition itself remains in the tenant for other entities that still share it. Idempotent on retry: response is `{removed: true, alreadyRemoved: false, entity, entityId, tagId, ...<updated entity>}` on a fresh detach or `{removed: true, alreadyRemoved: true, entity, entityId, tagId}` if the tag was already detached (Capsule's 422 'tag not found to delete' is caught and converted).",
      removeTagByIdSchema, removeTagById);
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  registerTool(server, "list_users",
    "List all users in the Capsule account.",
    listUsersSchema, listUsers);

  registerTool(server, "get_current_user",
    "Show the user owning the API token this connector is using. Useful for audit ('under whose Capsule identity is the connector running?') and for confirming a token rotation moved ownership to the expected account. Wraps Capsule's GET /users/current — note the endpoint is /users/current, not /users/me.",
    getCurrentUserSchema, getCurrentUser);

  return server;
}
