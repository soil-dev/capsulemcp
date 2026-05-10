# Design notes

What capsulemcp is, what it isn't, and the choices behind both. This
file captures the assumptions baked into the implementation, the
limitations they impose, and the Capsule API surface we deliberately
don't expose — along with the reasoning, so future contributors don't
have to rediscover it.

## Purpose

capsulemcp wraps Capsule CRM's REST API as MCP tools so Claude can read
and (optionally) modify CRM data via natural language. It's deliberately
positioned as a **single-tenant, single-Capsule-account** integration:
one deployment talks to one Capsule account, on behalf of one Capsule
Personal Access Token. Multi-tenant SaaS deployments — where each end
user has their own Capsule account — aren't supported, not because
it's hard but because they'd require a fundamentally different identity
model (see L1).

Two transports — stdio (for local Claude Desktop / Code installs via
npx) and HTTP (for hosted clients including Anthropic Custom Connectors)
— share the same tool surface and Capsule client. The transport is just
where the bytes flow; the semantics are identical.

## Architecture assumptions

### A1. Capsule API stability

Everything hinges on these holding for `/api/v2`:

- **Endpoint paths** stay where they are: `/parties`, `/opportunities`,
  `/kases`, `/entries`, `/attachments/{id}`, the structured-filter
  endpoints, etc.
- **Response shape keys** stay where they are: `parties[]`,
  `opportunities[]`, `kases[]`, `entry`, `track`, `lostReasons[]`
  (camelCase). Tool implementations hardcode these.
- **Path syntax for batch fetches** (`GET /<entity>/<id1>,<id2>,...`)
  stays the same and stays capped at 10.
- **Pagination contract** (`page`, `perPage`, RFC 5988 `Link` header
  with `rel="next"`) stays consistent. Default page size 50, max 100.
- **Filter-side field naming** (`addedOn`, `updatedOn`,
  `lastContactedOn`) stays distinct from response field naming
  (`createdAt`, `updatedAt`, `lastContactedAt`).

If any of these break, a new major version reshapes the affected tools.
We don't try to abstract over Capsule's quirks (`/kases` for projects,
`lostReasons` camelCase, etc.) — the connector exposes them faithfully
so the mapping to Capsule's docs is one-to-one and debuggable.

### A2. PAT-based authentication is sufficient

The connector authenticates to Capsule with a single Personal Access
Token. Two-leg OAuth (where each Claude.ai user authenticates against
their own Capsule) is **not** implemented because:

- Single-tenant deployments don't need per-user record visibility (one
  Capsule account, one view of the data).
- Capsule's PAT model is operationally simple — one secret, one
  rotation cadence, one identity in audit logs.

See L4 for what this implies about audit trails.

### A3. Capsule's numeric IDs are monotonically incrementing

Used by every "most recent X" question. The `filter_*` tools wrap
Capsule's structured-filter endpoint, which doesn't support sort, so
we filter by a date condition (`addedOn is within last N`) and pick
the highest id from the result.

If Capsule ever changes ID generation — e.g. UUIDs, or hash-based —
the recency idiom breaks and tool descriptions need rewriting.

### A4. Signing key is stable across HTTP-server instances

For the HTTP transport, OAuth tokens are HMAC-signed and stateless:
their only verification input is the signing key.

Long-running HTTP deployments cycle instances over time (workers
restart, autoscalers add replicas, deploys roll new versions). Tokens
issued by one instance must be verifiable by another. That requires
the signing key to be the same across all instances of a deployment,
loaded from whatever secret-storage the deployer uses (Kubernetes
secrets, cloud secret managers, env files baked into a container,
etc.).

If the key changes — intentionally (rotation) or accidentally (env
misconfigured) — every outstanding access and refresh token is
instantly invalid. MCP clients silently re-run the OAuth dance on the
next call, but the latency hit lands on the user.

The stdio transport doesn't use OAuth, so this assumption is
HTTP-only.

### A5. MCP clients honour content-type discrimination

`get_attachment` returns three different MCP content shapes depending
on the file's Content-Type:

