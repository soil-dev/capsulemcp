# Capsule MCP Server — Implementation Plan

## Chosen Versions

| Package | Version | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.12.0` | Latest; stdio transport |
| `zod` | `^3.23.8` | Input schema validation |
| `undici` | `^7.x` | HTTP client (native fetch alternative) |
| `typescript` | `^5.5` | Strict mode |
| `tsup` | `^8.x` | Build/bundle (ESM output) |
| `vitest` | `^2.x` | Tests |
| Node | `>=20` | Required for native fetch fallback |

---

## File Layout

```
capsulemcp/
├── src/
│   ├── index.ts                 # MCP server entrypoint; registers all tools
│   ├── capsule/
│   │   └── client.ts            # Typed fetch wrapper (auth, pagination, embed, 429 retry)
│   └── tools/
│       ├── parties.ts           # search_parties, get_party, create_party, update_party
│       ├── opportunities.ts     # search_opportunities, get_opportunity, list_party_opportunities,
│       │                        # create_opportunity, update_opportunity
│       ├── projects.ts          # list_projects, get_project, list_party_projects, create_project
│       ├── tasks.ts             # list_tasks, create_task, complete_task
│       ├── entries.ts           # add_note
│       ├── pipelines.ts         # list_pipelines, list_milestones
│       ├── tags.ts              # list_tags
│       └── users.ts             # list_users
├── tests/
│   ├── parties.test.ts
│   ├── opportunities.test.ts
│   ├── projects.test.ts
│   ├── tasks.test.ts
│   ├── entries.test.ts
│   ├── pipelines.test.ts
│   ├── tags.test.ts
│   └── users.test.ts
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── LICENSE
└── README.md
```

---

## Capsule API Key Facts (from docs)

- **Base URL**: `https://api.capsulecrm.com/api/v2`
- **Auth header**: `Authorization: Bearer {token}`
- **Always send**: `Accept: application/json`, `Content-Type: application/json` (writes)
- **Pagination**: `?page=N&perPage=N` (1-based, default 50, max 100). Link header (`rel="next"`, `rel="prev"`) per RFC 5988.
- **Embed**: `?embed=tags,fields` — comma-separated list appended to any GET
- **Rate limiting**: 429 → honour `Retry-After` header, one retry
- **Create** → `201 Created` + `Location` header + full record body
- **Update** → `200 OK` + full record body (PUT, partial fields OK)
- **Cases = Projects**: API path is `/kases`, display name is "Projects"

---

## Tool List with Input Schemas

### Read Tools

#### `search_parties`
Search/list people and organisations.
```ts
{
  q?: string,           // free-text search
  embed?: string,       // e.g. "tags,fields"
  page?: number,        // default 1
  perPage?: number      // default 25, max 100
}
```
Returns `{ parties: Party[], nextPage?: number }`

#### `get_party`
Fetch a single party by ID.
```ts
{ id: number, embed?: string }
```
Returns `{ party: Party }`

#### `list_party_opportunities`
All opportunities linked to a party.
```ts
{ partyId: number, page?: number, perPage?: number }
```
Returns `{ opportunities: Opportunity[], nextPage?: number }`

#### `list_party_projects`
All projects linked to a party.
```ts
{ partyId: number, page?: number, perPage?: number }
```
Returns `{ kases: Project[], nextPage?: number }`

#### `search_opportunities`
Search/list opportunities.
```ts
{
  q?: string,
  embed?: string,
  page?: number,
  perPage?: number
}
```
Returns `{ opportunities: Opportunity[], nextPage?: number }`

#### `get_opportunity`
```ts
{ id: number, embed?: string }
```
Returns `{ opportunity: Opportunity }`

#### `list_projects`
```ts
{
  status?: "OPEN" | "CLOSED",
  embed?: string,
  page?: number,
  perPage?: number
}
```
Returns `{ kases: Project[], nextPage?: number }`

#### `get_project`
```ts
{ id: number, embed?: string }
```
Returns `{ kase: Project }`

#### `list_tasks`
```ts
{
  status?: "OPEN" | "COMPLETED" | "PENDING",
  assignedToUserId?: number,
  dueOn?: string,          // ISO date YYYY-MM-DD
  page?: number,
  perPage?: number
}
```
Returns `{ tasks: Task[], nextPage?: number }`

#### `list_pipelines`
No inputs. Returns `{ pipelines: Pipeline[] }`

#### `list_milestones`
```ts
{ pipelineId: number }
```
Returns `{ milestones: Milestone[] }`

#### `list_users`
No inputs. Returns `{ users: User[] }`

#### `list_tags`
```ts
{ entity: "parties" | "opportunities" | "kases" }
```
Returns `{ tags: Tag[] }`

---

### Write Tools

