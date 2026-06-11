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

## At a glance

```
                  ┌────────────────────────────────────────────┐
                  │              Claude (the LLM)              │
                  └────────────────────────────────────────────┘
                          │                       │
            MCP / stdio   │                       │   MCP / HTTP + OAuth
            (local pipe)  │                       │   (over TLS)
                          ▼                       ▼
       ┌───────────────────────────┐    ┌───────────────────────────┐
       │ Claude Desktop / Code     │    │ Claude.ai (Custom         │
       │ — runs `npx capsulemcp`   │    │   Connector)              │
       │   as a child process      │    │ — calls a hosted instance │
       └───────────────────────────┘    └───────────────────────────┘
                          │                       │
                          ▼                       ▼
                ┌────────────────┐      ┌────────────────────────────┐
                │ dist/index.js  │      │ dist/http.js               │
                │ (stdio entry)  │      │ (HTTP entry)               │
                │                │      │                            │
                │ no auth layer  │      │ ┌─OAuth / Bearer──────┐    │
                │ — env-var      │      │ │ stateless HMAC-     │    │
                │   token only   │      │ │ signed access +     │    │
                │                │      │ │ refresh tokens      │    │
                │                │      │ │ (1d / 30d TTL)      │    │
                │                │      │ └─────────────────────┘    │
                │                │      │ ┌─express-rate-limit──┐    │
                │                │      │ │ per-client throttle │    │
                │                │      │ └─────────────────────┘    │
                └────────────────┘      └────────────────────────────┘
                          │                       │
                          └───────────┬───────────┘
                                      ▼
                          ┌────────────────────────┐
                          │ src/server.ts          │
                          │   • tool registration  │
                          │   • read-only gate     │
                          │     (CAPSULE_MCP_      │
                          │       READONLY=1)      │
                          │   • confirm-flag gate  │
                          │     on destructive     │
                          │     tools              │
                          └────────────────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │ src/tools/*.ts         │
                          │ (89 tools across the   │
                          │  Capsule resource      │
                          │  graph — see README)   │
                          └────────────────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │ src/capsule/client.ts  │
                          │   • undici fetch       │
                          │   • Bearer token from  │
                          │     CAPSULE_API_TOKEN  │
                          │   • request-timeout    │
                          │   • Link-header        │
                          │     pagination parse   │
                          └────────────────────────┘
                                      │
                                      ▼ HTTPS
                          ┌────────────────────────┐
                          │ api.capsulecrm.com/    │
                          │   api/v2/*             │
                          └────────────────────────┘
```

Single tenant, single Capsule account. Both transports converge on the
same tool surface and the same Capsule client; everything above that
line is transport-specific. Read-only mode gates registration in
`server.ts` so write tools simply don't exist in the catalog when
`CAPSULE_MCP_READONLY=1`. The `confirm: true` gate on destructive
tools is schema-level (Zod `.literal(true)`), enforced before any HTTP
call.

## Architecture assumptions

### A1. Capsule API stability

Everything hinges on these holding for `/api/v2`:

- **Endpoint paths** stay where they are: `/parties`, `/opportunities`,
  `/kases`, `/entries`, `/attachments/{id}`, the structured-filter
  endpoints, etc.
- **Raw API response shape keys** stay where they are: `parties[]`,
  `opportunities[]`, `kases[]`, `entry`, `track`, `lostReasons[]`
  (camelCase). The client boundary normalizes project response keys
  (`kase`/`kases`/`restrictedKases`) to the connector's public
  `project`/`projects`/`restrictedProjects` vocabulary before tool
  handlers return data.
- **Path syntax for batch fetches** (`GET /<entity>/<id1>,<id2>,...`)
  stays the same and stays capped at 10.
- **Pagination contract** (`page`, `perPage`, RFC 5988 `Link` header
  with `rel="next"`) stays consistent. Default page size 50, max 100.
- **Filter-side field naming** (`addedOn`, `updatedOn`,
  `lastContactedOn`) stays distinct from response field naming
  (`createdAt`, `updatedAt`, `lastContactedAt`).

