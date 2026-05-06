# capsule-mcp

An MCP (Model Context Protocol) server for [Capsule CRM](https://capsulecrm.com), exposing read and write operations as tools you can use directly from Claude Desktop or Claude Code.

## Install

```bash
git clone <this-repo>
cd capsule-mcp
npm install
npm run build
```

## Generating a Capsule Personal Access Token

1. Log into Capsule and open **My Preferences** (top-right avatar menu).
2. Go to **API Authentication Tokens**.
3. Click **Generate new token**, give it a name, and copy the value — it won't be shown again.

## Environment setup

```bash
cp .env.example .env
# edit .env and set CAPSULE_API_TOKEN=<your token>
```

The server reads `CAPSULE_API_TOKEN` from the environment at startup and fails fast with a clear message if it's missing or returns 401.

## Running locally

```bash
# after build
CAPSULE_API_TOKEN=<token> node dist/index.js
```

Or via npx from the project root:

```bash
CAPSULE_API_TOKEN=<token> npx capsule-mcp
```

## Claude Desktop configuration

Add the following to your `claude_desktop_config.json` (usually at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Restart Claude Desktop after saving the file. The Capsule tools will appear in the tool picker.

## Claude Code configuration

```bash
claude mcp add capsule -- node /absolute/path/to/capsule-mcp/dist/index.js
```

Then set the token:

```bash
# add to your shell profile or pass inline
export CAPSULE_API_TOKEN=<your token>
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

### Opportunities

| Tool | Description |
|---|---|
| `search_opportunities` | Search or list opportunities |
| `get_opportunity` | Fetch a single opportunity by ID |
| `create_opportunity` | Create an opportunity linked to a party and milestone |
| `update_opportunity` | Update fields on an existing opportunity |

### Projects

| Tool | Description |
|---|---|
| `list_projects` | List projects, optionally filtered by `OPEN`/`CLOSED` |
| `get_project` | Fetch a single project by ID |
| `create_project` | Create a project linked to a party |

### Tasks

| Tool | Description |
|---|---|
| `list_tasks` | List tasks, filterable by status, assignee, or due date |
| `create_task` | Create a task, optionally linked to a party, opportunity, or project |
| `complete_task` | Mark a task as completed |

### Notes

| Tool | Description |
|---|---|
| `add_note` | Add a note to a party, opportunity, or project |

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

## Pagination

Paginated tools return a `nextPage` field when more results exist. Pass it back as the `page` argument to fetch the next page. Default `perPage` is 25; maximum is 100.

## Development

```bash
npm run dev        # watch mode build
npm test           # run tests (no real API calls)
npm run typecheck  # tsc --noEmit
```

## License

MIT