#### `create_party`
```ts
{
  type: "person" | "organisation",
  // person fields
  firstName?: string,
  lastName?: string,
  title?: string,
  jobTitle?: string,
  organisationId?: number,   // link to existing org
  // organisation fields
  name?: string,
  // shared
  about?: string,
  emailAddresses?: Array<{ address: string, type?: string }>,
  phoneNumbers?:   Array<{ number: string, type?: string }>,
  addresses?:      Array<{ street?: string, city?: string, state?: string, country?: string, zip?: string }>,
  websites?:       Array<{ url: string, service?: string }>,
  ownerId?: number
}
```
Returns `{ party: Party }`

#### `update_party`
```ts
{
  id: number,
  // all same optional fields as create_party minus `type`
  firstName?: string,
  lastName?: string,
  title?: string,
  jobTitle?: string,
  name?: string,
  about?: string,
  emailAddresses?: Array<{ address: string, type?: string }>,
  phoneNumbers?:   Array<{ number: string, type?: string }>,
  addresses?:      Array<{ street?: string, city?: string, state?: string, country?: string, zip?: string }>,
  websites?:       Array<{ url: string, service?: string }>,
  ownerId?: number
}
```
Returns `{ party: Party }`

#### `create_opportunity`
```ts
{
  name: string,
  partyId: number,
  milestoneId: number,
  description?: string,
  value?: { amount: number, currency?: string },
  expectedCloseOn?: string,   // YYYY-MM-DD
  probability?: number,
  ownerId?: number
}
```
Returns `{ opportunity: Opportunity }`

#### `update_opportunity`
```ts
{
  id: number,
  name?: string,
  milestoneId?: number,
  description?: string,
  value?: { amount: number, currency?: string },
  expectedCloseOn?: string,
  probability?: number,
  ownerId?: number
}
```
Returns `{ opportunity: Opportunity }`

#### `create_project`
```ts
{
  name: string,
  partyId: number,
  description?: string,
  status?: "OPEN" | "CLOSED",
  ownerId?: number
}
```
Returns `{ kase: Project }`

#### `create_task`
```ts
{
  description: string,
  dueOn: string,            // YYYY-MM-DD
  dueTime?: string,         // HH:MM
  detail?: string,
  ownerId?: number,
  // link to exactly one of:
  partyId?: number,
  opportunityId?: number,
  projectId?: number
}
```
Returns `{ task: Task }`

#### `complete_task`
```ts
{ id: number }
```
Sends `PUT /tasks/{id}/complete`. Returns `{ task: Task }`

#### `add_note`
```ts
{
  content: string,
  // link to exactly one of:
  partyId?: number,
  opportunityId?: number,
  projectId?: number
}
```
Posts `{ type: "note", content, party|opportunity|kase: { id } }` to `POST /entries`.  
Returns `{ entry: Entry }`

---

## `src/capsule/client.ts` — Design

```ts
interface CapsuleClient {
  get<T>(path: string, params?: Record<string, string | number>): Promise<{ data: T; nextPage?: number }>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
}
```

- Reads `CAPSULE_API_TOKEN` at startup; throws clear message if absent.
- All requests include `Authorization: Bearer`, `Accept: application/json`.
- Writes add `Content-Type: application/json`.
- On `401`: throws `CapsuleAuthError` with hint to check token.
- On `429`: reads `Retry-After` (default 5s), sleeps once, retries. Throws if second attempt also 429.
- On other 4xx/5xx: parses Capsule's JSON error body `{ message }` and throws `CapsuleApiError`.
- `get()` parses `Link` header for `rel="next"` to extract `nextPage` number.
- `embed` param passed as comma-joined string if present.

---

## Open Questions

1. **Tags list endpoint path**: The docs 404'd on `/v2/models/tag`. Likely `GET /parties/tags`, `GET /opportunities/tags`, `GET /kases/tags` — will verify at runtime or fall back to `GET /tags?resource=parties`.
2. **`complete_task` endpoint**: Docs show task status as a field. Most CRMs have a dedicated `/tasks/{id}/complete` action — if not, we'll `PUT /tasks/{id}` with `{ status: "COMPLETED" }`.
3. **Party search vs list**: Capsule likely uses `GET /parties?q=foo` for search. Will confirm from response shape.
4. **Milestone list by pipeline path**: Likely `GET /pipelines/{id}/milestones` — standard REST hierarchy.
5. **Default perPage**: Spec asks for 25; Capsule API default is 50. We'll always send `?perPage=25` explicitly unless the caller overrides.

---

## Testing Strategy

Each `*.test.ts` uses `vitest` with `vi.stubGlobal('fetch', ...)` to mock the global fetch. Tests cover:
- Happy path (correct URL construction, correct returned shape)
- 401 → `CapsuleAuthError`
- 429 → single retry, then error on second 429
- Pagination: `nextPage` extracted from Link header

No real HTTP calls anywhere in the test suite.