If any of these break, a new major version reshapes the affected tools.
We keep Capsule's path/body quirks explicit at the wire boundary
(`/kases` for projects, `lostReasons` camelCase, etc.) so debugging
against Capsule's docs stays straightforward, while the public tool
surface consistently says "project".

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
rotating the signing key). The 1-day access-token TTL and 30-day
refresh-token TTL bound the window of any individual leak.

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

### L6. Caching is limited to near-static reference data

Most tool calls hit Capsule directly so answers stay live. The
exception is a small set of **reference-data endpoints** (pipelines,
boards, stages, milestones, custom-field schemas, loss reasons,
activity types, categories, goals, teams, users, track definitions,
saved filters, tags, and `get_site`) that get an in-process TTL
cache — see L13 below for the rationale and bounds. Everything else
(reads on parties / opportunities / projects / tasks / entries,
all writes) is uncached on every call. So a Claude turn that hits
mostly the same dictionary endpoints repeatedly costs 1 round trip
per dictionary; a Claude turn that asks ten record-level questions
still makes ten round-trips.

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

The 25 MB ceiling is the *wire* limit, not what an LLM caller can
practically send. `upload_attachment` takes the file inline as
base64 in a tool argument, which means the bytes must transit the
model as generated output: a ~500 KB PDF is ~660K base64 characters
(roughly 165k tokens) — beyond any chat model's output budget and
absurd in cost long before the wire limit matters. In practice,
inline upload through a chat client tops out at a few tens of KB.
The 25 MB cap is real only for *programmatic* MCP clients (n8n,
scripts) that construct the tool call directly. Raising server-side
limits cannot change this, and chunked upload wouldn't either (same
tokens, more calls). The planned remedy is a URL-sourced upload —
see IDEAS.md "URL-sourced attachment upload (`sourceUrl`)".

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

We **do** ship infrastructure for the **MCP `tasks` capability**
(SEP-1686, "call-now, fetch-later") — but it's off by default.
When `MCP_TASKS_ENABLED=1` and an OAuth client_id is present, the
SDK's auto-handlers for `tasks/get`, `tasks/result`, `tasks/list`,
and `tasks/cancel` light up against a per-clientId scoped wrapper
(`src/tasks/store.ts`) around the SDK's `InMemoryTaskStore`, and
the six high-latency `batch_*` write tools opt into optional task
execution. When tasks are disabled, those batch tools register as
ordinary synchronous tools so legacy callers never enter the SDK's
task polling path. The wrapper enforces tenant isolation (a caller
authenticated as client A gets `task not found` for a taskId owned
by client B), plus two DoS caps (`MCP_TASKS_MAX_PER_CLIENT`,
`MCP_TASKS_MAX_TOTAL`).

Notable design choices for this subsystem:

- **In-memory, per-instance.** Mirrors the cache (see §L6). Cloud
  Run scale-to-zero will silently drop in-flight tasks; this is
  documented in DEPLOY.md and acceptable for our workload (batched
  writes complete in ~4–8 s, well under typical instance idle
  time). The SDK's `TaskStore` interface is swap-in; a
  Firestore-backed implementation is sketched in IDEAS.md as the
  future upgrade path if we ever need cross-instance durability.
- **Polling-first.** The MCP `notifications/tasks/status` push
  rides the same SSE stream as `notifications/progress`. Under
  stateless HTTP POST `/mcp` (which we use), the stream closes as
  soon as the original `tools/call` response is returned, so the
  status notification has nowhere to land. Clients must poll
  `tasks/get` — which is exactly what the spec recommends for this
  transport shape anyway. The runner swallows any throw from the
  SDK's post-store notification path so a closed stream doesn't
  crash the void IIFE (see `src/server/register-tool.ts`).
- **Cancellation.** The SDK's `tasks/cancel` handler only flips
  task status to `cancelled` — it does not fire any AbortSignal on
  its own. Our scoped store (`src/tasks/store.ts`) keeps a per-task
  `AbortController` registry; its `updateTaskStatus` override fires
  the controller when status transitions to `cancelled`. The
  runner wires this signal into `batchExecute`, which checks it
  between items so unclaimed slots get a `cancelled` error rather
  than running.