- `image/*` → MCP `image` content (Claude renders inline)
- `text/*`, `application/json`, `application/xml` → text content
  with the body decoded as UTF-8
- everything else → JSON metadata + base64 payload as text

Clients that don't honour the `image` content type (some non-Anthropic
MCP clients) will see the image as text-encoded JSON metadata. That's
not a regression — those clients were never going to render the image
anyway — but worth knowing.

## Limitations

### L1. Single shared Capsule view

The connector exposes whatever the PAT owner can see in Capsule. For
a "Standard" role PAT, that's the whole account. For a "Restricted"
role PAT, only what that user has access to.

There's **no record-level filtering** based on which Claude user
asked. If user A asks "what deals do we have with Acme?", they get
the same answer as user B. This is acceptable for single-tenant
deployments where everyone using the connector is meant to see the
same CRM, but wrong for any deployment where end users are external
to the Capsule org.

If you need per-user record visibility, capsulemcp is the wrong tool
shape. Build a wrapper that does Capsule OAuth 2 per user and threads
each user's token through the MCP boundary — out of scope here.

### L2. No human consent screen at /authorize

`OAuthProvider.authorize()` auto-approves: it issues a code and
redirects to the configured callback without asking the user
anything. Per-user identity isn't part of the model (see L1) so a
consent screen would only ask "do you want this connector to read
this account's CRM?" — the same question the connector setup already
answered.

If you ever federate `/authorize` to a real OIDC IdP — e.g. to gate
which users can use the connector at all — you'd add the consent step
there.

### L3. No token revocation list

Tokens are HMAC-signed and stateless. We can't blacklist a single
leaked token without invalidating every outstanding token (by
rotating the signing key). The 30-day access-token TTL bounds the
window of any individual leak.

A revocation list would require either persisted state (nullifies
the stateless property) or a secondary HMAC over a per-token jti
recorded in a Bloom filter (workable but adds complexity for low
benefit).

### L4. Audit attribution is to the PAT owner

Every API call from the connector shows up in Capsule's audit log
under the PAT-owning user's name, regardless of which Claude user
triggered it. This is a known consequence of L1.

For deployments where this matters (e.g. you want to know that user
A asked Claude to delete a note), you'd need to log the Claude user
identity at the MCP layer (the access token's `clientId` claim, or
richer claims from a federated IdP) and either propagate it as a
custom header on each Capsule call (Capsule may or may not honour
it) or maintain your own audit trail outside Capsule.

### L5. Single shared rate-limit budget

Capsule rate-limits per token, not per call origin. Heavy use by one
user (or a runaway loop in some workflow) can exhaust the budget for
everyone sharing the deployment. The client retries 429 once with
`Retry-After`-aware backoff and then surfaces the error; it doesn't
queue or do per-user fairness.

For typical small-team usage with human-paced queries this hasn't
been a problem in practice. For high-throughput automation, you'd
need either separate deployments per consumer or a more sophisticated
rate-limit layer.

### L6. No caching

Every tool call hits Capsule. There's no cache — not even on
reference-data calls (teams, lost reasons, custom field definitions)
that change rarely. Pros: answers are always live, no invalidation
logic. Cons: a Claude turn that asks ten questions makes ten
round-trips.

If we ever needed it, a small TTL cache on the reference-data tools
would be the lowest-risk place to start (small responses, low write
frequency).

### L7. Capsule's filter API doesn't support sort

The `filter_*` tools wrap `POST /<entity>/filters/results`. That
endpoint accepts conditions and pagination but **not** an `orderBy`
parameter. Sort is only available through saved filters configured
in Capsule's web UI (see `run_saved_filter`).

The recency idiom — filter by date, pick the highest id from the
result — is documented in tool descriptions and works because of A3.
For ranked reports run repeatedly, set up a saved filter once.

### L8. Pagination is single-page-at-a-time

The connector surfaces `nextPage` from the Link header so the caller
can iterate, but it doesn't auto-paginate. Claude has to ask
repeatedly to walk past the first page. For most CRM queries this is
fine — the first page of 25–100 records is enough to answer the
question — but it's worth knowing for explicit "show me everything"
use cases.

