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

## Reference-data caching

Cache the rarely-changing reference data (teams, lost reasons,
custom field definitions) with a short TTL. Bigger benefit if a
single Claude turn asks many questions that need the same metadata.

**Implementation sketch**: in-memory map with TTL, invalidated on
process restart. Add it to the `metadata.ts` tools first; don't
extend to anything that changes (parties, opportunities, entries) —
the staleness window is worse than the round-trip cost.

**Cost**: low. Mostly thinking through invalidation: if an admin
deletes a custom field in the Capsule UI mid-conversation, the
cached copy lies until TTL expires.

**When to consider**: traces show >50% of reference-data calls in a
typical session are duplicates within seconds.

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

## Explicit `teamId` on write tools

Capsule's `team` is the access-control scope — multi-team tenants
use it to partition data so only members of a given team can see
or edit records owned by that team. The connector exposes `ownerId`
on every write tool but **does not expose `teamId`**.

For project creation the implicit path covers most workflows:
creating a project on a board whose default team is, say,
"Region X" inherits that team automatically. Capsule does the
assignment without the connector touching `team` at all.

The implicit path falls short in three cases:

1. **Parties and opportunities have no board concept**, so
   `create_party` / `create_opportunity` lands with `team: null`. A
   team-gated party can't be created through the connector.
2. **Cross-team moves on existing records** — you can't change a
   project's team by changing its board (each board belongs to one
   team), and `update_*` has no `team` parameter, so there's no
   write path at all.
3. **Standalone tasks** have no anchor to inherit from.

**Implementation** (small): optional
`teamId: z.number().int().positive()` on `create_party`,
`update_party`, `create_opportunity`, `update_opportunity`,
`create_project`, `update_project`, and possibly `create_task` /
`update_task`. Maps to Capsule's body shape `team: {id: teamId}`,
mirroring the existing `ownerId` pattern. Discover IDs via the
existing `list_teams` tool.

**When to consider**: a deployment that wants connector-driven
records on a team scope other than the implicit board default, or
that needs to move records between teams without using Capsule's
web UI. For deployments where team partitioning is purely
board-level, the implicit path is sufficient and adding the
parameter is unnecessary surface.

---

## (Add new entries above this line.)
