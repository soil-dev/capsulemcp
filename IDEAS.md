# Ideas

Things that might be worth doing but aren't planned. **Listed without
commitment.** Some are genuinely good ideas waiting for someone to need
them; others are entries in a "considered and rejected for now" pile.

This file is intentionally informal. If an entry here grows into real
work, it earns a tracking issue (or graduates to the changelog when it
ships); until then it lives here so the thinking isn't lost between
revisits.

For why we *don't* implement certain Capsule APIs (admin-CRUD,
webhook configuration, etc.), see [DESIGN.md](DESIGN.md). This file is
about features that go *beyond* the existing surface, not gaps within
it.

---

## Per-user OAuth (multi-tenant deployment)

Solve the audit-attribution and shared-CRM-view limitations
([L1](DESIGN.md), [L4](DESIGN.md)) by federating identity. Each Claude
user goes through Capsule's OAuth 2 flow once, gets their own Capsule
access token, and the MCP server uses that token for their calls.
Audit trails attribute correctly. Record visibility filters per the
user's Capsule role.

**Cost**: significantly more state (per-user token store), more
refresh-token handling, more configuration per deployment, more
failure modes when a user's Capsule access changes underneath them.
Realistically a different product, not a small change.

**When to consider**: capsulemcp deployed as a multi-customer service
where each end user has their own Capsule account.

---

## Rate-limit fairness

Add a per-user rate-limit budget on top of Capsule's per-token limit
([L5](DESIGN.md)). Prevents one user (or one runaway loop) from
starving others.

**Cost**: needs identity to be meaningful, so combines with
"Per-user OAuth" above. Without per-user identity, all you can do is
slow everyone down equally on overflow — which the existing 429
retry already does.

**When to consider**: the deployment becomes load-sensitive — heavy
automation alongside human use, multiple high-throughput consumers,
etc.

---

## Reference-data caching — *implemented in v1.0.2 (master)*

See `OPTIMIZATIONS.md §1` for the landed shape and measured result.
Sixteen dictionary endpoints (pipelines, boards, custom-field
schemas, etc.) are now cached in-process with a 5-min TTL by default.

---

## Additional batched-read tools (child-list fan-out)

The `get_*` batch-fetch tools already accept up to 50 ids with
internal split-and-fan-out, and the cache covers all dictionary
reads. The remaining read-side gap is **"single parent → list of
children"** tools where N parents means N sequential Capsule calls:

- `batch_list_party_opportunities` — "what deals across these N contacts"
- `batch_list_party_projects` — "what cases on these N organisations"
- `batch_list_party_entries` — "timeline summary for these N contacts"
- `batch_list_opportunity_entries` — "what happened on these N deals"
- `batch_list_project_entries` — "what's been logged on these N cases"
- `batch_list_associated_projects` — "projects spawned by these N opps"
- `batch_list_additional_parties` — "co-deal members on these N opps"
- `batch_list_entity_tracks` — "active tracks on these N entities"

Each is a `batch_*` variant exactly like the write-side batch tools:
accept `ids: [...]` (up to 50), fan out at concurrency 5, return
per-item results with summary, emit `batch.complete` event.

**Cost** per tool: ~30 LOC wrapper + ~5 LOC registration + 3–5 tests.
The `batchExecute` helper is already in place. ~5× speedup on the
multi-parent flow.