If MCP clients standardise on prompts/resources for richer Claude UX,
adding them would be a future change.

### L11. Capsule error bodies pass through verbatim

When Capsule returns 4xx / 5xx, the connector parses the response
body and includes the message in the `CapsuleApiError` thrown to the
tool layer. Validation errors carry `resource` / `field` / `message`
fields; auth and server errors carry a `message`. We don't sanitise
the content before surfacing it — partly because validation messages
need to be operator-readable (the whole point is to give the caller
something they can act on), partly because Capsule's error format
isn't structured enough to safely strip "data" from "schema".

Where this matters: error messages can echo user-supplied content
back to the caller. A Capsule tenant who can write `<script>` into a
custom-field label, or set up a party name that the connector then
fails to update with a 422, will see that label in the error message
the MCP client receives. The stdio transport surfaces the message
directly in the tool response; the HTTP transport logs to stderr and
returns a low-cardinality summary (the `MCP_HTTP_DEBUG=1` env opts
into the verbose form), so the exposure surface differs.

The trust boundary here is the same as L1: data inside a single
Capsule account is treated as coming from one party. Operators with
adversarial-tenant scenarios — multi-tenant Capsule accounts where
one user's input shouldn't be seen by another — should know that
error paths are part of the data passthrough, not just the success
path. Sanitisation is a candidate for a future minor.

### L12. Authorization-code state is in-process

The OAuth provider keeps issued-but-not-yet-redeemed authorization
codes in a `Map` on the provider instance. The code's PKCE
verifier, requested scopes, redirect URI, and resource URL all live
there until `/token` consumes them. Access and refresh tokens are
stateless (HMAC-signed) and replicate freely; authorization codes
do not.

This matters when the same HTTP deployment runs more than one
instance and inbound requests aren't sticky to one of them. The
realistic failure mode is short-lived: `/authorize` on instance A,
then `/token` on instance B within the seconds-long window between
the redirect and the exchange — instance B has never seen the code
and returns `invalid_grant`. Cloud Run gives single-instance
session affinity within that window by default, which is why the
worked example in DEPLOY.md doesn't hit this. Multi-region or
load-balanced deployments that round-robin across pods need to
either enable sticky sessions or scale the connector vertically
(`min_instance_count=max_instance_count=1`) until a future minor
moves auth-code state into a shared store.

### L13. Reference-data cache is per-instance, TTL-bounded

Sixteen reference-data endpoints (the dictionaries: pipelines,
milestones, boards, stages, custom-field schemas, loss reasons,
activity types, categories, goals, teams, users, track definitions,
saved filters, tags, and `get_site`) are cached in a per-process
`Map` with a TTL. Two orthogonal knobs:

- `CAPSULE_MCP_CACHE_DISABLED=1` — explicit on/off (default
  unset → cache enabled). Canonical opt-out, useful for debugging
  "is this stale?" questions or when running behind another cache
  layer.
- `CAPSULE_MCP_CACHE_TTL_MS` — entry lifetime when cache is
  enabled (default 300000 = 5 minutes). Setting to `0` is also
  honoured as a back-compat shortcut for "disable entirely".

Source: `src/capsule/cache.ts`.

Why this is here and not just "always cache":

- The 16 tools are admin-configured / user-managed-but-stable. They
  routinely get called multiple times per Claude turn so the LLM can
  discover ids before each `create_*` / `update_*` / `filter_*`. A
  short TTL turns repeated lookups into one round trip per dictionary,
  per instance, per TTL window. Measured: 30–50% fewer Capsule calls
  on write-heavy conversational flows.
- Record-level reads (parties, opportunities, projects, tasks,
  entries) are **not** cached. Those are the data that actually
  changes during a conversation; caching them would surface stale
  records to the user.

Trade-offs:

