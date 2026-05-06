# capsule-mcp

An MCP (Model Context Protocol) server for [Capsule CRM](https://capsulecrm.com), exposing read and write operations as tools you can use directly from Claude Desktop or Claude Code.

## Requirements

- [Node.js 20 or newer](https://nodejs.org/)
- A Capsule Personal Access Token (see below)

## Generating a Capsule Personal Access Token

1. Log into Capsule and open **My Preferences** (top-right avatar menu).
2. Go to **API Authentication Tokens**.
3. Click **Generate new token**, give it a name, and copy the value — it won't be shown again.

## Quick install — Claude Desktop

Open `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "capsule": {
      "command": "npx",
      "args": ["-y", "github:anton-arapov/capsule-mcp"],
      "env": {
        "CAPSULE_API_TOKEN": "<your token>"
      }
    }
  }
}
```

Restart Claude Desktop. The Capsule tools will appear in the tool picker.

> **First launch is slow.** `npx` will clone the repo, install dependencies, and build the server on the first run (~30 seconds). Subsequent launches are fast — npx caches the built binary.

## Quick install — Claude Code

```bash
claude mcp add capsule -- npx -y github:anton-arapov/capsule-mcp
```

Then export the token in your shell profile:

```bash
export CAPSULE_API_TOKEN=<your token>
```

## Manual install (alternative)

If you'd rather not use `npx`, you can clone and build locally:

```bash
git clone https://github.com/anton-arapov/capsule-mcp.git
cd capsule-mcp
npm install        # this also runs the build via the prepare script
```

Then point Claude Desktop at the built file:

```json
{
  "mcpServers": {
    "capsule": {
      "command": "node",
      "args": ["/absolute/path/to/capsule-mcp/dist/index.js"],
      "env": {
        "CAPSULE_API_TOKEN": "<your token>"
      }
    }
  }
}
```

## Available tools

### Parties (people & organisations)

| Tool | Description |
|---|---|
| `search_parties` | Search or list parties; supports `q`, `embed`, `page`, `perPage` |
| `get_party` | Fetch a single party by ID |
| `list_party_opportunities` | All opportunities linked to a party |
| `list_party_projects` | All projects linked to a party |
| `create_party` | Create a person or organisation |
| `update_party` | Update fields on an existing party (partial update) |
| `delete_party` | **Destructive.** Permanently delete a party and all linked records. Requires `confirm: true` |

### Opportunities

| Tool | Description |
|---|---|
| `search_opportunities` | Search or list opportunities |
| `get_opportunity` | Fetch a single opportunity by ID |
| `create_opportunity` | Create an opportunity linked to a party and milestone |
| `update_opportunity` | Update fields on an existing opportunity |
| `delete_opportunity` | **Destructive.** Permanently delete an opportunity. Requires `confirm: true` |

### Projects

| Tool | Description |
|---|---|
| `list_projects` | List projects, optionally filtered by `OPEN`/`CLOSED` |
| `get_project` | Fetch a single project by ID |
| `create_project` | Create a project linked to a party |
| `update_project` | Update fields on a project (incl. closing it via `status`) |
| `delete_project` | **Destructive.** Permanently delete a project. Prefer closing via `update_project status='CLOSED'`. Requires `confirm: true` |

### Tasks

| Tool | Description |
|---|---|
| `list_tasks` | List tasks, filterable by status, assignee, or due date |
| `create_task` | Create a task, optionally linked to a party, opportunity, or project |
| `update_task` | Update fields on a task |
| `complete_task` | Mark a task as completed |
| `delete_task` | **Destructive.** Permanently delete a task. Prefer `complete_task` to keep history. Requires `confirm: true` |

### Notes

| Tool | Description |
|---|---|
| `add_note` | Add a note to a party, opportunity, or project |
| `delete_entry` | **Destructive.** Permanently delete a note (or other entry). Requires `confirm: true` |

### Pipelines & milestones

| Tool | Description |
|---|---|
| `list_pipelines` | List all sales pipelines |
| `list_milestones` | List milestones within a specific pipeline |

### Tags

| Tool | Description |
|---|---|
| `list_tags` | List tags for `parties`, `opportunities`, or `kases` |

### Users

| Tool | Description |
|---|---|
| `list_users` | List all users in the account |

## Delete safety

Every `delete_*` tool requires an explicit `confirm: true` argument. The Zod schema rejects the call before any HTTP request is made if `confirm` is missing or `false`. The tool descriptions also tell the LLM to read the entity first (e.g. `get_party`) and confirm with the user before invoking — but the schema gate is the hard backstop.

There is no `delete_pipeline`, `delete_milestone`, `delete_user`, or `delete_tag` tool — those are configuration objects whose deletion can break existing records, and are intentionally out of scope.

## Pagination

Paginated tools return a `nextPage` field when more results exist. Pass it back as the `page` argument to fetch the next page. Default `perPage` is 25; maximum is 100.

## Development

```bash
npm run dev        # watch mode build
npm test           # run tests (no real API calls)
npm run typecheck  # tsc --noEmit
```

## License

Apache License 2.0 — Copyright 2026 Anton Arapov. See [LICENSE](LICENSE) for the full text.