**Why deferred**: the cache + native batch-GET cover the dominant
read-cost paths. Adding 8 more tools is real catalogue bloat
(+10% on the LLM's tool-routing surface) — worth doing when
`batch.complete` log analytics show specific child-list patterns
are common enough to justify the surface. My ranking when traffic
data lands: opportunity_entries → party_entries → project_entries
(the three highest expected-value), then the rest as needed.

---

## Additional batched-write tools

The first batched-write pass (v1.0.2) covers the five highest-value
operations: `batch_update_party`, `batch_update_opportunity`,
`batch_complete_task`, `batch_add_tag`, `batch_remove_tag_by_id`.
Deferred for now — would extend the same `batchExecute` helper if
real traffic shows demand:

- **`batch_create_*`** (create_party, create_opportunity, create_task,
  create_project). Less common as a multi-record action because
  creates typically have unique per-item data; LLM agents usually
  call them sequentially with bespoke arguments. Add if mass-import
  workflows (CSV → CRM) become common.
- **`batch_delete_*`** (delete_party, delete_opportunity,
  delete_project, delete_task, delete_entry). High blast radius —
  per-item confirms become awkward in a batch. The right ergonomics
  is one whole-batch `confirm: true` plus a top-N preview returned
  from a dry-run mode. Worth a design pass before implementation.
- **`batch_update_task`** / **`batch_update_project`** /
  **`batch_update_entry`**. Lower observed frequency than the
  party / opportunity / tag tools that shipped first. Wire the
  same way as `batch_update_party` when a use case lands.
- **`batch_add_note`**. "Add the same note to these 10 records" is
  a real use case but currently rare. Each note is an entry create
  via POST /entries; the batch shape is straightforward.
- **`remove_track`** / **`apply_track`** in batch. Track operations
  cascade in interesting ways (auto-tasks created/destroyed); needs
  per-item failure handling care.

**Cost** for each: ~30 LOC tool + ~5 LOC registration + 3-5 tests.
The `batchExecute` helper is already in place so the heavy lift is
just per-tool wrappers.

**When to consider**: server-side telemetry (`batch.complete` log
events) shows the existing batch tools are being used heavily, OR a
specific user request highlights a workflow that needs a missing
batch variant.

---

## Webhook ingest

Capsule emits webhooks for record creation / update / deletion. An
MCP server could ingest these and proactively notify Claude of
changes — "the Acme deal just moved to Won, want to draft a
celebration email?".

**Cost**: fundamentally different protocol from MCP's tool-call
model — would need a parallel non-MCP component (HTTP listener,
event store, push channel back to Claude). MCP doesn't currently
have a server→client notification channel that maps cleanly onto
this; you'd be building a chat assistant, not an MCP server.

**When to consider**: Claude's tool-use model evolves to support
proactive nudges, or someone wants to layer this as a separate
service that talks to Claude via a different surface.

---

## MCP `prompts` capability

MCP defines a `prompts` capability where a server publishes reusable
prompt templates a client can list. Once popular MCP-client UIs
surface prompts (Claude Desktop / Code do; some hosted clients
don't yet), exposing the [EXAMPLES.md](EXAMPLES.md) catalogue as
discoverable prompt templates means users can pick a prompt rather
than typing one.

**Cost**: small — register the prompts in the server constructor,
shape them to MCP's prompt schema, expose categories. ~50 LOC plus
tests.

**When to consider**: hosted clients you care about start surfacing
prompts in the UI.

---

## Add-attachment-to-existing-entry

Today `upload_attachment` always creates a new note carrying the
attachment. Adding to an *existing* entry would need a read-then-PUT
dance because Capsule's PUT semantics replace the attachments array.

**Implementation sketch**:
1. Add an `entryId` parameter to `upload_attachment`.
2. When set: GET the entry, read its current `attachments` token
   list, append the new token, PUT the entry with the merged list.
3. Surface the inevitable race condition (two concurrent uploads
   that race on the read) with optimistic-concurrency check or just
   "last write wins" with a docs note.

**Cost**: low complexity but real correctness work. The race-condition
window is small but real.

**When to consider**: people start asking "can Claude attach a file
to this note?" rather than just "create a note with this attachment".

---

## Server `instructions` field

`McpServer` accepts an `instructions` parameter that gets surfaced to
the client at initialise. Could carry a short capability summary
("you have CRM tools across these categories — for examples, call
list_examples"). Always-on context, costs tokens on every
conversation.

**Cost**: token budget, mostly. A short instructions string is
~50–100 tokens that get prepended to every conversation. Worth it
only if it measurably improves Claude's tool selection vs reading
descriptions on demand.

**When to consider**: A/B comparison shows Claude's tool-pick
quality is meaningfully better with instructions than without.

---

## `list_capabilities` / `help` tool

A no-arg tool that returns a categorised summary of what the
connector can do, plus example questions. Companion to (or
replacement for) `instructions`: token-cheap because it's only
loaded when Claude calls it.

**Implementation sketch**: bake `EXAMPLES.md` into the bundle at
build time (`tsup` can import as text), expose via a tool. Optional
`category` parameter to scope.

**Cost**: small — one new tool plus the build-time text import.

**When to consider**: users frequently ask "what can you do?" and
Claude paraphrases tool descriptions instead of giving useful
worked examples.

---

## Larger inbound attachment cap

Default `maxSizeBytes` for `get_attachment` is 5 MB
([L9](DESIGN.md)). Reasonable for Claude-context economics, but
modern PDFs can easily push past that.

Two ways to address:
- Bump the default to 10 MB or 15 MB (still well under Capsule's
  25 MB ceiling).
- Add an `extractText` mode for PDF/Office types: server-side text
  extraction so Claude gets the textual content without the binary
  weight. Requires a PDF-parsing dependency (e.g. `pdf-parse`),
  which adds bundle size.

**When to consider**: users hit the truncation wall often, or a
common workflow involves passing PDFs through Claude.

---

## Tag CRUD

`POST/PUT/DELETE` on `/<entity>/tags` work and are deliberately not
exposed (admin work; see [DESIGN.md](DESIGN.md)). If a deployment
ever wants Claude to manage the tag schema directly, they're
straightforward to add: 3 tools each for parties / opportunities /
projects, all gated by `!readOnly` and the delete tools by
`confirm: true`.

**Cost**: low complexity, ~150 LOC + tests. Per-tag concerns: tag
delete is destructive (untags every record carrying it), so the
delete tool needs a strong description.

**When to consider**: ad-hoc tag management becomes a real workflow
(e.g. "Claude, create a tag for everyone who attended the conference
this week and apply it"). Even then, more likely the ergonomic answer
is `list_parties` + iterating `update_party` calls than touching the
tag schema itself.

---

## Custom field definition CRUD

Same shape as tag CRUD — admin work, deliberately not exposed.
Adding it would let Claude provision custom fields ad-hoc.
Considered higher-risk than tag CRUD because deleting a custom
field destroys all the values stored under it.

**When to consider**: a deployment wants Claude to bootstrap a CRM
schema based on a transcript or workshop output.

---

## Explicit `teamId` on write tools — partially implemented (projects only)

Capsule's `team` is the access-control scope — multi-team tenants
use it to partition data so only members of a given team can see
or edit records owned by that team. The connector exposes `ownerId`
on every write tool but historically did **not** expose `teamId`.

**Status (alpha.17):** `teamId` is now wired on `create_project`
and `update_project`. Originally added to address what we then
believed were two Capsule API quirks on projects; one of those
(originally Bug 17 — POST dropping owner) was later reclassified
as tenant board automation, not a Capsule API rule. The teamId
parameter is still useful in its own right: it lets callers
express the USER+TEAM ownership shape explicitly without relying
on tenant-side automations to fill in the team. See
[NOTES-ON-CAPSULE-API.md §27](NOTES-ON-CAPSULE-API.md) for the
current write-semantics framing.

**Still not exposed on:** `create_party`, `update_party`,
`create_opportunity`, `update_opportunity`, `create_task`,
`update_task`. The original three motivating cases for those are
still valid:

1. **Parties and opportunities have no board concept**, so
   `create_party` / `create_opportunity` lands with `team: null`.
2. **Cross-team moves on existing records** — `update_party` /
   `update_opportunity` has no team parameter.
3. **Standalone tasks** have no anchor to inherit from.

**Implementation** (small): mirror the projects pattern —
optional `teamId: z.number().int().positive()` on the remaining
write tools, mapped to body shape `team: {id: teamId}`. Same
absent-fields-cleared PUT semantic likely applies to these
entities too; if so, the descriptions need the same WARNING
blocks projects got.

**When to consider**: a deployment hits the same
team-membership write gap for parties / opportunities / tasks
that the §15-supplementary report found for projects. Worth
deferring until concrete production demand surfaces, since adding
`teamId` to parties/opportunities likely uncovers the same
absent-field-clearing behaviour and requires the same WARNING
boilerplate.

---

## Tag-definition delete

The connector exposes `add_tag` (which creates a tag if the name is
new, otherwise attaches an existing tag) and `remove_tag_by_id`
(which detaches a tag from one entity) but has no way to delete a
tag *definition* tenant-wide. If a tag is created by mistake — typo,
test data, deprecated category — the connector can detach it from
every entity it's on, but the empty definition persists in
`list_tags` indefinitely unless deleted via Capsule's web UI.

**Why not implemented now**: deleting a tag definition is rare and
inherently destructive — it would break filter saved-searches that
reference the tag and silently drop the tag from any future
`embed=tags` reads. Capsule's web UI is the right place for that
kind of admin operation; exposing it through a connector would need
a confirm gate and probably an "is this tag used anywhere first"
pre-check.

**When to consider**: a deployment that wants to clean up
test/stale tag definitions programmatically — e.g. a post-deploy
script that drops `ZZZ-MCP-*` tag definitions left behind by
integration tests.

**Implementation sketch**: `delete_tag_definition(entity, tagId,
confirm: true)`. PUT shape probably `DELETE /<entity>/tags/{id}`
or similar — needs verification against Capsule's docs (the v2
docs don't show a tag-definition DELETE endpoint explicitly, so
this may require either a different REST shape or be a
genuine-Capsule-API-limit). Until that's confirmed, web-UI
cleanup is the documented path.

---

## Env-gated `add_note.creatorId` (on-behalf-of authoring)

`creatorId` shipped briefly on `add_note` in alpha.8 to support
logging notes attributed to a specific Capsule user other than the
API-token owner — e.g. recording that a colleague attended a
meeting, attributed to that colleague, even though the connector's
service token is making the call. Removed in alpha.13 after a
security review (issue #11) found that the override + natural-
language write access + a shared connector = trivial audit-
attribution spoofing.

The legitimate use cases haven't gone away:
- Migrating historical notes from another CRM where authorship is
  recorded per-note rather than per-importer
- A pure-automation flow where a service account writes notes that
  should logically be attributed to the team member whose actions
  the automation reflects

**When to consider re-adding**: a deployment surfaces one of those
workflows and is willing to opt in explicitly.

**Implementation sketch**: gate behind an env var
`CAPSULE_MCP_ALLOW_CREATOR_OVERRIDE=yes`, default off. When the
gate is set:
- `addNoteSchema` includes a `creatorId: z.number().int().positive().optional()` field, with a description that names the audit-implication openly.
- Handler maps `creatorId → entry.creator: {id}` as alpha.8 did.

When the gate is unset (default):
- The schema does NOT include the parameter at all (so Claude can't see it as an option).
- The handler doesn't map anything.

This keeps the security default safe and surfaces the feature only
where an operator has explicitly green-lit it. The DEPLOY.md
operational notes should describe the audit implication of enabling
the gate, so the opt-in is informed.

---

## External-backed `TaskStore` for multi-instance MCP Tasks

**Status**: future upgrade path. Not blocking v1.6.

**Why**: v1.6 ships MCP Tasks (SEP-1686) on top of the SDK's
`InMemoryTaskStore`, wrapped per-clientId in `src/tasks/store.ts`.
In-memory is the right call for our current Cloud Run topology
(`max_instance_count=1`, `min_instance_count=0`, 50 concurrent
reqs/instance) — tasks survive across the stateless-POST request
boundary because they live on the singleton, and there's never a
second instance to disagree with.

Two pressures could change that:

1. **Scale to N instances.** If a tenant's traffic ever exceeds
   what one instance can serve, the per-revision instance cap goes
   up and the singleton stops being unique. A task created on
   instance A is invisible to a `tasks/get` that lands on instance
   B. This is the failure mode SEP-1686's spec text calls out.

2. **Scale-to-zero loss.** Even today, a task created at second 0
   and not polled to completion before the instance recycles
   (Cloud Run's idle timer or a deploy) is silently dropped. With
   `min_instance_count=0` this is real, even at low traffic.

**Implementation sketch**: the SDK's `TaskStore` interface
(`@modelcontextprotocol/sdk/experimental/tasks/interfaces.js`) is
deliberately shaped to be swap-in. Drop a new file at
`src/tasks/firestore-store.ts` (or `redis-store.ts`) implementing
the same 6-method surface. Keep the per-clientId scoping wrapper
unchanged — it works against any `TaskStore`. Add an env switch
`MCP_TASKS_STORE=memory|firestore` (default `memory`).

For Firestore specifically: one collection per server, document id
= taskId, fields = `{ clientId, status, ttl, pollInterval, result,
createdAt, completedAt }`. TTL eviction via a Firestore TTL policy
on `createdAt + ttl` — no application-side timers needed.
Per-clientId quota is a single counted-query on `where('clientId',
'==', X)`. Reads cost one document GET; the SDK polls ~1500 ms by
default, so a stuck task costs ~40 reads/minute per client — fine.

Cost-wise: one tenant doing 100 batch_* tasks/day at ~4s wall-clock
each ≈ 100 × (4s / 1.5s) = 270 polls = 270 reads/day = sub-cent.
Add when needed, not before.

---

## (Add new entries above this line.)