Auto-pagination would simplify some queries but at the cost of
unbounded round-trips and unbounded response sizes. The current
behaviour fails predictably; auto-pagination would fail
unpredictably.

### L9. Attachments are limited to 25 MB and 5 MB by default

Capsule's per-file ceiling is 25 MB. We respect it. `get_attachment`
defaults to a 5 MB cap on what's returned to Claude (override via
`maxSizeBytes`) — large binaries blow the context window for limited
gain (Claude can't natively read most binary formats).

The HTTP transport's body limit is 35 MB by default
(env-overridable via `MCP_HTTP_JSON_LIMIT`) so a 25 MB attachment
fits with base64 expansion. Stdio has no body limit.

`upload_attachment` always creates a new note carrying the
attachment. Adding an attachment to an *existing* entry isn't
implemented — `update_entry` doesn't accept an attachments
parameter, and Capsule's PUT semantics on entries replace the
attachments array (so the obvious patch would lose existing
attachments without first reading them).

### L10. MCP-protocol features we don't expose

We register tools and serve `serverInfo.icons`. We don't expose:

- **MCP `prompts` capability** — no reusable prompt templates
  published by the server. Most production MCP clients don't surface
  prompts in the UI yet, so the benefit is limited.
- **MCP `resources` capability** — we don't publish CRM records as
  MCP resources for Claude to subscribe to. Tools cover the use case
  better and are universally supported.
- **`instructions` field** on `serverInfo` — not set; tool
  descriptions carry per-tool guidance instead.

If MCP clients standardise on prompts/resources for richer Claude UX,
adding them would be a future change.

## Endpoint coverage

A complete index of Capsule v2 endpoints, grouped by what we do with
each. Last verified against
<https://developer.capsulecrm.com/v2/operations>.

### Implemented

Every Capsule v2 endpoint that returns useful data, modulo the gaps
listed below. Specifically:

- All read endpoints on Party, Opportunity, Project, Task, Entry
  (including batch fetches up to 10 ids except for entries — see
  "Genuinely not in Capsule v2" below)
- All structured-filter endpoints (parties / opportunities / kases)
- Saved-filter list and run
- Track instances (full CRUD) and track-definition list
- Custom field definition list and get
- Audit list endpoints (deleted parties / opportunities / projects)
- Reference data: teams, lost reasons, activity types, categories,
  goals, pipelines, milestones, boards, stages, tags, users, site
- Attachment download and upload (the latter orchestrated as
  upload-then-create-note)
- Additional-party links (read + write) for opportunities and projects
- Associated projects on an opportunity
- "Employees" of an organisation (`/parties/{id}/people`)

### Deliberately skipped — admin operations

These exist in Capsule v2 but are admin-management work that's
typically done in Capsule's web UI, not from a chat. Exposing them
here would add destruction risk for low value.

| Endpoint | Operation |
|---|---|
| `POST/PUT/DELETE /<entity>/tags` | Tag CRUD on the schema |
| `POST/PUT/DELETE /<entity>/fields/definitions` | Custom field schema CRUD |
| `POST/PUT/DELETE /pipelines`, `/milestones` | Pipeline/milestone CRUD |
| `POST/PUT/DELETE /boards`, `/stages` | Board/stage CRUD |
| `POST/PUT/DELETE /lostreasons` | Lost reason CRUD |
| `POST/PUT/DELETE /activitytypes` | Activity type CRUD |
| `POST/PUT/DELETE /categories` | Category CRUD |
| `POST/PUT/DELETE /goals` | Goal CRUD |
| `POST/PUT/DELETE /trackdefinitions` | Track template CRUD |
| `POST/PUT/DELETE /teams` | Team CRUD |
| `POST/PUT/DELETE /users` | User CRUD (also requires extra Capsule scope) |

We expose `list_*` and `get_*` for all of the above.

If a future use case has a real need for any of these CRUDs (e.g.
"Claude provisions a new pipeline based on a workshop transcript"),
adding them is straightforward — same pattern as the entity-CRUD
tools.

### Deliberately skipped — not MCP-appropriate

| Endpoint | Why not |
|---|---|
| `/restHooks` (REST Hook CRUD) | Server-to-server webhook configuration. An interactive MCP isn't where you'd configure them, and the lifecycle (subscribe, receive, unsubscribe) doesn't fit the request-response tool model. |
| `/i18n` (Internationalization) | UI metadata for the Capsule web app; nothing for Claude to do with it. |
| `/customtitles` | UI metadata. |

### Genuinely not in Capsule v2

Endpoints documented as Capsule resources but not actually exposed
(or exposed only through indirect paths). Discovered via 404 / 405
during development; documented here so the next person doesn't keep
retrying.

| Wanted | Status | Substitute |
|---|---|---|
| `GET /users/me` (authenticated user) | 404 | `get_site` returns the connected account's name and subdomain. The PAT identity itself isn't queryable. |
| `GET /tasks/deleted` (audit) | 404 | No soft-delete list for tasks. Parties / opportunities / projects do have it. |
| `GET /tracks` (global list) | 405 Method Not Allowed | Tracks are entity-scoped. Use `list_entity_tracks(entity, entityId)` or `show_track(id)`. |
| `GET /entries/{ids}` (batch fetch) | 404 | Capsule v2 doesn't expose a batch fetcher for entries. Parties / opportunities / projects / tasks all do. |
| `POST /attachments/upload` (multipart) | works as raw POST | The doc page suggested multipart at first reading; it's actually a raw-body POST with three custom headers (`Content-Type`, `Content-Length`, `X-Attachment-Filename`). |

### Wrong-path errors and their corrections

A cautionary section for the next contributor: during the v0.5.0
docs crawl I dismissed several endpoints based on 404 responses, and
the 404s were wrong-path errors on my side, not actual API gaps.
Each was fixed in v0.5.1.

| Wrong path I tried | Correct path |
|---|---|
| `GET /opportunities/{id}/additionalparties` | `GET /opportunities/{id}/parties` |
| `GET /opportunities/{id}/projects` | `GET /opportunities/{id}/kases` (legacy term) |
| `GET /<entity>/customfields` | `GET /<entity>/fields/definitions` |

The lesson: when an endpoint that the docs claim exists returns 404,
re-check the docs for the *exact* path before concluding it's
unimplemented.

## Future considerations

Things that might be worth doing but aren't planned. Listed without
commitment.

### F1. Per-user OAuth (multi-tenant deployment)

Solve L1 / L4 by federating identity. Each Claude user goes through
Capsule's OAuth 2 flow once, gets their own Capsule access token,
and the MCP server uses that token for their calls. Audit trails
attribute correctly. Record visibility filters per the user's
Capsule role.

Cost: significantly more state (per-user token store), more refresh
handling, more configuration. Worth it only if capsulemcp is
deployed as a multi-customer service.

### F2. Rate-limit fairness

Add a per-user rate-limit budget on top of Capsule's per-token
limit. Prevents one user from starving others. Probably combines
with F1 since fairness needs identity.

### F3. Reference-data caching

Cache the rarely-changing reference data (teams, lost reasons,
custom field definitions) with a short TTL. Bigger benefit if a
single Claude turn asks many questions that need the same metadata.
Implementation: in-memory map with TTL, invalidated on process
restart. Don't cache anything that changes (parties, opportunities,
entries) — the staleness window is worse than the round-trip.

### F4. Webhook ingest

Capsule emits webhooks for record creation / update / deletion. An
MCP server could ingest these and proactively notify Claude of
changes. Fundamentally different protocol from MCP's tool-call
model — would need a parallel non-MCP component.

### F5. MCP `prompts` capability

Once popular MCP-client UIs surface prompts, expose the EXAMPLES.md
catalogue as discoverable prompt templates so users can pick a
prompt rather than typing one.

### F6. Add-attachment-to-existing-entry

The current `upload_attachment` always creates a new note. To attach
to an existing entry without losing its other attachments, we'd need
to read the entry first, append our token to its `attachments` array,
and PUT the modified entry. Doable; deferred because the new-note
case covers the 80% scenario and the read-then-write dance is
non-trivial to get right (race conditions if two tools attach
concurrently).
