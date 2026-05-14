# Changelog

All notable changes to capsulemcp.

The full release notes for each tagged version live on GitHub:
<https://github.com/soil-dev/capsulemcp/releases>. This file mirrors the
high-level summary so it's discoverable from the repo and on npm.

The format follows [Keep a Changelog](https://keepachangelog.com), and
versions adhere to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Security

- **GitHub Actions token permissions pinned to read-only.** CI only needs
  to fetch the repository, so the workflow now declares
  `permissions: contents: read` instead of inheriting repository/org
  defaults.
- **Party website URL validation tightened to an http(s) allow-list.**
  `service: "URL"` addresses already had syntax validation and blocked
  the obvious scriptable schemes; the schema now rejects every non-web
  protocol instead of relying on a deny-list.

### Documented

- **15 tool descriptions rewritten for richer LLM routing.** All 5
  tools that Glama's introspection scored as C-grade
  (`list_party_opportunities`, `list_party_projects`,
  `create_opportunity`, `list_milestones`, `list_users`) and the
  10 B-grade tools (`get_opportunity`, `list_associated_projects`,
  `create_project`, `get_task`, `list_opportunity_entries`,
  `list_project_entries`, `list_pipelines`, `list_boards`,
  `list_activitytypes`, `list_tags`) now follow the
  what-it-does + when-to-use-it + what-it-returns + how-it-compares-
  to-related-tools shape the A-grade tools already had. No behaviour
  change — descriptions only affect LLM tool-selection. Bundle size
  grows accordingly: `dist/index.js` 115 → 118 KB, `dist/http.js`
  140 → 144 KB.

## [1.0.0] — 2026-05-13

First stable release.

Promotes [1.0.0-beta.4] to GA — no code change vs. beta.4. From this
point on the project follows [Semantic Versioning](https://semver.org)
strictly: breaking changes require a major bump, new tools / env vars
get a minor bump, bug fixes and doc updates get patches. The two most
recent minor lines receive security backports.

The full feature set, surface area, and design rationale are unchanged
from beta.4 — see that section below for the substantive notes, and
[DESIGN.md](DESIGN.md) (L1..L12) for the known limitations the project
intentionally ships with.

## [1.0.0-beta.4] — 2026-05-13

Pre-1.0 security review pass. Three Sev-3 findings fixed in code,
two captured as documented limitations, plus the tooling/hygiene
work that accumulated since beta.3.

### Security

- **Per-request timeout now covers body consumption, not just
  headers.** `fetchWithTimeout` cleared its AbortController in the
  `finally` of the initial `fetch()` call, so the 60s budget only
  guarded headers + initial response. Subsequent `res.json()` /
  `res.arrayBuffer()` / streaming `body.getReader().read()` /
  `res.text()` calls ran un-timed — a Capsule response that returned
  headers promptly then stalled mid-body pinned the request
  indefinitely (realistic DoS vector: one such hang costs a Cloud
  Run instance). Fix: `fetchWithTimeout`/`doFetch` now return
  `{ res, cleanup }`; every top-level capsule client function calls
  `cleanup` in a try/finally wrapping body consumption, and a new
  `mapAbort()` helper converts mid-stream AbortError into the same
  clean `CapsuleApiError 504` a fetch-stage abort produces.
  Regression test in `tests/rate-limit.test.ts`.
- **`MCP_HTTP_TRUST_PROXY` env override added** (default `1`,
  validated as integer 0..10). Previously hardcoded — fine for
  single-frontend deployments (Cloud Run), wrong for multi-hop
  ingress (Cloudflare → Cloud Run needs `2`) and for bare-IP
  deployments without any proxy in front (where any
  `X-Forwarded-For` trust lets a client spoof their per-IP rate
  limit bucket). Authenticated `/mcp` is unaffected — the bearer
  auth runs first and the limiter keys by client_id, not IP.
- **URL validation on website `address` when `service` is `URL`.**
  Was `z.string().min(1)` with no further check; the connector
  would happily write `javascript:alert(1)` or `not a url` into
  Capsule's website field, and Capsule stores user-supplied strings
  verbatim. Two new gates via Zod `superRefine` on both
  `WebsiteSchema` (create/update party nested) and
  `addPartyWebsiteSchema`: (1) syntactic — must parse via WHATWG
  URL parser when service resolves to URL; (2) scheme —
  `javascript:` / `data:` / `vbscript:` rejected even when
  syntactically parseable. Non-URL services (TWITTER, BLUESKY,
  GITHUB, …) are untouched.
- **Constant-time PKCE verification.** The MCP SDK's bundled
  `pkce-challenge` does its verifier-vs-challenge compare with
  native `===`. Both sides are fixed-width SHA-256 base64url
  strings so there's no realistic information leak, but the SDK
  exposes an explicit `skipLocalPkceValidation` opt-out for
  exactly this concern. The OAuth provider now sets it and does
  the PKCE check itself: `base64url(SHA-256(verifier))` compared
  against the stored challenge via `timingSafeEqual`. The check
  runs before the resource-binding check, and a failed compare
  does NOT consume the code (so a network glitch on a legitimate
  exchange doesn't burn it).

### Documented (limitations)

- **DESIGN.md gains L11** (Capsule error bodies pass through to
  MCP responses verbatim — relevant for adversarial-tenant
  scenarios; same trust boundary as L1, sanitisation is a future-
  minor candidate) and **L12** (authorization-code state is
  in-process — multi-instance deployments without session affinity
  need sticky sessions or vertical scaling until auth-code state
  moves to a shared store; Cloud Run's single-instance affinity
  covers the worked example in DEPLOY.md).

### Tooling

- **Biome added as the project linter + formatter** (`biome.json`).
  Single binary replaces a notional ESLint+Prettier pair; config tuned
  to match the existing tree (spaces, 2-width, 100 cols, double quotes,
  trailing commas, semicolons) so the day-one diff is purely
  mechanical. `useLiteralKeys` disabled because the codebase
  intentionally uses `process.env["X"]` bracket access. New npm
  scripts: `lint`, `format`, `format:check`, `check`.
- **One-time `style:` sweep** (`biome format --write`) reformatted 49
  files. Pure formatting — 337 tests still pass, both bundles unchanged
  in size.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) runs on every PR
  and push to master: typecheck, Biome lint + format check, tests,
  build, `npm audit --audit-level=high`. Concurrency group cancels
  superseded runs. Whole job completes in ~25s.
- **`CONTRIBUTING.md`** added — short pointer doc covering the
  pre-PR gate, coding-style rules (mostly: "let Biome handle it"), and
  where to look for deeper docs.
- **Repository hygiene additions**: `SECURITY.md` (private reporting
  channels, scope, 3-day-ack / 14-day-triage commitment),
  `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`
  (structured bug + feature forms; redirects security/install/API
  questions before they reach the tracker),
  `.github/PULL_REQUEST_TEMPLATE.md` (summary + what-changed +
  test-plan checklist), `.github/dependabot.yml` (weekly npm +
  github-actions version updates, minor/patch batched).
- **DESIGN.md gets an "At a glance" architecture diagram** showing
  both transports (stdio → `dist/index.js`, HTTP+OAuth →
  `dist/http.js`) converging on the shared tool surface and Capsule
  client; read-only gate and confirm-flag gate annotated.
- **`package.json` `bin` path normalised** (`./dist/index.js` →
  `dist/index.js`) per `npm pkg fix` to silence the publish-time
  warning.
- **Action versions bumped**: `actions/checkout` v4 → v6,
  `actions/setup-node` v4 → v6. CI now runs on Node 24 runtime
  instead of the deprecated Node 20.
- **Refactor scrub** (PR #24): consolidated repeated tool-description
  constants, shared `mockFetch` / `mockJson` / `mockBinary` test
  helpers in `tests/test-helpers.ts`.
- **Example-value scrub.** A handful of tool descriptions and test
  fixtures used the operator's real social handle and a real
  production-tenant user id/username plus production-looking party ids
  as illustrative values; replaced with synthetic `@acmeco`, `123456`,
  `"alice"` so every install ships with neutral examples.

### Fixed

- **Friendlier `confirm: true` rejection message on all 7 gated tools.**
  Zod's default error on `z.literal(true)` reads
  `"Invalid input: expected true"` — technically correct but unhelpful,
  especially for an LLM caller trying to self-correct (sounds like
  "you passed false" even when the field was missing entirely). New
  shared helper `confirmFlag()` in `src/tools/confirm-flag.ts` returns
  a `z.literal(true)` with a custom error message:
  `"confirm: true is required to perform this destructive operation
  (set the parameter explicitly to acknowledge the destructive intent)"`.
  Applied to `delete_party`, `delete_opportunity`, `delete_project`,
  `delete_task`, `delete_entry`, `remove_track`, and
  `remove_additional_party`. Per-tool `.describe(...)` text
  (cascade semantics, irreversibility/reversibility notes) is
  unchanged at each call site — only the rejection message is
  normalised. Regression coverage in
  `tests/confirm-flag.test.ts`: missing/false/true probes against
  each of the 7 schemas.
- **`create_opportunity.value.currency` missing-field error is now
  operator-readable.** Previously the schema emitted Zod's default
  `"Invalid input: expected string, received undefined"` when
  `value: { amount: N }` was supplied without `currency` — technically
  correct but unhelpful at a callsite. Custom `error` on the currency
  field now produces `"currency is required when amount is set
  (3-letter ISO 4217 code, e.g. 'USD', 'EUR', 'GBP')"` for the
  missing-field case specifically. Length and type errors still fall
  through to Zod's defaults so callers see exactly which constraint
  failed. Test coverage in `tests/opportunities.test.ts`.

### Documented

- **`remove_track` deletes the track's auto-tasks too.** §11
  production verification (2026-05-13) caught a stale claim in
  the `confirm` description: it said "Tasks already created by
  the track stay on the entity and must be deleted separately
  if desired." Wrong. Capsule deletes the auto-tasks alongside
  the track instance — verified isolated: apply track → 1 task
  alive (200), `DELETE /tracks/{T}` → 204, then GET on the
  same task id → 404 "task not found", and
  `GET /opportunities/{O}/tasks` returns 0. Description updated
  to spell this out and to suggest copying task content
  elsewhere if the operator needs anything to outlive the
  track. NOTES §25 (cascade on parent delete) stays accurate —
  it correctly says auto-tasks are cascaded with their parent
  opp/project; the new finding is just that the same happens
  on a direct `remove_track`.
- **`update_entry.subject` on plain notes is a true no-op, not
  audit noise.** §8 production verification (2026-05-13) showed
  that PUT-ing a subject onto a note-type entry returns HTTP 200
  but **neither persists the subject nor advances `updatedAt`**
  (verified with a 2-second gap to rule out timestamp-resolution
  collisions). The previous description claimed Capsule accepts
  the call and advances `updatedAt` — wrong, possibly stale from
  an older API behaviour. Updated to: true no-op for inapplicable
  fields; `updatedAt` only advances when an applicable field
  actually changes.
- **`create_task` description now covers the no-target case.** §4
  production verification confirmed Capsule accepts a task with no
  `partyId` / `opportunityId` / `projectId` (standalone task — useful
  for personal reminders or workflow tasks not tied to a CRM record).
  The previous description only spelled out the mutex; the no-target
  outcome was undocumented. Description now says "omitting all three
  is also valid" with the intended use case.
- **Address `country` field is dictionary-validated, not
  free-text.** §1 production verification showed that Capsule
  rejects inputs not in its canonical-English-name dictionary
  with `422 address.country: unknown country` — not silently
  passes them through. The previous description's
  "normalisation, not rejection" framing was wrong for any
  input that wasn't already a dictionary hit. Updated:
  - `AddressSchema.country` and `addPartyAddressSchema.country`
    descriptions now list the dictionary edges discovered
    (accepted, aliased, and notable rejections like
    `Czech Republic`, `UK`, `Deutschland`).
  - NOTES-ON-CAPSULE-API.md §30 documents the dictionary
    behaviour with the full probe table.
- **Capsule's v2 REST API does not expose team↔user membership.**
  Verified live on the production tenant by probing five
  plausible shapes (`GET /teams`, `embed=users`,
  `GET /teams/{id}`, `GET /teams/{id}/users`, `GET /users/{id}`)
  — all return identity but no join. NOTES §29 and the
  `list_teams` tool description carry the limitation
  explicitly, including the `update_project { ownerId, teamId } →
  422` membership-probe workaround.

## [1.0.0-beta.3] — 2026-05-11

Container-image-build fix. v1.0.0-beta.1 and v1.0.0-beta.2
**published successfully on npm/GitHub but their container-image
builds failed silently** — the production Cloud Run service has
been running the v1.0.0-alpha.20 image since the alpha.20 deploy,
despite the deployed service's `serverInfo.version` claiming
"beta.1" / "beta.2".

Root cause: PR #19 added `COPY scripts ./scripts` to the
Dockerfile so the container build could run the same
`npm run build` script as local builds (which chains
`build:icon`). But the matching `.dockerignore` entry for
`scripts/` was never removed, so the `COPY` step failed with
`no items matching glob "scripts"` — exit 125. The image build
GitHub workflow reported `conclusion: failure`, but the local
`gh run watch --exit-status | tail -3` invocation masked the
non-zero exit through the pipe, so the pre-deploy "wait for
build" step appeared to succeed. Cloud Run's `:latest` digest
hadn't moved since alpha.20, and Pulumi cheerfully resolved and
deployed that stale digest twice in a row.

This release bumps to beta.3 (the previous tags' content is
fine — only the container builds were stuck) and:

- Removes `scripts` from `.dockerignore` so `COPY scripts ./scripts`
  succeeds.
- HOWTO release checklist gains a "verify the workflow run's
  conclusion, not just exit status" line so the masking via
  `tail` can't recur.

No code changes. The behavioural improvements documented under
beta.1 and beta.2 **become actually live** with this release —
constant-time client_secret, /mcp rate limit, sanitized error
logs, stage carry, Zod token validation, stdio fail-fast.

## [1.0.0-beta.2] — 2026-05-11

Long-tail housekeeping after the beta.1 production verification
round. No behavioural changes; doc accuracy improvements on the
two outstanding Capsule-API observations from the alpha tail.

### Closed (long-tail housekeeping)

- **Bug 11 — `remove_tag_by_id` transient hang.** Observed once
  in early alpha and unreproducible since. The beta.1 stress
  loop ran **24 back-to-back `remove_tag_by_id` calls** on the
  same party (across three iterations of add-8-tags / read /
  remove-8-tags) with zero anomalies — no hangs, no timeouts,
  no errors, no latency outliers. Closed as unreproducible; the
  original observation is attributed to a transient upstream
  Capsule hiccup or the Claude.ai tool-approval prompt's own
  timeout firing higher up the stack, not a connector defect.
  The 60s outbound timeout in `src/capsule/client.ts` stays —
  it remains the right defence against real upstream slowness
  even though the original hangs weren't its target.

### Documented

- **BOOLEAN custom fields are observably two-state, not three-state.**
  The beta.1 production verification of Bug 12 confirmed Capsule
  still rejects `value: null` with 422 (as documented), AND added a
  new datapoint: `value: false` is accepted but the row is then
  **absent** on read-back via `embed='fields'`, not a row with
  `value: false`. Updated `CustomFieldWriteSchema.value` description
  and NOTES §21 to reflect: BOOLEAN states are "row with `true`" or
  "no row"; callers should treat absent BOOLEAN rows as equivalent
  to false; tri-state semantics aren't achievable through Capsule's
  API (the previously-mentioned `_delete: true` workaround doesn't
  help because `value: false` already produces the absent-row state).

## [1.0.0-beta.1] — 2026-05-11

First beta. Closes the 20-alpha test-plan loop with a
coordinated beta-readiness polish pass across four review
angles (schema-description vs handler, top-level docs vs code,
test hygiene, and security) and the follow-up patches from
PR #20. No behavioural regressions; one new connector-layer
protection (per-client rate limit on `/mcp`), three new
defence-in-depth hardenings, three latent fixes uncovered by
review (async-store-safe `/token` precheck, public-DCR-client
passthrough, broader `update_project` stage carry), and a
thorough schema-description / docs sync.

### Added

- **Per-client rate limit on `/mcp`.** Keyed by authenticated
  `clientId` (falls back to IP). Default 600 requests per 60s,
  configurable via `MCP_HTTP_RATE_LIMIT_MAX` /
  `MCP_HTTP_RATE_LIMIT_WINDOW_MS`, disable-able via
  `MCP_HTTP_RATE_LIMIT_DISABLED=1` for tests. Backstop against
  one abusive caller exhausting the shared Capsule 4000-rph
  quota for everyone else on the same deployment.
- **`MCP_HTTP_DEBUG=1`** env var: opts in to verbose `/mcp`
  error logging. Default is now a low-cardinality summary
  (`ErrorName status`), to avoid Capsule response bodies (party
  names, validation messages) smearing across log aggregators.

### Fixed

- **Constant-time `client_secret` comparison on `/token`.** The
  MCP SDK's auth router uses native `!==` for client-secret
  validation, leaking a timing channel. Added an explicit
  pre-check middleware on `/token` that compares fixed-width
  digests with `timingSafeEqual` before delegating; the SDK's
  downstream compare now only ever runs on a known-valid
  secret-bearing client, while public DCR clients still flow
  through the SDK's standards path.
- **Stdio entry fails fast on missing `CAPSULE_API_TOKEN`.**
  Matches the HTTP entry's behaviour. The error used to surface
  only on the first tool call.
- **`verifyToken` runtime-validates the claims payload (Zod).**
  HMAC verification already prevents forgery, but Zod-validating
  the parsed JSON guards against future signing-key compromise
  / downgrade scenarios where a malformed claim (missing
  `expiresAt`, non-string `clientId`) would otherwise propagate
  into downstream `AuthInfo`.
- **`update_project` RMW now carries `stage` forward too.** When the
  caller supplies `ownerId` and omits `teamId` and/or `stageId`,
  the connector reads the current project for the RMW and carries
  omitted fields forward; alpha.20 only captured `team` from that
  read, but the same Capsule PUT semantic that would clear an
  absent `team` could plausibly clear an absent `stage` too (it
  was never directly tested either way). One extra integer in the
  body, no extra HTTP call when a RMW is already needed, defensive
  against a silent stage-clear regression. Explicit `stageId` on
  the same call still wins — the RMW only fills in `stage` when
  the caller didn't supply one.

### Changed

- **`src/tools/_custom-fields.ts` renamed to
  `custom-field-helpers.ts`.** The underscore-prefix convention
  was idiosyncratic and read as "private/scratch" to newcomers
  despite the documented sort-ordering intent. Imports updated
  in the three call sites; no behavioural change.

### Documented

- **`update_project.ownerId` description** now mentions that the
  RMW carries any omitted team/stage field forward, not just team.
- **`update_project.stageId` description** dropped the stale
  owner-clearing warning (the alpha.18-era observation that
  drove it couldn't be reproduced).
- **`apply_track.startDate` schema** now enforces the
  YYYY-MM-DD regex the description already promised (the schema
  was previously unconstrained `z.string()`).
- **`apply_track.entity` enum** comment reconciled with the
  schema: tracks are only exposed for opportunities and projects
  (parties remain unexposed, even though Capsule's API would
  accept them).
- **Operator-facing `add_note` descriptions** dropped the
  alpha.8 → alpha.13 `creatorId` history; reframed as "this
  parameter would enable audit-attribution spoofing on
  shared-connector deployments, so it is intentionally not
  exposed."
- **NOTES-ON-CAPSULE-API.md** last-sync date bumped; stale
  `Bug N` references in source comments removed (the section
  numbers in NOTES are canonical now).
- **IDEAS.md** Bug 17 framing on the `teamId` entry updated to
  reflect the alpha.19R reclassification (was tenant board
  automation, not a Capsule API rule).
- **DESIGN.md** "Wrong-path errors" section dropped the
  `v0.5.0`/`v0.5.1` version anchors (those releases don't
  exist in public history).
- **DEPLOY.md env-var table** now lists `MCP_HTTP_JSON_LIMIT`,
  the three new `MCP_HTTP_RATE_LIMIT_*` knobs, and
  `MCP_HTTP_DEBUG`. New "Trust model — read before deploying"
  subsection makes the shared-Capsule-identity model,
  unsanitized-data passthrough, and signing-key-rotation kill
  switch explicit.
- **HOWTO.md** pre-release checklist extended: README/INSTALL
  pin updates and README tool-count assertions added as
  explicit items (both have drifted before).
- **`CustomFieldWriteSchema.value`** description gains a one-line
  audit-log note: sending `value: null` on a field that's already
  empty is accepted but still bumps the parent entity's
  `updatedAt`. Read via `embed='fields'` first if `updatedAt` is
  being used as a "last meaningful change" signal. Closes a §12
  audit-noise observation that hadn't made it into the schema
  text.

## [1.0.0-alpha.20] — 2026-05-11

The alpha.19-R re-verification against the production tenant
with **board automations disabled** materially recasts four
releases worth of project-ownership findings. The bulk of what
we'd been treating as Capsule API quirks (Bug 17, the
"board-default team" behaviour, the create-time owner-drop on
`ownerId + stageId`) were tenant-specific board automation
rules, not Capsule API behaviours. Capsule's API itself
preserves whatever you POST.

### Fixed

- **#16: registerTool now uses the SDK config-form
  `server.registerTool({ inputSchema })` instead of the
  deprecated `server.tool(name, desc, schema.shape, ...)`
  overload.** The old path rebuilt `z.object(schema.shape)`
  internally and dropped object-level refinements
  (`superRefine`, whole-object `refine`). Today there are no
  such refinements in the codebase, but the bug would have
  silently re-emerged the moment one was added. Architectural
  hygiene fix.

### Reverted

- **#14 schema-level rejection of `create_project { ownerId,
  stageId }` rolled back.** The rejection was based on Bug 17,
  which we now know was board automation in the test tenant.
  Capsule's API preserves both fields cleanly when the
  automation is off. Generic connectors shouldn't bake in
  tenant-specific automation assumptions, so the `superRefine`
  is gone. Issue #14 reopened-and-reclosed with an explanatory
  comment.

### Documented

- **NOTES §27 rewritten (sixth pass).** The "Rule B (POST
  drops owner)" framing is struck — it was automation, not the
  API. Rule A (PUT owner-in-body clears team) stays, and the
  RMW that mitigates it stays. A new "tenant board automation"
  paragraph spells out the failure mode (board automations can
  mutate owner/team independently of the API, indistinguishable
  from an API quirk from the caller's perspective). Wrong-
  framings list extended with the alpha.{17,18,19} Bug 17
  framings.
- **NOTES §28 corrected.** Projects default to **API-token
  owner**, same as the other entity types — not `null` as
  earlier versions of this file claimed. The "null" reading was
  an automation artifact.
- **`create_project.ownerId` / `teamId` / `stageId`** descriptions
  rewritten to drop the Bug-17-era warnings and replace them
  with a "tenant board automation may mutate these fields on
  creation" caveat. Soft-pedal rather than claim an API rule
  the API doesn't actually have.
- **`update_project.stageId`** description (already corrected
  in the previous batch after alpha.19 verification) stays —
  the runtime behaviour it describes (owner preserved across
  stage-only PUTs) is real, not automation-dependent.

## [1.0.0-alpha.19] — 2026-05-11

Two strands of work since alpha.18:

### Fixed

- **Issue #14: `create_project { ownerId, stageId }` rejected at
  schema level.** Capsule's POST silently drops `ownerId`
  whenever `stage` is in the body, producing a project with
  `owner: null` regardless of the caller's intent. The connector
  cannot work around this in a single call. The schema now
  rejects the combo with an actionable error pointing callers at
  the stage-first workflow (create with `stageId`, then
  `update_project { ownerId }`).
- **Issue #15: HTTP-date Retry-After test made deterministic.**
  The test relied on real timers + whole-second precision in
  `toUTCString()`, which could give `parseRetryAfter` a ≤0 delta
  and fall back to the 5s default — racing the 5s vitest timeout.
  Converted to fake timers + pinned system time (matches the
  pattern other rate-limit tests already use). Same flake-class
  fix applied to the X-RateLimit-Reset test, which had the same
  real-timer + epoch-second-rounding race.

### Documented

- The alpha.18 schema descriptions claimed a "create without
  stageId, then update_project { stageId }" two-call workflow
  reaches owner+team+stage. **The update-with-stage leg actually
  clears the owner** — Capsule has a third clear rule beyond
  the two known in alpha.18:
  - **Rule B (PUT):** `stage` in body clears `owner`, regardless
    of whether `owner` is also in the body.
  - **Rule C (POST):** symmetric clear at create time (this is
    the original Bug 17).
  No connector-side fix exists for Rules B/C — Capsule's
  clearing is independent of body shape, so RMW can't help.
- `create_project.stageId` and `update_project.stageId`
  descriptions rewritten around the working **stage-first,
  owner-second** workflow.
- `create_project.teamId` notes the
  `create_project { partyId, stageId, teamId }` → 422 case
  (Capsule appears to implicitly attach an owner and validate
  against the team).
- **NOTES-ON-CAPSULE-API.md §27** rewritten (fifth pass) around
  three rules (A, B, C) plus the working workflow. All five
  prior wrong framings listed explicitly for future readers.

## [1.0.0-alpha.18] — 2026-05-11

Follow-through on the alpha.17-verification report. Three
findings landed:

1. The asymmetric Capsule PUT semantic was misdiagnosed twice
   before — actually `owner`-in-body clears `team`, but
   `team`-in-body preserves `owner` (server-side). The alpha.17
   "pair-rewrite" framing was wrong.
2. Bug 17 is broader than first thought: Capsule's POST drops
   `owner` whenever `stage` is in the body, regardless of
   whether `teamId` is supplied. The previous workaround
   ("supply teamId explicitly") doesn't work.
3. Capsule rejects projects with both `owner` and `team` set to
   null — `422 kase: owner or team is required`.

### Fixed

- **Bug 16 (closed at the connector level).** `update_project`
  now does **read-modify-write** when the caller supplies
  `ownerId` without `teamId`: fetches the project's current
  `team` and includes it in the PUT body, so the
  Capsule-side "owner-in-body clears team" semantic no longer
  bites. Caller-visible behaviour: `update_project { ownerId }`
  preserves the existing team scope. Callers who want to clear
  team alongside an owner change pass `teamId: null`.

### Documented

- **Bug 17 reframed and given a working workaround.**
  `create_project.ownerId` and `create_project.stageId` now
  describe the two-call workflow: create without `stageId`
  (`create_project { ownerId, teamId }`), then
  `update_project { stageId }` afterwards. The previous "supply
  `teamId` alongside" advice was wrong.
- **Owner-or-team-required constraint** (422 on violation) noted
  on both `update_project.ownerId` and `update_project.teamId`,
  and §27.
- **Owner-must-be-member-of-team constraint** (422 on violation)
  noted on `update_project.teamId` description.
- **NOTES-ON-CAPSULE-API.md §27** rewritten (fourth pass) around
  the actual asymmetric PUT semantic + the
  always-owner-or-team-required constraint + the connector's
  RMW shim. Earlier three wrong framings are explicitly listed
  in the section so future readers don't get confused by
  alpha.{16,17}-era commits.

## [1.0.0-alpha.17] — 2026-05-11

Project-ownership write surface fix. The §15-supplementary
production verification re-diagnosed Bugs 16 and 17 (the
alpha.16 framing was wrong) and identified the underlying rule:
Capsule's PUT on /kases rewrites the (owner, team) pair
atomically — the absent half is cleared. The connector now
exposes `teamId` and explicit `null` unassign so callers can
express every reachable shape.

### Added

- **`teamId` parameter on `create_project` and `update_project`.**
  Maps to Capsule's body shape `team: {id: teamId}`. Discover IDs
  via `list_teams`. Unblocks the USER+TEAM project-ownership
  workflow that the connector previously couldn't express.
- **Explicit unassign via `null` on `update_project.ownerId` and
  `update_project.teamId`.** Passing `null` sends `owner: null` /
  `team: null` in the PUT body — matches Capsule's web UI
  "Unassign" dropdown option. Passing `undefined` (omitting the
  field) continues to mean "don't touch this field in the body".

### Fixed (via the new `teamId` parameter)

- **Bug 16 (corrected) — `update_project { ownerId }` clears
  `team`.** Root cause re-diagnosed via the §15-supplementary
  production verification: Capsule's PUT on /kases treats an
  absent `team` field in the request body as "clear team to
  null", **not** "leave unchanged" — regardless of any
  compatibility between the new owner and the existing team. The
  alpha.16 framing ("team must be one the owner belongs to or it
  clears") was wrong. Fix: callers can now supply both `ownerId`
  and `teamId` on the same update to preserve (or change) team
  scope across an owner change. The symmetric case (`teamId`
  clearing owner) is documented on `update_project.teamId`.
- **Bug 17 (NEW) — `create_project { ownerId, stageId }` silently
  drops `ownerId` when the stage's board has a default team.**
  Connector forwards `ownerId` correctly — Capsule's POST
  resolves the conflict in favour of the board's default team.
  Fix: supply `ownerId` and `teamId` explicitly to land at
  owner+team in one call.

### Documented

- **NOTES-ON-CAPSULE-API.md §27** rewritten (third pass) around
  the actual write semantics: (Rule A) PUT treats absent
  owner/team as "clear", and (Rule B) POST drops owner when
  board-default team wins. Previous framings — "mutually
  exclusive" (initial) and "team must be one the owner belongs
  to" (alpha.16) — both wrong, explicitly flagged in §27 for
  future readers.
- IDEAS.md "Explicit `teamId` on write tools" entry updated to
  reflect partial implementation (projects only); parties /
  opportunities / tasks still deferred.

## [1.0.0-alpha.16] — 2026-05-11

Closes the §15-16 final batch of the production write-mode test
plan. One new bug (Bug 16, ownerId-clears-team on projects) +
several per-entity ownerId-default documentation gaps; both
description-only fixes per the report's recommendations.

**The 16-section production test plan is now fully run.** Final
tally: 16 numbered bugs across the series, **14 resolved**, 2
documented as Capsule API limits with workarounds (Bug 12 BOOLEAN
null-clearing, Bug 16 owner/team mutual exclusivity on projects).

### Documented

- **Bug 16** — setting `ownerId` on a project can silently clear
  its team membership. The behaviour is a consequence of Capsule's
  actual data-model rule: a project can have **owner alone**,
  **team alone**, or **owner + team where the team is one the
  owner belongs to** (users can be in multiple teams, so this is
  expressible whenever the operator has organised users into teams
  sensibly). What's NOT allowed is owner+team where the owner
  isn't in that team; Capsule resolves writes that would create
  that state by clearing the team rather than rejecting the
  request. The §15 production verification observed this when
  setting an owner who wasn't in the project's current team
  (initial bug report framed the rule as "owner and team are
  mutually exclusive" — that framing was wrong; the actual rule is
  "team must be one the owner belongs to"). The connector can't
  set `teamId` directly, so once a team is cleared, restoring it
  requires Capsule's web UI. Documented in verbose detail on both
  `create_project.ownerId` and `update_project.ownerId`, plus a
  new section in `NOTES-ON-CAPSULE-API.md` (§27).
- Per-entity **`ownerId` default inconsistency** documented on
  every `create_*.ownerId` description:
  - `create_party.ownerId`, `create_opportunity.ownerId`,
    `create_task.ownerId` default to the API-token owner when
    omitted.
  - `create_project.ownerId` defaults to **null** (Capsule lets
    the board's default team populate the `team` field instead).
  - **Opportunities do NOT inherit owner from the linked party** —
    surprising behaviour worth calling out separately on
    `create_opportunity.ownerId`. Also captured as
    `NOTES-ON-CAPSULE-API.md` §28.
- **Owner cannot be cleared via the connector**: once an `ownerId`
  is set on any entity, this connector has no path back to null
  (the schema rejects `0`, no `null` provision). Capsule's web UI
  is the only path. Documented on every `ownerId` field.

These close the §15-16 batch of the production write-mode test
plan. **The 16-section test plan is now fully run.** Final
tally: 16 numbered bugs filed across all 16 sections, **14
resolved**, 2 open (Bug 12 BOOLEAN-null clearing and Bug 16
owner/team mutual exclusivity — both documented as Capsule API
limits with workarounds). NOTES-ON-CAPSULE-API.md grows to 28
sections.

## [1.0.0-alpha.15] — 2026-05-11

Docs-only alpha. Three commits since alpha.14, none touching
runtime behaviour:
  a8b5091  §13-14 verification follow-through: `delete_party`
           track-orphan caveat + atomic-remove confirm-gate
           policy on 5 tools.
  88c8cde  NOTES-ON-CAPSULE-API.md grows from 18 → 26 sections,
           cataloguing 8 Capsule v2 quirks surfaced through the
           alpha series.
  f5173cf  Sanitize operator-specific references in public docs
           and code (production tenant tag names / id numbers /
           personal names that had leaked into CHANGELOG, NOTES,
           IDEAS, and a handful of test files and public tool
           descriptions).

### Changed

- `delete_party` description now documents the **track-instance
  orphan quirk** surfaced in the §13 cascade audit: track instances
  applied to cascaded opportunities/projects are NOT cleaned up by
  Capsule when the parent party is deleted — they survive as
  unreachable-from-normal-navigation records, only findable by
  track id via `show_track`. Callers who care about orphan
  accumulation should `remove_track` explicitly before
  `delete_party`. Document-only fix (recommendation option 1 from
  the §13 report); a connector-side pre-cascade is overkill for a
  low-impact quirk.
- The five atomic `remove_*_by_id` tools (email/phone/address/website
  /tag) now spell out the "atomic + reversible = no confirm gate"
  policy in their descriptions, with a pointer to the matching
  `add_*` tool for re-attach. Closes the §14 documentation gap
  where callers saw seven destructive tools requiring `confirm:
  true` and five not, with no explanation of when each protection
  applies.

## [1.0.0-alpha.14] — 2026-05-11

### Security

- **Removed `add_note.creatorId`** (issue #11). The parameter let
  any caller with write access record a note attributed to an
  arbitrary Capsule user, not just the API-token owner. Combined
  with `entryAt` backdating and a shared-connector deployment
  (where the OAuth client secret might leak or multiple humans
  drive the same connector), this was a trivial audit-attribution
  spoofing surface. The use cases it was added for (historical
  imports, on-behalf-of automation) are real but niche; surfacing
  the override by default is the wrong trade-off. Removed from
  the schema entirely; `addNote` no longer reads or forwards
  `creatorId`. Notes are now always attributed to the API-token
  owner. The `add_note` schema and the tool description on the
  server registration both note the removal explicitly so any
  caller carrying old call shapes gets a clear breadcrumb.
- A future env-gated re-introduction (`CAPSULE_MCP_ALLOW_CREATOR_OVERRIDE=yes`)
  is parked in IDEAS.md for deployments that actually need the
  override and are willing to opt in explicitly.

### Tests

- The alpha.8 regression test for `creatorId → creator: {id}`
  mapping was replaced with a negative regression test confirming
  the schema drops the parameter (zod's default unknown-key
  behaviour) and that no `creator` field reaches Capsule's request
  body.

## [1.0.0-alpha.13] — 2026-05-11

Refactor-heavy alpha, no behaviour change. Sets up cleaner internals
on the path to v1.0.0 final.

### Changed

- `show_track` description corrected — alpha.12's text claimed the
  response carries the track's link to its trackDefinition, the
  entity it's applied to, and completion status. Capsule's GET
  `/tracks/{id}` actually returns a much smaller projection:
  `id`, `description`, `trackDateOn`, `direction`, and the array of
  `tasks` attached. Description now matches the runtime and points
  callers at `list_entity_tracks` for the entity-reference path and
  at the tasks' own statuses as the completion proxy. Drift caught
  in the alpha.12 verification.
- All 12 destructive tools (`delete_party`, `delete_opportunity`,
  `delete_project`, `delete_task`, `delete_entry`,
  `remove_additional_party`, `remove_track`, `remove_tag_by_id`,
  and the four `remove_party_*_by_id` tools) now document their
  `alreadyDeleted` / `alreadyRemoved` response fields in the
  schema descriptions. The behaviour shipped in alpha.12; the
  documentation gap was flagged in the alpha.12 verification with
  the same shape as the alpha.9 → alpha.10 follow-up on
  `add_additional_party.alreadyLinked`.
- Outbound HTTP timeout (alpha.12, commit ca25f87) description
  softened: the alpha.10 / alpha.11 transient hangs that prompted
  the work were most likely Claude.ai tool-approval timeouts
  higher up the stack, not Capsule slowness. The 60s timeout is
  still correct as defense in depth; the prose was the only thing
  wrong.

### Refactored (internal only — no behaviour change)

- **`CustomFieldWriteSchema` consolidated** into a shared
  `src/tools/_custom-fields.ts` module. Previously the zod shape
  and the `definitionId → {definition: {id}, value}` body mapping
  lived in three places (parties, opportunities, projects) and had
  begun to drift. One source now. Net −45 LOC.
- **Destructive-op idempotency helper** extracted to
  `src/capsule/idempotent.ts`. The catch-and-convert-to-success
  pattern shipped in alpha.12 was duplicated in 11 handlers
  across 7 files; each block was ~10 lines. The helper collapses
  each to a 3-line call. Two named predicates (`isCapsule404`,
  `isCapsuleTagNotFound`) make "what error is caught" more
  discoverable than the inline status + message-match checks
  were. Net −65 LOC.
- **`registerTool` helper** extracted to
  `src/server/register-tool.ts`. Each of the 80 read/write tools
  in `createCapsuleMcpServer()` was registered with the same
  8-line `server.tool(...)` wrapper pattern; collapsed to a
  single-line call. Two payoffs: (1) `src/server.ts` drops from
  1080 to 615 lines and the built bundles drop ~10 KB each,
  (2) the tool name and description now live on the same call,
  eliminating the "Edit collapses two adjacent string lines"
  footgun that had hit three times in the alpha series.
  `get_attachment` stays as a raw `server.tool` call: its handler
  shapes the response per Content-Type and can't use the helper's
  fixed JSON-stringify wrapper.

  A bigger refactor (splitting `src/server.ts` into 13 per-resource
  modules mirroring `src/tools/`) was considered and deferred —
  the main benefit there was bounding-edits-by-file, and that's
  largely achieved by the line-count shrink alone. The option
  stays open for post-1.0.

Numbers:
  - Tools: 81 (49 read-only) — unchanged
  - Tests: 292 / 292 — unchanged
  - Build: dist/index.js 116 → 104 KB, dist/http.js 136 → 124 KB
    (the `registerTool` extraction collapses 80 inlined wrappers
    into one shared helper)

## [1.0.0-alpha.12] — 2026-05-11

### Changed

- **Destructive-op idempotency unified across all 12 tools.** §12 of
  the production write-mode bug-report observed that delete/remove
  tools leaked Capsule's "doesn't exist / not attached" errors
  (404 / 422) to callers, breaking retry / undo / reconciliation
  loops that naturally re-issue these calls expecting them to be
  safe ("desired state: gone; current state: gone; → success"). The
  `add_additional_party` precedent showed the pattern; now applied
  uniformly:
  - **DELETE-shape ops** (`delete_party`, `delete_opportunity`,
    `delete_project`, `delete_task`, `delete_entry`,
    `remove_additional_party`, `remove_track`) catch
    `CapsuleApiError(404)` and return their normal success shape
    plus `alreadyDeleted: true` (for `delete_*`) or
    `alreadyRemoved: true` (for `remove_*`). Successful first-time
    deletes now also carry `alreadyDeleted: false` /
    `alreadyRemoved: false` so callers can distinguish.
  - **PUT-with-_delete ops on party child arrays**
    (`remove_party_email_address_by_id`,
    `remove_party_phone_number_by_id`,
    `remove_party_address_by_id`,
    `remove_party_website_by_id`) catch `CapsuleApiError(404)`
    and return `{removed: true, alreadyRemoved: true, partyId,
    <subId>}`. Success path still returns the Capsule party
    response merged with `{removed: true, alreadyRemoved: false}`.
  - **`remove_tag_by_id`** catches `CapsuleApiError(422)` with the
    specific message "tag not found to delete" (other 422s still
    surface) and returns the same shape with `alreadyRemoved: true`.
  - Errors with other status codes / messages still propagate
    unchanged.

  Closes the §12 class observation. Callers writing reconciliation
  loops or undo flows can now retry destructive ops freely.

### Fixed

- **Bug 13** — `apply_track.startDate` was silently ignored.
  Capsule's POST /tracks body field is `trackDateOn` (per Capsule's
  own example in our `NOTES-ON-CAPSULE-API.md` §2), not `startDate`.
  The connector accepted the parameter and forwarded it as
  `startDate`, which Capsule's API drops silently — the resulting
  track always landed at today's date and auto-tasks computed
  `dueOn` from today + the track's `daysAfter` offset, regardless
  of what the caller passed. Renamed the body field on the way out
  while keeping the user-facing parameter name `startDate` (more
  intuitive). Backdating tracks for historical records and
  scheduling tracks against future contract end-dates both work
  now. Caught in the §11-12 production write-mode verification.
- Outbound Capsule HTTP timeout (defense in depth). All outbound
  requests now carry a 60-second timeout via AbortController; an
  aborted request is converted to `CapsuleApiError(504)` with retry
  guidance. Bug 14 in the §11-12 report and Bug 11 from the alpha.10
  report were filed as transient hangs in `remove_tag_by_id` /
  `list_entity_tracks` and prompted this work; in retrospect those
  hangs were almost certainly higher up the stack — Claude.ai's
  tool-approval prompt timing out while the user was away, before
  the connector was ever invoked. The connector had no call to
  time out. So this fix doesn't address those specific reports, but
  it's still the right thing to ship: real Capsule slowness, DNS
  hiccups, TCP keepalive holes, and Capsule outages that return
  slowly all benefit from a bounded outbound budget. The
  `AbortError → CapsuleApiError(504)` regression test in
  `tests/rate-limit.test.ts` locks the conversion.

### Changed

- `apply_track` description now warns explicitly that the tool is
  **NOT idempotent**: applying the same trackDefinitionId twice
  creates two independent track instances and two sets of
  auto-tasks. To apply only once, call `list_entity_tracks` first
  and check for an existing instance with the same
  `trackDefinition.id`. Closes Bug 15 by documentation (option 1
  from the §11-12 verification report — idempotency-by-default is
  arguably wrong here, since applying the same track to start a new
  cycle is a legitimate workflow).
- `apply_track.startDate` description now explains the mechanic
  more fully: `startDate` is added to each task definition's
  `daysAfter` offset to compute its `dueOn`. Defaults to today.
- `list_entity_tracks` description now notes that some boards have
  stage-triggered automation that auto-applies tracks when an
  entity enters specific stages — tracks returned here may include
  BOTH manually-applied tracks AND auto-applied tracks from board
  rules. Compare `trackDefinition.id` against your application's
  `apply_track` call history to distinguish.

## [1.0.0-alpha.11] — 2026-05-11

### Changed

- Tag-write tool descriptions corrected after the alpha.10
  production verification proved two earlier assumptions wrong:
  - `add_tag.tagName`: previously said *"Names are case-sensitive
    and tenant-global."* Verified live that Capsule matches
    case-INSENSITIVELY ('VIP' and 'vip' attach the same tag,
    preserving the canonical casing from whichever variant was
    created first). Description and example updated.
  - `remove_tag_by_id.tagId`: previously warned the parameter was
    the "per-entity LINK id, NOT the global tag id from list_tags".
    Verified live that the two are the same id — both sources work.
    Warning softened to a recommendation: read via `embed=tags`
    first because it confirms the tag is actually attached to the
    entity (a list_tags id for a tag NOT on this entity would 422
    'tag not found to delete').
  - File-header comment in `src/tools/tags.ts` rewritten to
    reflect the verified single-id model.
- Custom-field `fields[].value` descriptions now document three
  additional quirks surfaced during alpha.10 production
  verification:
  - **BOOLEAN cannot be cleared via `value: null`** — Capsule
    returns 422 'invalid type for field'. The other four observed
    types (TEXT, NUMBER, DATE, LIST) accept null cleanly and
    remove the row. Set BOOLEAN to `false` instead; the connector
    does not currently rewrite null → `_delete: true` for BOOLEAN
    because the workaround is trivial and tri-state booleans are
    rarely needed. (Bug 12 in the alpha.10 verification — closed
    by documentation per the report's recommendation.)
  - **NUMBER returned as string** — setting `value: 3` stores
    correctly, but the read-back via `embed=fields` returns
    `value: "3"` (string). Callers comparing values must coerce.
  - **TEXT empty-string clears the field** — `value: ""` has the
    same observable effect as `value: null`; empty-string and
    never-set are indistinguishable in Capsule's storage.
  - **Data-tag membership is implicit** — setting a custom field
    whose definition lives under a data tag (Capsule's mechanism
    for gating a related set of fields, e.g. all contract-related
    fields under one data tag) populates the field row's internal
    tagId but does NOT auto-add the data tag to the entity's tags
    array. `add_tag` it explicitly if you want it visible via
    `embed=tags`. (Documented on `update_project.fields` only,
    where this is most relevant.)

### Documentation

- IDEAS.md gains an entry for tag-definition delete: the connector
  has no way to delete a tag *definition* tenant-wide, only to
  detach a tag from a specific entity. Empty-definition cleanup
  currently requires Capsule's web UI. Surfaced during alpha.10
  verification (two test tags stranded in the tenant).

## [1.0.0-alpha.10] — 2026-05-11

### Added

- **Tag writes — two new atomic tools** for attaching and detaching
  tags on parties, opportunities, and projects. Closes the largest
  open missing-capability gap from the production write-mode
  bug-report (§7). Generic with an `entity` discriminator
  (`parties` / `opportunities` / `kases`) so the surface stays
  compact: 2 tools, not 6 per-entity pairs.
  - `add_tag(entity, entityId, tagName)` — PUT with
    `{tags: [{name}]}`. Capsule resolves the name against the
    tenant's tag dictionary: matches an existing tag if one with
    that name exists, otherwise creates the tag and attaches it.
    Idempotent — re-attaching an already-attached tag is harmless.
  - `remove_tag_by_id(entity, entityId, tagId)` — PUT with
    `{tags: [{id, _delete: true}]}`. The `tagId` is the
    **per-entity tag LINK id** (from get_party / get_opportunity /
    get_project with `embed=tags`), NOT the global tag id from
    list_tags. The schema description spells this out — Capsule's
    docs are easy to mis-read here. The global tag persists in the
    tenant for other entities that share it.
- **Custom-field value writes** via a new optional `fields`
  parameter on `update_party`, `update_opportunity`, and
  `update_project`. Closes the second-largest gap from §7 (Lifecycle
  contract data lives entirely in custom fields). Shape:
  `fields: [{definitionId, value}]` where `value` is
  string / number / boolean / null. Partial update — only the
  definitions you list are touched; any field NOT in the array is
  left unchanged. The handler maps each entry to Capsule's
  `{definition: {id}, value}` body form. Discover definition IDs
  via the existing `list_custom_fields` tool; read current values
  via `get_*` with `embed=fields`. Pass `value: null` to attempt
  clearing (Capsule's docs don't explicitly document a clear shape;
  if null doesn't work for some field type we'll add an explicit
  `_delete: true` path in a followup).

12 new regression tests cover both write paths (5 for tags across
entities including schema-layer rejection of empty names and
unknown entities; 4 for custom fields covering the body-shape
mapping and type-union rejection on each of the three update tools).

Tool count goes 79 → 81; read-only count stays at 49 (both tag
write tools are gated by `if (!readOnly)` and `capsulePut` already
refuses writes when `CAPSULE_MCP_READONLY=1`).

## [1.0.0-alpha.9] — 2026-05-11

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
  (`service: "TWITTER"`, e.g. `@acmeco`), an Instagram handle, etc.
  URL-validation here would also reject those non-URL values. Renamed
  the schema field `url` → `address`, dropped the `.url()` validator
  (a string is correct), and added regression tests that lock both
  the new name and the old shape's rejection. Caught by a production
  write-mode test against a production Capsule tenant.

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
  that the only known operator had already migrated off long ago.
  Error message and DEPLOY.md table updated to drop the fallback
  reference.
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