- **Staleness window**: an admin edit to (say) pipelines isn't
  visible to the connector for up to TTL milliseconds. Bounded by
  the env knob; conservative default of 5 minutes.
- **Per-instance only**: Cloud Run instances don't share a cache.
  Worst-case staleness across N instances is still TTL (not
  TTL×N), but cache hit rates aren't shared either, so N instances
  each warm the cache independently.
- **Tag mutation invalidation**: the connector's `add_tag` and
  `remove_tag_by_id` calls drop the cached `list_tags` entry for
  the affected entity type before returning. The catalogue is
  always coherent within a single client conversation. Other
  cached endpoints have no write-side counterpart in our tool
  surface, so no invalidation is wired for them — staleness there
  is TTL-bounded only.

`get_current_user` is **not** cached — it's the "who am I"
diagnostic and would otherwise lag a token rotation.

**Observability**: `CAPSULE_MCP_LOG_VERBOSE=1` emits structured JSON
events to stderr for every `cache.hit` / `cache.miss` /
`cache.invalidate` / `cache.evict`. Cloud Run parses these into
`jsonPayload` fields for retroactive analysis (hit-rate computation,
miss-reason breakdown, cap-pressure detection). Off by default — log
volume is real. See OPTIMIZATIONS.md "Method B" for the canonical
gcloud-logging recipes.

## Endpoint coverage

A complete index of Capsule v2 endpoints, grouped by what we do with
each. Last verified against
<https://developer.capsulecrm.com/v2/operations>.

### Implemented

Every Capsule v2 endpoint that returns useful data, modulo the gaps
listed below. Specifically:

- All read endpoints on Party, Opportunity, Project, Task, Entry
  (including connector-level batch fetches up to 50 ids for parties,
  opportunities, projects, and tasks; entries remain single-fetch
  only — see "Genuinely not in Capsule v2" below)
- All structured-filter endpoints (parties / opportunities / projects,
  with projects mapped to Capsule's `/kases` path)
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
| `GET /tasks/deleted` (audit) | 404 | No soft-delete list for tasks. Parties / opportunities / projects do have it. |
| `GET /tracks` (global list) | 405 Method Not Allowed | Tracks are entity-scoped. Use `list_entity_tracks(entity, entityId)` or `get_track(id)`. |
| `GET /entries/{ids}` (batch fetch) | 404 | Capsule v2 doesn't expose a batch fetcher for entries. Parties / opportunities / projects / tasks all do. |
| `POST /attachments/upload` (multipart) | works as raw POST | The doc page suggested multipart at first reading; it's actually a raw-body POST with three custom headers (`Content-Type`, `Content-Length`, `X-Attachment-Filename`). |

For the catalogue of Capsule API quirks — including the cases where
a wrong-path probe led us to claim an endpoint didn't exist when it
actually did — see [NOTES-ON-CAPSULE-API.md](NOTES-ON-CAPSULE-API.md).
Each quirk there carries a verbatim quote from Capsule's official docs
and a pointer to where in our code we encode the resolution.

### Wrong-path errors and their corrections

A cautionary section for the next contributor: during early
development I dismissed several endpoints based on 404 responses,
and the 404s were wrong-path errors on my side, not actual API
gaps. The corrections are now part of the live code; the table
stays as a reminder.

| Wrong path I tried | Correct path |
|---|---|
| `GET /opportunities/{id}/additionalparties` | `GET /opportunities/{id}/parties` |
| `GET /opportunities/{id}/projects` | `GET /opportunities/{id}/kases` (legacy term) |
| `GET /<entity>/customfields` | `GET /<entity>/fields/definitions` |
| `GET /users/me` | `GET /users/current` (now wired as `get_current_user`) |

The lesson: when an endpoint that the docs claim exists returns 404,
re-check the docs for the *exact* path before concluding it's
unimplemented.

## Future considerations

Ideas for features that go beyond the existing surface — per-user
OAuth, caching, larger attachment caps, the MCP `prompts` capability,
etc. — live in [IDEAS.md](IDEAS.md). They're listed there without
commitment.
