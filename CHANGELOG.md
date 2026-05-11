# Changelog

All notable changes to capsulemcp.

The full release notes for each tagged version live on GitHub:
<https://github.com/soil-dev/capsulemcp/releases>. This file mirrors the
high-level summary so it's discoverable from the repo and on npm.

The format follows [Keep a Changelog](https://keepachangelog.com), and
versions adhere to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- `add_additional_party` is now actually idempotent. Tool description
  has claimed *"Idempotent — re-adding a linked party is harmless"*
  since v0.x, but Capsule's API responds with `422 party is already
  a contact for this opportunity` (or `... already related to this
  opportunity` if the target is the entity's main party) on a
  re-add. The handler now catches those two specific 422 messages
  and converts them to a success-shape result with the new
  `alreadyLinked: true` flag, so callers can re-add freely without
  arming their own retry-on-422 logic. Other 422s (validation
  failures unrelated to existing links) and all other error classes
  surface unchanged. Closes Bug 10 from the production write-mode
  bug-report (sections 5–10).

### Changed

- `delete_party` description now lists projects (kases) in the
  cascade and documents that deleting an ORGANISATION does NOT
  cascade-delete people linked to it via `organisationId` — those
  people survive as standalone records with their `organisation`
  field silently cleared to null. Caller-facing surprise eliminated
  for both common audit-trail and "what did I just delete" cases.
- `upload_attachment` schema descriptions now state the **25 MB
  per-attachment Capsule limit** explicitly, note the connector's
  ~35 MB inbound body budget (which leaves room for the base64
  expansion of a 25 MB binary), and warn that Capsule does NOT
  cross-check `filename` / `contentType` / actual-bytes consistency:
  a typo in either is accepted and the file is stored as labelled.

## [1.0.0-alpha.8] — 2026-05-11

Two follow-up commits on top of alpha.7, both surfaced by
continued production write-mode testing.

> **Bug 9 (alpha.7) — `remove_party_*_by_id` tools were
> non-functional.** All four atomic-remove tools shipped in
> alpha.7 sent `{id, _destroy: true}` (Rails convention) but
> Capsule's v2 API spells the flag `_delete: true`. Capsule
> silently ignored the destroy and returned 200 OK with the row
> still present. Anyone who used the remove tools on alpha.7
> believes they removed rows that are still there — worth a quick
> audit of any party touched via those tools (read the party,
> compare the current child-array state to expectations). Fixed
> in this alpha; verified via the updated unit tests.

### Added

- `update_opportunity.lostReasonId` (optional). Closes Bug 8 from
  the production write-mode bug report (sections 5–8): connector
  had no way to set the lost reason, so every connector-driven
  Lost-close left `lostReason: null` on the record. Discover
  reason IDs via the existing `list_lostreasons` tool. Capsule
  silently drops `lostReason` on non-Lost milestones, so it's safe
  to include on any update; only meaningful when closing to Lost.
- `add_note.entryAt` (optional ISO-8601 timestamp). Backdating
  support for historical-note imports (migrating from another CRM)
  and for logging meetings that happened earlier. Capsule preserves
  `entryAt` across subsequent `update_entry` calls — only
  `updatedAt` advances on edits. Schema validates the ISO-8601
  format pre-call.
- `add_note.creatorId` (optional user ID). On-behalf-of authoring:
  log a note attributed to a specific Capsule user rather than the
  API-token owner. Discover via `list_users`.

### Changed

- `update_opportunity.milestoneId` description rewritten to
  document the closing-milestone side effects (auto-set `closedOn`
  and `probability` to the milestone default; preserve
  `lastOpenMilestone`; symmetric reverse on reopen) AND to warn
  about cross-pipeline relocation: Capsule does NOT validate that
  the new milestone belongs to the opportunity's current pipeline,
  so passing a cross-pipeline ID silently relocates the opportunity
  and may leave `lastOpenMilestone` referencing a milestone in the
  previous pipeline. Closes Bug 6.
- `update_project.stageId` description gains the same
  cross-board-relocation warning: Capsule does not validate that
  the new stage belongs to the project's current board; team and
  other board-derived defaults are NOT updated to match the new
  board. Closes Bug 7.
- `create_opportunity.milestoneId` description now states
  explicitly that the milestone implicitly determines the pipeline
  (no separate `pipelineId` parameter).
- `update_opportunity` tool description notes that closed (Won /
  Lost) opportunities remain fully editable — Capsule does not
  enforce closed-record immutability. Same note on `update_project`
  for CLOSED projects.
- `add_note.content` description now states the content is treated
  as MARKDOWN (Capsule's web UI renders the markdown when
  displaying). Pass markdown source, not HTML.
- `update_entry.subject` description warns that on plain notes
  Capsule accepts the call (advances `updatedAt`) but doesn't store
  the subject — confusing if `updatedAt` is being used as a "last
  meaningful change" signal. Notes preserve `entryAt` across edits;
  use `entryAt` for "when did this happen" and `updatedAt` for
  "last touched".

### Fixed

- `remove_party_email_address_by_id`,
  `remove_party_phone_number_by_id`,
  `remove_party_address_by_id`, and
  `remove_party_website_by_id` were silently failing to remove
  rows in v1.0.0-alpha.7. Each tool sent a PUT with
  `{id, _destroy: true}` (the Rails-style field name), which
  Capsule silently ignores — the response was 200 OK with the row
  still present. The correct field name is `_delete: true` (Capsule
  uses Rails-ish `_<verb>` shape but spells it `_delete`, not
  `_destroy`). All four handlers now send `{id, _delete: true}`,
  and the unit tests' body-shape assertions are updated. The
  regression was caught by a production write-mode verification
  run against the alpha.7 deploy (Bug 9 in the verification
  report). Documented as `NOTES-ON-CAPSULE-API.md` §18 so the
  same trap doesn't catch the next person.

## [1.0.0-alpha.7] — 2026-05-10

Combines the previously-tagged-but-never-deployed alpha.6
(`/mcp` pre-auth DoS hardening, #9) with PR #10 (MCP standards
compliance — RFC 8707 resource indicators, Origin guard,
MCP-Protocol-Version guard, SDK 1.12 → 1.29) and the production
write-mode bug-report fixes (schema tightening + 8 new atomic
child-array tools).

> **Token-invalidation on deploy.** With PR #10 in, the OAuth
> provider now binds tokens to `<PUBLIC_BASE_URL>/mcp` via the
> `resource` claim. Tokens issued by earlier alphas don't carry
> the claim and will be rejected immediately after this deploy
> rolls. Anthropic's connector silently re-runs the OAuth dance
> once; users see no UI change. Effectively a forced rotation,
> equivalent to a `MCP_OAUTH_SIGNING_KEY` rotation.

### Added

- 8 new atomic child-array tools on parties, giving callers
  surgical control over the `emailAddresses`, `phoneNumbers`,
  `addresses`, and `websites` lists without the surprises of the
  bulk-array path on `update_party` (which is append-only by
  Capsule's PUT semantics):
  - `add_party_email_address`, `remove_party_email_address_by_id`
  - `add_party_phone_number`, `remove_party_phone_number_by_id`
  - `add_party_address`, `remove_party_address_by_id`
  - `add_party_website`, `remove_party_website_by_id`
  Each tool issues exactly one PUT to `/parties/{id}` with a single
  item — adds carry no `id`/`_delete` (Capsule appends), removes
  carry `{id, _delete: true}` (Capsule removes that specific row).
  *(As shipped in alpha.7 the remove tools sent `_destroy: true`
  instead, which Capsule silently ignores — fixed in the followup
  commit; see the Unreleased / Fixed entry above.)*
  No GET-then-PUT diff, no value-matching heuristic, no race
  window where concurrent edits could be silently dropped.
  "Replace one email" decomposes into
  `remove_party_email_address_by_id` + `add_party_email_address` —
  two atomic ops, both observable.
  Discover row IDs via the existing `get_party` tool (each entry
  in the child arrays carries its own `id`).
  Removes do NOT require `confirm: true` — losing one email row is
  reversible (re-add the value); only whole-record deletes
  (`delete_party`, `delete_opportunity`, ...) carry the confirm
  gate.
  Tool count goes 71 → 79; read-only count stays at 49 (these are
  all writes).

### Changed

- `update_party` description rewritten to point callers at the new
  atomic tools for surgical changes. The bulk arrays on
  `update_party` are kept for callers who want to add multiple
  items in a single round-trip; their descriptions explain the
  APPEND-ONLY semantic and link to the matching atomic tool by
  name (e.g. emailAddresses → "use add_party_email_address /
  remove_party_email_address_by_id").

### Fixed

- `update_party` (and `create_party`) child-array tools now
  document the append-only semantics. Capsule's `PUT /parties/{id}`
  treats `emailAddresses`, `phoneNumbers`, `addresses`, and
  `websites` as merge-not-replace: every item in the array is added
  on top of the existing list. Passing the same item twice creates
  a duplicate; passing `[]` is a silent no-op (does not clear and
  does not advance `updatedAt`). Removal requires Capsule's
  `_delete: true` shape, which this connector does not yet expose.
  The schema descriptions on each of the four arrays now state this
  explicitly so callers don't expect "set" semantics that don't
  exist. (Caller-facing fix only; the underlying behaviour is
  Capsule's. A real "replace" path will need either a
  `replaceArrays: true` opt-in flag, or dedicated add/remove tools.)
- `websites.service` is now a zod enum with Capsule's full set:
  `URL, SKYPE, TWITTER, LINKED_IN, FACEBOOK, XING, FEED,
  GOOGLE_PLUS, FLICKR, GITHUB, YOUTUBE, INSTAGRAM, PINTEREST,
  TIKTOK, THREADS, BLUESKY, SNAPCHAT`. Previously a free-form
  string, so typos like `PIGEON_POST` made it all the way to
  Capsule before being rejected with 422. Caught in production
  write-mode testing.
- `phoneNumbers[].number` rejects empty strings at the schema
  layer (`min(1)`), matching `emailAddresses[].address` behaviour.
  Capsule rejects `""` with `phoneNumber.number: number is
  required`; now caught pre-call.
- Task status enums in `update_task` and `list_tasks` no longer
  expose `PENDING`. Capsule rejects direct sets with `cannot set
  task status to PENDING` (the status is internal to the track
  machinery; only `OPEN` and `COMPLETED` are settable). The
  `update_task.status` description explains this and notes that
  setting `OPEN` on an already-open task is a true no-op.

### Changed

- `create_party` description rewritten to explain the silently-dropped
  cross-type fields: for `type='person'`, `name` is ignored
  (firstName/lastName are used); for `type='organisation'`,
  firstName/lastName/title/jobTitle are ignored (`name` is used).
  Also documents the misleading 404 when `organisationId` points
  at a non-organisation party (Capsule filters lookups by type).
- `update_opportunity.probability` description now warns that it
  cannot be set in the same call as a closing milestone (Won/Lost):
  Capsule processes the milestone change first, the opportunity
  becomes closed, then the probability update is rejected with 422
  `probability can be updated only for open opportunity`. To close,
  leave `probability` out — it auto-snaps to 100% (Won) / 0%
  (Lost). On open milestones, `probability` is a true override of
  the milestone default.

3 new regression tests (websites.service enum, phoneNumber.number
empty-string rejection, task-status PENDING rejection). 254 → 257
tests.

## [1.0.0-alpha.6] — 2026-05-10

### Security

- Authenticate `/mcp` requests **before** parsing the JSON body
  (#9). The 35 MB JSON body parser was previously installed as
  global middleware, which meant any unauthenticated caller could
  POST a 35 MB `Content-Type: application/json` body to `/mcp` and
  make Express buffer + parse it before bearer auth could reject
  the request. That's free DoS leverage. The parser now lives on
  the `POST /mcp` route chain, **after** `requireBearerAuth`, so
  malformed or oversized unauthenticated bodies get a 401
  immediately without any parsing work. The OAuth endpoints
  (`/authorize`, `/token`, `/register`) keep working because the
  MCP SDK installs its own per-endpoint parsers with default
  ~100 KB limits — those are unaffected. Regression test asserts
  POST /mcp with a malformed body and no bearer returns 401 (proves
  the parser doesn't run pre-auth — would otherwise return 400).

## [1.0.0-alpha.5] — 2026-05-10

### Fixed

- 429 retry now honours Capsule's actual rate-limit reset signal.
  Capsule does NOT use the standard `Retry-After` header — its
  response carries `X-RateLimit-Reset` (UTC epoch seconds) instead.
  Our retry path was reading `Retry-After` only, falling back to a
  5-second default on every 429 (since Capsule never sent it),
  which meant we'd hit Capsule again with an empty hourly quota
  and 429 immediately. New `parseRateLimitDelay()` reads
  `X-RateLimit-Reset` first, `Retry-After` second, defaults to 5s.
  Still clamped at 60s so a far-future reset (Capsule's bucket is
  hourly — reset can be 50 minutes out) doesn't block a Cloud Run
  request indefinitely. Added 4 regression tests covering the
  Capsule-specific path, header precedence, future-clamp, and
  past-reset edge cases. Documented as
  `NOTES-ON-CAPSULE-API.md` §17.

## [1.0.0-alpha.4] — 2026-05-10

### Added

- `create_project` and `update_project` now accept an optional
  `stageId` parameter. Capsule projects (kases) live on Boards with
  Stages (board columns); without this, every project created via
  the connector landed unassigned to any board, and there was no
  way to move a project across its lifecycle stages — which is most
  of what projects are for in the CRM. The body field name on the
  Capsule side is `stage: <integer>` (per Capsule's docs); the
  user-facing parameter follows our `<resource>Id` convention to
  match `partyId` / `ownerId`. Discover stage IDs via the existing
  `list_stages` tool.

  Stage implies board (each stage belongs to exactly one Board), so
  the schema deliberately exposes only `stageId` and not a separate
  `boardId` — picking the stage already picks the board. Caught by
  the same production write-mode dry run that surfaced the
  websites schema bug.

## [1.0.0-alpha.3] — 2026-05-10

### Fixed

- `create_party` / `update_party`: the `websites` schema declared
  the address field as `url` (with `format: "uri"`, required). Capsule
  rejects that with `422 website.address: address is required` — the
  v2 API names it `address` regardless of service type, because the
  value can be a URL (`service: "URL"`), a Twitter handle
  (`service: "TWITTER"`, e.g. `@anton`), an Instagram handle, etc.
  URL-validation here would also reject those non-URL values. Renamed
  the schema field `url` → `address`, dropped the `.url()` validator
  (a string is correct), and added regression tests that lock both
  the new name and the old shape's rejection. Caught by a production
  write-mode test against OpenSSL Corp's Capsule.

### Changed

- `complete_task` description rewritten from "Mark a task as
  completed." (4 words, search-poor) to a longer form that surfaces
  via tool_search for queries like "mark task done", "finish task",
  "complete task". Functionally unchanged. Caught in the same
  production write-mode test — `tool_search` was returning
  `update_task`/`delete_task`/`create_task` for "task done" but not
  `complete_task`, so the tool was effectively undiscoverable.

## [1.0.0-alpha.2] — 2026-05-10

### Fixed

- Container failed to start on `node:20-slim`: undici 8.2.0 calls
  `webidl.util.markAsUncloneable` (used by its `CacheStorage`
  initializer), which only exists in Node ≥ 22. Bumped the runtime
  base image to `node:22-slim`, the tsup target to `node22`, and
  the `package.json` engines field to `>=22`. Caught by the
  `v1.0.0-alpha.1` deploy on Cloud Run — local dev was on Node 24
  so the issue never showed up in tests or the build. Exactly the
  class of bug a dry-run pre-release exists to catch.

## [1.0.0-alpha.1] — 2026-05-10

First pre-release candidate for v1.0.0. Tagged for dry-run testing
before the final tag. Identical content to what would otherwise be
v1.0.0; release notes are listed below.

### Stats

- 71 tools (49 in read-only mode). 236/236 tests passing across
  26 test files.

### Added

- `get_current_user` tool wraps `GET /users/current`. Earlier
  releases claimed (in DESIGN.md) that Capsule v2 had no
  authenticated-user endpoint and substituted `get_site` — that
  was a wrong-path error. The endpoint is `/users/current`, not
  the GitHub-style `/users/me`. Returns the user owning the PAT
  this connector is using; useful for audit and for confirming a
  token rotation moved ownership to the expected account.
- `NOTES-ON-CAPSULE-API.md` — reference doc cataloguing 16
  Capsule v2 quirks discovered during development, each with a
  verbatim quote from the relevant Capsule doc page (so the
  reference is a snapshot if Capsule's docs ever change). Linked
  from the README pointer table.

### Fixed

- `add_additional_party` was crashing with
  `SyntaxError: Unexpected end of JSON input` because Capsule
  returns 204 No Content on the link endpoint
  (`POST /<entity>/{id}/parties/{partyId}`) and `capsulePost` always
  called `res.json()`. New `capsulePostNoContent` helper handles the
  empty-body case; the tool now returns a synthetic
  `{linked: true, ...}` summary instead. Caught during the v1.0.0
  wire-trace.
- `apply_track` was sending `{trackDefinition: {id}}` in the request
  body, which Capsule rejects with 422 "track definition is required;
  field=definition". The correct field name is `definition`. The GET
  response uses `trackDefinition`, but the POST body uses
  `definition` — a Capsule API asymmetry. Verified live during the
  v1.0.0 functional sweep; sent + verified the fix end-to-end.
- `get_attachment` was comparing Content-Type with `===
  "application/json"`, which missed `application/json; charset=UTF-8`
  (a real shape Capsule returns). Now strips Content-Type parameters
  before comparing — JSON / XML / text-typed attachments correctly
  return decoded text instead of falling through to base64.
- `list_tasks` description claimed an "or due date" filter that
  didn't exist in the schema. Description rewritten to match the
  actual filters (status + ownerId).
- `OpportunityValueSchema.currency` was optional in zod but Capsule
  rejects `{amount}` without a currency (422). Currency is now
  required at the schema layer so the error surfaces before the HTTP
  call.
- `upload_attachment` silently accepted invalid base64 input
  (Node's tolerant decoder produced corrupt bytes that Capsule then
  stored). Now validates the input matches the base64 alphabet and
  has a length divisible by 4 before uploading.
- Reference-data tools (`list_teams`, `list_lostreasons`,
  `list_activitytypes`, `list_track_definitions`, `list_categories`,
  `list_goals`, `list_users`, `list_pipelines`, `list_milestones`,
  `list_boards`, `list_stages`, `list_tags`) now accept optional
  `page` / `perPage` and surface `nextPage` from the Link header.
  Default `perPage=100` (Capsule's max) so small accounts still get
  everything in one call. Previously a 51-team account would have
  silently capped at Capsule's 50-record default page size.
- HTTP transport: `app.set("trust proxy", 1)` is set before the
  SDK's `mcpAuthRouter`. Without it, `express-rate-limit` (used
  internally by the auth router on `/authorize`, `/token`, and
  `/register`) treats Cloud Run's `X-Forwarded-For` as a
  misconfiguration and can fail OAuth requests in any
  ingress-fronted deployment. Configurable via the `trustProxy`
  option on `createApp` for multi-hop setups. (Issue #4.)
- HTTP transport: protected-resource metadata is now published at
  the RFC 9728 path-suffixed location keyed on the actual MCP
  resource (`/.well-known/oauth-protected-resource/mcp`), not the
  bare `/.well-known/oauth-protected-resource`. The `/mcp` 401
  response also includes `resource_metadata=…` in
  `WWW-Authenticate` so generic OAuth/MCP clients can discover the
  metadata without baked-in knowledge of the server layout.
  (Issue #5.)
- HTTP transport: `resolveBaseConfig` and `selectMode` now validate
  env up front. `PUBLIC_BASE_URL` must parse as a URL and use
  `https://` (or `http://` on localhost / 127.0.0.1 / ::1) — every
  other scheme, including schemeless `localhost:3000`, is rejected
  at startup. Each `MCP_OAUTH_REDIRECT_URIS` entry is validated
  with `URL.canParse`. `PORT` must be an integer in 1..65535. Bad
  values produce clear startup errors instead of late stack traces
  or broken OAuth metadata. (Issues #6 + #7.)
- **Pre-1.0 security audit hardening (one pass over every line of
  the HTTP / OAuth / Capsule-client surface):**
  - `/mcp` 500 responses no longer echo the caught error message
    to the client. The full error is logged to stderr; the body
    is now `{"error":"internal_error"}` only. Closes a future
    leakage path where a Capsule API error body could surface
    upstream content into authenticated MCP responses.
  - OAuth refresh-token TTL shortened from 365 days to 30 days;
    access-token TTL shortened from 30 days to 1 day. Tokens are
    stateless HMAC blobs (no per-token revocation by design — Cloud
    Run instances must come and go without sharing state); the
    kill switch for a compromised token is rotating
    `MCP_OAUTH_SIGNING_KEY`, which invalidates EVERY outstanding
    token at once. The shorter window bounds the leak window.
  - In-memory authorization-code map is now hard-capped at 10 000
    entries (oldest dropped) and swept by a 60-second
    `setInterval` (in addition to the per-issue sweep), so a
    sustained `/authorize` flood that never proceeds to `/token`
    cannot exhaust process memory. The GC timer is `unref()`ed so
    it doesn't keep the event loop alive.
  - `MCP_OAUTH_INSECURE_AUTO_APPROVE` is now refused at startup
    when `PUBLIC_BASE_URL` is not a loopback host, unless the
    operator explicitly sets `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes`.
    Open DCR + auto-approve was always documented as
    "private-network only" — now the runtime enforces it.
  - `CAPSULE_API_BASE_URL` overrides are now validated at first
    use: must be a parseable URL, must be `https://` (or `http://`
    on loopback). A typo'd or hostile env value previously sent
    the bearer token in the `Authorization` header to the
    misconfigured origin; now the override is rejected with a
    clear error and no HTTP call is made.
  - Attachment download (`get_attachment`) now caps the response
    BEFORE buffering the bytes. The `maxBytes` limit is plumbed
    into `capsuleGetBinary`, which (1) refuses to read the body
    at all if `Content-Length` exceeds the cap and (2) aborts
    streaming once accumulated bytes pass the cap. Previously
    `arrayBuffer()` consumed the full response before the size
    check ran — a malicious or buggy upstream sending 5 GB into
    a 5 MB cap would have buffered the lot.
  - Dead `FixedClientStore.verifyClientSecret` removed. The MCP
    SDK's auth router compares secrets internally; our
    constant-time helper was never wired in. The misleading
    "defence-in-depth" comment is gone with it.

### Changed

- HTTP entry's inbound JSON body limit defaulted to 1 MB; bumped to
  35 MB so `upload_attachment` can carry up to a 25 MB attachment
  base64-encoded. Override via `MCP_HTTP_JSON_LIMIT`.
- `list_tasks` now actually defaults `status` to `"OPEN"` — the
  description had said so since v0.1 but the code passed `undefined`
  and let Capsule pick.
- `create_project` now applies its `OPEN` status default in code
  (`?? "OPEN"`) instead of via zod's `.default()`, matching the
  pattern adopted for `list_tasks`. The output type stays
  consistent for direct callers.
- README description rewritten to reflect the v0.5.x and v0.6.0
  surface (attachments, tracks, saved filters, audit, batch fetches).
- `package.json` description and keywords filled out for npm /
  registry discoverability.
- HOWTO.md test count refreshed to match the current suite.
- tsup builds index.js and http.js as separate configs so the shebang
  banner only lands on the stdio entry. http.js is now invoked as
  `node dist/http.js` without the noise.
- HTTP entry's mode-selection and base-config validation extracted to
  `src/http/config.ts` with pure functions, unit-tested.
- Repository moved from `arapov/capsulemcp` to `soil-dev/capsulemcp`
  (org-owned). GitHub redirects keep the old URL working; in-repo
  references all point at the new canonical location.

### Added

- `tests/http-config.test.ts` covers `selectMode` and
  `resolveBaseConfig` across all expected env permutations.
- Pagination tests for the reference-data tools.
- Base64-validation regression tests for `upload_attachment`.
- `capsulePostNoContent` client helper for 204-returning POSTs
  (currently used only by `add_additional_party`; available for
  any future endpoint with the same shape).
- `scripts/wire-trace.ts` — pre-1.0 verification harness that
  invokes every write-side tool function against the live API,
  observes the actual HTTP requests our code emits via undici's
  diagnostic_channel, and cleans up. Caught two production bugs
  (`apply_track` field name, `add_additional_party` 204 handling)
  that mock-only tests would have missed. Documented in HOWTO.md.
- `tests/mcp-integration.test.ts` — drives a real `McpServer`
  through the MCP wire protocol via the SDK's in-memory transport
  pair, with `undici.fetch` mocked. Verifies tool name registration,
  read-only-mode gating, schema-validation propagation, error
  responses for unregistered tools, and the `get_attachment`
  content-type routing logic that lives in `server.ts` (not in
  the tool function).
- The stale `scripts/live-smoke.ts` was removed —
  `scripts/wire-trace.ts` covers everything it did and more (every
  write tool, including v0.4–v0.6 additions).
- HTTP-app factory extracted to `src/http/app.ts` (mirrors the
  earlier `src/http/config.ts` extraction). `src/http.ts` is now a
  thin entry that resolves config, builds the OAuth provider,
  invokes `createApp`, and listens.
- `tests/rate-limit.test.ts` (7 tests): retry-on-429 with both
  integer-seconds and HTTP-date Retry-After headers, infinite-loop
  prevention (gives up after one retry), 5-second default when
  Retry-After is missing, 60-second clamp on absurdly large values,
  pass-through of non-429 errors, no retry on 401.
- `tests/http-app.test.ts` (16 tests): `/.well-known/*` metadata
  shapes, DCR disabled in static-client mode (`POST /register` →
  404), bearer-required gates on `/mcp` (401 without bearer, 401 on
  forged token, 405 on GET/DELETE with valid bearer), `/authorize`
  redirect with code (and rejection for wrong client_id), `/token`
  invalid_client on wrong secret, icon endpoint content-type and
  cache headers.
- `tests/stdio-entry.test.ts` (4 tests): smoke for the npx-installed
  binary. Spawns `dist/index.js` as a child process, walks the
  initialize handshake, calls `tools/list`, asserts the
  read-only-mode catalogue. Catches regressions in the post-build
  bundle that no other test layer would see.
- `assets/icon.svg` is now genuinely the canonical source. New
  `scripts/build-icon.mjs` regenerates `src/icon.ts` from the SVG;
  `npm run build` chains it. The generated file carries a
  "do-not-edit" header. New `tests/icon-source.test.ts` fails CI if
  the SVG and TypeScript drift apart, so the hand-sync hazard is
  closed (briefly removed in an earlier commit, now restored
  properly).
- `AutoApproveOAuthProvider` removed entirely. It was a v0.2.0-era
  alias for `new OAuthProvider({clientsStore: new
  InMemoryClientsStore(), signingKey})`; with no external consumers
  yet (capsulemcp is a new project that pre-1.0 had no API
  stability promise), there's nothing to maintain compatibility
  with. Tests migrated to construct `OAuthProvider` directly via a
  small `autoApproveProvider()` helper.
- `MCP_SHARED_SECRET` env-var fallback for `MCP_OAUTH_SIGNING_KEY`
  removed. It was carrying compatibility for v0.1.0-era deployments
  that don't exist outside of OpenSSL's (which already migrated to
  `MCP_OAUTH_SIGNING_KEY` long ago). Error message and DEPLOY.md
  table updated to drop the fallback reference.
- Dependency bumps via Dependabot security advisories:
  `express-rate-limit` 8.5.0 → 8.5.1, transitive `ip-address`
  10.1.0 → 10.2.0 (PR #1); `esbuild` 0.21 → 0.27/0.28 and `vitest`
  2.1 → 4.1.5 (PR #3, superseding the redundant PR #2).

Suite now 227/227 passing across 25 test files.

## [0.6.0] — 2026-05-10

### Added

- `get_attachment(id, maxSizeBytes?)` — download attachments. Returns
  MCP image content for `image/*` types (Claude can describe them
  natively); decoded text for `text/*` / `application/json` /
  `application/xml`; JSON metadata + base64 payload for other
  binaries. Files exceeding `maxSizeBytes` (default 5 MB, max 25 MB)
  return metadata only with `truncated: true`.
- `upload_attachment(filename, contentType, dataBase64, content?,
  partyId? | opportunityId? | projectId?)` — orchestrates Capsule's
  two-step upload-then-attach flow into a single tool call. Subject
  to `CAPSULE_MCP_READONLY` like other writes.
- `capsuleGetBinary` and `capsulePostBinary` client helpers.

### Notes

- Capsule's upload endpoint is **not** multipart — it's a raw POST
  with the file as the request body and three required headers
  (`Content-Type`, `Content-Length`, `X-Attachment-Filename`). The
  client helpers handle this wire format.
- Adding an attachment to an existing entry isn't supported in this
  release; `upload_attachment` always creates a new note.

### Stats

- 70 tools (48 in read-only mode). 145/145 tests passing.

## [0.5.2] — 2026-05-09

### Added

- `get_task(id)` — solo task fetch (filled the symmetry gap with
  `get_party` / `get_opportunity` / `get_project`).
- Batch fetchers (Capsule caps at 10 ids per call):
  `get_parties(ids)`, `get_opportunities(ids)`, `get_projects(ids)`,
  `get_tasks(ids)`.

### Notes

- Capsule v2 does not expose `GET /entries/{ids}` (returns 404), so
  no `get_entries` companion is added.

### Stats

- 68 tools (47 in read-only mode). 137/137 tests passing.

## [0.5.1] — 2026-05-09

A patch release filling endpoint coverage that should have been in
v0.5.0 but was dismissed during the docs crawl due to wrong-path
errors:

- `GET /opportunities/{id}/parties` (additional parties) — earlier
  tried `/additionalparties`.
- `GET /opportunities/{id}/kases` (associated projects) — earlier
  tried `/projects`.
- `GET /<entity>/fields/definitions` (custom field schema) — earlier
  tried `/customfields`.
- `GET /<entity>/{id}/tracks` and `GET /tracks/{id}` — earlier saw
  `GET /tracks` (global) return 405 and gave up too early; tracks
  are entity-scoped only.

### Added

- `list_additional_parties`, `add_additional_party`,
  `remove_additional_party`.
- `list_associated_projects` (opportunity → projects).
- `list_custom_fields(entity)`, `get_custom_field(entity, fieldId)`
  for custom-field schema enumeration.
- Track instances:
  `list_entity_tracks`, `show_track`, `apply_track`, `update_track`,
  `remove_track`.

### Stats

- 63 tools (42 in read-only mode). 130/130 tests passing.

## [0.5.0] — 2026-05-09

### Added

- Audit: `list_deleted_parties(since)`,
  `list_deleted_opportunities(since)`,
  `list_deleted_projects(since)`. The `since` parameter is required
  by Capsule. Responses include `restrictedParties`/etc. siblings for
  records the integration user can see were deleted but cannot read
  fully.
- Navigation: `list_employees(partyId)` — wraps
  `GET /parties/{id}/people`.
- Workflow metadata: `list_track_definitions`, `list_categories`,
  `list_goals`.
- Diagnostic: `get_site` — closest equivalent to a `/users/me`
  endpoint, which Capsule v2 doesn't expose.
- Write: `update_entry(id, content?, subject?)` — edit existing
  notes/entries. Subject to read-only gate.

### Stats

- 52 tools (36 in read-only mode). 114/114 tests passing.

## [0.4.0] — 2026-05-09

### Added

- Reference metadata: `list_teams`, `list_lostreasons`,
  `list_activitytypes`.
- Project workflow metadata: `list_boards`, `list_stages`.
- Global timeline feed: `list_entries` — the company-wide
  most-recent-first feed of every note, captured email, and
  completed-task record.
- Saved filters (the only Capsule-side path to sortable queries):
  `list_saved_filters(entity)`, `run_saved_filter(entity, id)`.

### Stats

- 43 tools (28 in read-only mode). 101/101 tests passing.

## [0.3.4] — 2026-05-07

### Changed

- `filter_*` tool descriptions corrected to use Capsule's filter-side
  field names (e.g. `lastContactedOn`, not `lastContactedAt`;
  `addedOn`, not `createdAt`). Capsule's filter API rejects the
  response field names with a 422.
- Added "common patterns" recipe blocks to `filter_parties` /
  `filter_opportunities` / `filter_projects` so Claude reaches for
  recency, tag, open/stale, and noise-filtering idioms naturally.

## [0.3.3] — 2026-05-07

### Added

- Structured filter tools: `filter_parties`, `filter_opportunities`,
  `filter_projects`. Wrap Capsule's
  `POST /<entity>/filters/results` with `{conditions: [...]}` body.
- `capsuleSearch` client helper for POST-based reads.

### Notes

- Capsule's ad-hoc filter endpoint does **not** support sort. Tool
  descriptions guide Claude to filter by a date condition and pick
  the highest id (Capsule numeric IDs are monotonic) for recency
  questions. For sortable queries, use saved filters (added in
  v0.4.0).

### Stats

- 35 tools (20 in read-only mode).

## [0.3.2] — 2026-05-07

### Added

- Connector icon: SVG served from `/icon.svg` and `/favicon.ico` on
  the HTTP entry, plus referenced from the MCP `serverInfo.icons`
  field.

## [0.3.1] — 2026-05-07

### Changed

- Documentation reorganisation: split into README, INSTALL, DEPLOY,
  HOWTO so each audience has a clear landing page.
- Code cleanups in the auth module surfaced by review.

## [0.3.0] — 2026-05-07

### Added

- Static-client OAuth mode (default for public deployments). One
  hard-coded client_id / client_secret recognised at startup; DCR
  disabled at the SDK level. The shared `client_secret` is the real
  auth boundary.

### Changed

- Open Dynamic Client Registration is now opt-in via
  `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`. Public deployments default to
  the closed-client mode.
- Server refuses to start if neither OAuth mode is configured —
  the secure mode is the path of least resistance.

### Security

- Pre-v0.3.0 deployments allowed any caller to register a client and
  complete the OAuth dance. The auto-approve mode is now an explicit
  opt-in for local / private-network use.

## [0.2.0] — 2026-05-07

### Added

- HTTP transport with full OAuth 2.1: `/.well-known/*`, `/authorize`,
  `/token`, `/register`, plus the gated `/mcp` endpoint.
- HMAC-signed access + refresh tokens (stateless; tolerant of Cloud
  Run instance churn).
- `Dockerfile` and Cloud Run-friendly entry.

## [0.1.0] — 2026-05-07

First release. Covers parties, opportunities, projects, tasks,
timeline entries, pipelines, milestones, tags, users with read +
write tools. Stdio transport. Apache 2.0.
