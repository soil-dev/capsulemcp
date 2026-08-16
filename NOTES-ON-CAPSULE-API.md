# Notes on Capsule CRM's v2 API

A reference of the surprising / non-obvious behaviour of Capsule's v2
REST API, discovered while building capsulemcp. Each entry quotes the
relevant snippet of Capsule's official documentation verbatim (so the
quotes survive even if the docs change), then describes how we encode
the quirk in our code.

Useful for:
- maintainers of capsulemcp who hit "why does this look weird?";
- anyone writing a Capsule v2 integration in any language, who can
  skip rediscovering the same things by hand.

If a quote here ever stops matching Capsule's docs or behaviour, treat
the *behaviour* as authoritative — these notes are a snapshot and
their truth comes from runs against the live API, not from the docs.

Last sync: 2026-05-13. capsulemcp commit: see `git log NOTES-ON-CAPSULE-API.md`.

---

## 1. Filter-side field names differ from response-side names

The structured-filter endpoint accepts a different vocabulary of field
names than the JSON response payloads use. Sending `lastContactedAt` —
the response field name — to the filter endpoint returns
`422 Validation Failed: invalid field name`.

**Where in our code:** [`src/tools/filters.ts`](src/tools/filters.ts)
documents the mapping in a header comment and surfaces it in the
zod schema's field description.

**Quote** — Capsule's filter reference at
<https://developer.capsulecrm.com/v2/reference/filters> lists the
allowed filter-side field names per entity:

> Party Filter Fields:
> `id, name, jobTitle, email, phone, city, zip, state, country, type,
> tag, owner, team, hasEmailAddress, hasPhoneNumber, hasAddress,
> hasPeople, hasTags, addedOn, updatedOn, lastContactedOn,
> custom:{fieldId}, org.custom:{fieldId}, org.name, org.tag`

> Opportunity Filter Fields:
> `id, name, status, pipeline, milestone, probability, lostReason,
> currency, expectedValue, tag, owner, team, isOpen, isStale,
> isOwnedByMe, hasTags, addedOn, updatedOn, closedOn, expectedCloseOn,
> custom:{fieldId}`

> Project Filter Fields:
> `id, name, status, board, stage, tag, owner, team, isOpen,
> isOwnedByMe, hasTags, addedOn, updatedOn, closedOn, expectedCloseOn,
> custom:{fieldId}`

The asymmetry between filter-side and response-side names:

| Response payload field | Filter-side field |
|---|---|
| `createdAt` | `addedOn` |
| `updatedAt` | `updatedOn` |
| `lastContactedAt` | `lastContactedOn` |

`closedOn` and `expectedCloseOn` use the same name on both sides.

---

## 2. POST /tracks expects `definition`, not `trackDefinition`

Capsule's GET response for a track instance contains a
`trackDefinition` field. It's tempting to use the same key in the POST
body when applying a track. Capsule rejects that: `422 Validation
Failed: track definition is required; field=definition`. The body
field name is `definition`, not `trackDefinition`.

**Where in our code:** [`src/tools/tracks.ts`](src/tools/tracks.ts)
`applyTrack()`. Mock-only tests in `tests/tracks.test.ts` had been
asserting the wrong shape (mocked Capsule incorrectly); the
[`scripts/wire-trace.ts`](scripts/wire-trace.ts) script caught it
during the v1.0.0 functional sweep.

**Quote** — Capsule's Track docs at
<https://developer.capsulecrm.com/v2/operations/Track> show the
request body example:

> ```json
> {
>   "track" : {
>     "description" : "Complaint Process (Important)",
>     "trackDateOn" : "2016-01-01",
>     "kase" : 4,
>     "definition" : 1
>   }
> }
> ```

The field referencing the track definition is named `"definition"`
(not `trackDefinition`). On the response side Capsule notes:

> Some of the properties used when applying the track are "write-only"
> and will not be included in the response.

In practice the omitted properties are `"definition"` and the entity
reference (`kase`, `party`, or `opportunity`); the response carries
only the generated track with its ID and associated tasks. Capsule's
prose is generic, hence the explicit list here.

---

## 3. Add/remove additional party returns 204 No Content

`POST /opportunities/{id}/parties/{partyId}` (and the symmetric
`DELETE`) returns 204 with an empty body. Generic `POST` helpers that
always call `res.json()` will crash with `Unexpected end of JSON
input`.

**Where in our code:** [`src/capsule/client.ts`](src/capsule/client.ts)
`capsulePostNoContent()` is a focused helper that handles the empty
body. Used by
[`src/tools/relationships.ts`](src/tools/relationships.ts)
`addAdditionalParty`. The mock-only test in
`tests/relationships.test.ts` was modelling Capsule wrong (mocked a
200 with JSON body); the wire-trace caught it.

**Quote** — Capsule's Opportunity docs at
<https://developer.capsulecrm.com/v2/operations/Opportunity>:

> Add additional party: POST
> `https://api.capsulecrm.com/api/v2/opportunities/{opportunityId}/parties/{partyId}`
> "Returns status code 204 with an empty body if the related contact
> was successfully added."

> Remove additional party: DELETE
> `https://api.capsulecrm.com/api/v2/opportunities/{opportunityId}/parties/{partyId}`
> "Returns status code 204 with an empty body if the related contact
> was successfully deleted."

The same pattern (POST+204) is used by the project-side equivalents
on `/kases/{id}/parties/{partyId}`.

---

## 4. Attachment upload is raw POST, NOT multipart/form-data

Capsule's attachment-upload endpoint ignores `multipart/form-data`.
The file goes as the raw HTTP body, with three required custom
headers.

**Where in our code:**
[`src/capsule/client.ts`](src/capsule/client.ts) `capsulePostBinary()`,
called by [`src/tools/attachments.ts`](src/tools/attachments.ts)
`uploadAttachment()`. The TODO.md draft for this feature originally
assumed multipart and would have been wrong; live verification before
implementation surfaced the actual shape.

**Quote** — Capsule's Entry docs at
<https://developer.capsulecrm.com/v2/operations/Entry>:

> Upload Attachment Operation Summary
>
> HTTP Method: POST
>
> Request Format: "The contents of the file being uploaded should be
> submitted as the body of the request" — this indicates raw binary
> body submission, not multipart/form-data.
>
> Required Headers:
>
> - `Content-Type` — should reflect the file's MIME type
> - `Content-Length` — must specify file size in bytes
> - `X-Attachment-Filename` — should contain the URL-encoded filename
>
> Response Shape:
>
> ```json
> {
>   "upload" : {
>     "token" : "u1/e0/c8a5a36b-972c-405e-89ca-9a2a5c9ff192/..."
>   }
> }
> ```

The token is then referenced in the `attachments` array of a
subsequent `POST /entries` call to actually link the upload to a note.

---

## 5. The "current user" endpoint is /users/current, not /users/me

GitHub-style API muscle memory says `/users/me`. Capsule's actual path
is `/users/current`. `GET /users/me` returns 404 "Could not find
resource".

**Where in our code:** [`src/tools/users.ts`](src/tools/users.ts)
`getCurrentUser()`. (capsulemcp v0.5.0 originally claimed the endpoint
didn't exist at all and worked around it with `getSite`; v1.0.0
added the real one after re-reading the docs more carefully.)

**Quote** — Capsule's User docs at
<https://developer.capsulecrm.com/v2/operations/User>:

> `GET https://api.capsulecrm.com/api/v2/users/current`
>
> Shows the details of the user the provided access token is associated
> with. In most cases this will be the user who approved your
> application.

---

## 6. /tasks has no soft-delete listing

Parties, opportunities, and projects all have a `GET
/<entity>/deleted` endpoint that returns records deleted on or after
a `since` timestamp. Tasks do not.

**Where in our code:** noted in [`DESIGN.md`](DESIGN.md) and in
[`src/tools/audit.ts`](src/tools/audit.ts) (which has
`list_deleted_parties`, `list_deleted_opportunities`,
`list_deleted_projects` but no task counterpart).

**Quote** — Capsule's Task docs at
<https://developer.capsulecrm.com/v2/operations/Task> list the full
operation surface:

> Available Task operations:
>
> - "List tasks"
> - "Show task"
> - "Create task"
> - "Update task"
> - "Delete task"

> There is no "List deleted tasks" or audit endpoint for deleted
> tasks in the Task operations. This contrasts with other resources
> like Party and Opportunity, which include "List deleted parties"
> and "List deleted opportunities" operations respectively.

---

## 7. Tracks are entity-scoped — there is no global GET /tracks

`GET /tracks` returns 405 Method Not Allowed. Tracks are reachable
only via:

- `GET /<entity>/{id}/tracks` — instances on a specific record
- `GET /tracks/{id}` — a single instance by id
- `POST /tracks` — apply (create) a new instance
- `PUT /tracks/{id}` — update
- `DELETE /tracks/{id}` — remove

The companion `GET /trackdefinitions` exists for the *templates*.

**Where in our code:** [`src/tools/tracks.ts`](src/tools/tracks.ts)
implements all five entity-scoped track operations and the templates
list.

---

## 8. /entries has no batch fetch

`GET /entries/{ids}` (comma-separated, the syntax that works for
parties, opportunities, projects, and tasks) returns 404 for entries.
Capsule v2 just doesn't expose batch fetch for the timeline-entry
resource.

**Where in our code:** noted in [`DESIGN.md`](DESIGN.md) and in
[`src/tools/entries.ts`](src/tools/entries.ts) (no `get_entries`
counterpart to `get_parties`, `get_opportunities`, `get_projects`,
`get_tasks`).

---

## 9. Custom field schema lives at /<entity>/fields/definitions

Naive guesses like `/<entity>/customfields` or `/<entity>/customFields`
return 404. The actual path is `/<entity>/fields/definitions`. This
bit us in v0.5.0 — endpoints documented in Capsule's docs were
dismissed as "404 in test account" because of wrong-path probes.
v0.5.1 reinstated them after re-reading the docs.

**Where in our code:**
[`src/tools/custom-fields.ts`](src/tools/custom-fields.ts).

**Quote** — Capsule's Custom Field docs at
<https://developer.capsulecrm.com/v2/operations/Custom_Field>:

> List custom fields:
> `GET https://api.capsulecrm.com/api/v2/{entity}/fields/definitions`
>
> Show custom field:
> `GET https://api.capsulecrm.com/api/v2/{entity}/fields/definitions/{fieldId}`

---

## 10. Projects are `/kases` everywhere in URLs

Capsule's old name for "Project" was "Case", so every project URL
uses `/kases`. The web UI says "Projects". The API uses `/kases`. JSON
response keys use `kase` / `kases`.

**Where in our code:** every tool that touches projects routes the
URL accordingly. The user-facing tool names use "project" terminology
even though the URLs underneath are `/kases`. See for example
[`src/tools/projects.ts`](src/tools/projects.ts) `getProject` →
`GET /kases/{id}`.

**Quote** — Capsule's Project docs at
<https://developer.capsulecrm.com/v2/operations/Project>:

> the API endpoints have not been changed as it would be a breaking
> change for existing applications. The endpoints spell cases with a
> 'k', this was to prevent clashes with `case` which is a reserved
> word in many languages.

---

## 11. Filter results endpoint is POST, has no orderBy

The endpoint that runs an ad-hoc filter takes structured conditions
in a request body, so it has to be POST — but it's semantically a
read. And critically, **it does not support sort.** Sort is only
available through *saved* filters configured in Capsule's web UI;
those carry an `orderBy` configured at save time.

**Where in our code:**
[`src/tools/filters.ts`](src/tools/filters.ts) (ad-hoc filter; no
sort) and [`src/tools/saved-filters.ts`](src/tools/saved-filters.ts)
(saved filters; sort honoured).
[`src/capsule/client.ts`](src/capsule/client.ts) has a dedicated
`capsuleSearch()` helper for POST-based reads — bypasses the
read-only-mode gate that `capsulePost()` enforces.

**Quote** — Capsule's Filter docs at
<https://developer.capsulecrm.com/v2/operations/Filter>:

> Path: `https://api.capsulecrm.com/api/v2/{entity}/filters/results`
>
> HTTP Method: POST

> The documentation does not include any sort or orderBy parameters.
> The request body schema contains only a `"filter"` object with
> `"conditions"` array for search criteria. Query parameters supported
> are: `page`, `perPage`, and `embed` — none of which relate to
> sorting or ordering results.

The capsulemcp workaround for "give me the most recent X" without
saved filters: filter by a date condition, pick the highest id from
the result. Capsule numeric IDs are monotonically incrementing, so
the highest id within a date-bounded window is the newest record.

---

## 12. Batch fetches are comma-separated in the path, capped at 10

For parties, opportunities, projects, and tasks, you can fetch up to
10 records by id in one round trip with `GET /<entity>/{id1},{id2},…`.
Sending 11 or more returns "too many ids".

**Where in our code:** the four `get_<entity>s` (plural) tools are
schema-validated to `min(1).max(50)`; `chunkedMultiGet`
([`src/capsule/multi-get.ts`](src/capsule/multi-get.ts)) then splits the
ids into 10-id chunks, fans them out in parallel, and concatenates the
responses — so a caller can pass up to 50 while still honouring
Capsule's per-request cap of 10. See for example
[`src/tools/parties.ts`](src/tools/parties.ts) `getParties()`.

**Quote** — Capsule's Party docs at
<https://developer.capsulecrm.com/v2/operations/Party>:

> Show Multiple Parties:
> `GET https://api.capsulecrm.com/api/v2/parties/{partyIds}`
>
> "partyIds must be a comma separated list of integers and can
> contain at most 10 values"

The same wording (and 10-id cap) appears in the Opportunity, Project,
and Task docs.

---

## 13. /<entity>/deleted requires a `since` timestamp

Calling `GET /parties/deleted` with no params returns
`422 Validation Failed: since is required`. The timestamp must be
ISO-8601.

**Where in our code:** [`src/tools/audit.ts`](src/tools/audit.ts)
makes the parameter required at the schema layer.

**Quote** — Capsule's Party docs at
<https://developer.capsulecrm.com/v2/operations/Party>:

> List Deleted Parties:
> `GET https://api.capsulecrm.com/api/v2/parties/deleted`
>
> The since date is required to return only entities that have been
> deleted after this date. Must be in ISO8601 format.

---

## 14. Pagination: default 50, max 100; Link header carries the cursor

Most list endpoints paginate. Default page size is 50, max is 100.
The standard RFC 5988 `Link` header is included on the response with
`rel="next"` for the next page (when one exists).

**Where in our code:**
[`src/capsule/client.ts`](src/capsule/client.ts) `parseNextPage()`
extracts the next-page number from the `Link` header. Tools default
their `perPage` to 25 (most operations) or 100 (reference data, where
a single page usually fits everything).

This convention isn't quoted from a single Capsule doc page — it's
consistent across every paginated endpoint and matches the parameter
shape `(page, perPage)` shown in every operation's "Query Parameters"
section.

---

## 15. Tag filtering accepts both name and id

The `tag` filter field accepts either the tag name (string) or the
tag id (number). The Capsule docs aren't explicit about this; verified
empirically.

**Where in our code:**
[`src/tools/filters.ts`](src/tools/filters.ts) `value` is typed as
`string | number | boolean | null` to allow either form.

---

## 16. Capsule's response keys are stable but quirky

A few that surprise on first encounter:

- The Party response uses `firstName` / `lastName` for people,
  `name` for organisations. The same record discriminator is `type:
  "person" | "organisation"`.
- Opportunity / project response keys: `lastContactedAt`,
  `closedOn`, `expectedCloseOn`, `addedOn` (mix of `*At` for
  timestamps and `*On` for dates without time-of-day).
- Loss reasons: response key is `lostReasons` (camelCase plural),
  endpoint path is `/lostreasons` (lowercase one-word).
- Activity types: response key `activityTypes`, endpoint path
  `/activitytypes`. Same shape as lost reasons.
- Track *templates* are at `/trackdefinitions` and the response key
  is `trackDefinitions`. Track *instances* are at `/tracks` /
  `/<entity>/{id}/tracks`. (The asymmetry from §2 — the POST-body
  field name `definition` vs the response key `trackDefinition` —
  appears here too.)

**Where in our code:** every tool's response handler uses Capsule's
exact response keys verbatim, so the surface is one-to-one
debuggable against Capsule's docs.

---

## 17. Rate-limit reset is signalled via `X-RateLimit-Reset`, not `Retry-After`

Capsule's API uses an hourly bucket (4,000 requests per user per
hour with Bearer Token auth). When a caller exhausts the bucket the
response is `429 Too Many Requests` with body
`{"error":"rate limit reached"}`, and three headers tell the caller
exactly when to resume:

```
X-RateLimit-Limit:     4000
X-RateLimit-Remaining: 0
X-RateLimit-Reset:     <UTC epoch seconds — when the window resets>
```

There is **no `Retry-After` header**, the standard RFC 7231 signal —
clients that only honour `Retry-After` will fall back to whatever
default they have (likely tens of seconds), retry against an empty
quota, and either burn cycles in a tight loop or wait far longer
than necessary. The same `X-RateLimit-*` headers are also returned
on every successful response, so a careful client can throttle
proactively before hitting 429.

**Where in our code:** [`src/capsule/client.ts`](src/capsule/client.ts)
`parseRateLimitDelay()` honours `X-RateLimit-Reset` first, falls
back to `Retry-After` defensively, then to a 5-second default. The
delay is clamped at 60 seconds so a far-future reset can't block a
Cloud Run request indefinitely; if Capsule says "wait 50 minutes" we
wait the clamped 60 s, retry once, and surface the 429 only if that
retry is also throttled — we never hold the connection open for the
full reset window.

**Quote** — Capsule's response-handling docs at
<https://developer.capsulecrm.com/v2/overview/handling-api-responses>:

> Each Capsule user can make up to 4,000 requests per hour.
>
> ```
> HTTP/1.1 429 Too Many Requests
> X-RateLimit-Limit: 4000
> X-RateLimit-Remaining: 0
> X-RateLimit-Reset: 1434037662
>
> {
>   "error":"rate limit reached"
> }
> ```
>
> [The client should] wait until the time inside the
> `X-RateLimit-Reset` header before it makes any other API requests
> for the specific user.

---

## 18. Nested-collection delete uses `_delete: true`, not Rails-style `_destroy: true`

Capsule's PUT for a Party (and Opportunity, Project, etc.) treats
child-collection items via three rules baked into the request body
shape:

- Add: item without `id` → Capsule appends.
- Update: item with `id` plus the fields being changed → Capsule
  edits that row.
- **Delete: item with `id` plus `"_delete": true` → Capsule removes
  that row.**

The leading-underscore convention is Rails-ish, but the field name
is `_delete` (not `_destroy`). This is a real footgun: Rails apps
overwhelmingly use `_destroy: true` for `accepts_nested_attributes_for`
collections, so it's natural to assume Capsule does the same. It
doesn't. Sending `{"id": 42, "_destroy": true}` returns 200 OK with
the row still present — silent no-op. The server registers the PUT
(for `addresses` we even saw `updatedAt` advance by 1 second) but
the destroy flag is ignored.

**Where in our code:** [`src/tools/parties.ts`](src/tools/parties.ts)
`removePartyEmailAddressById`, `removePartyPhoneNumberById`,
`removePartyAddressById`, `removePartyWebsiteById`. v1.0.0-alpha.7
shipped with the wrong field (`_destroy`); fixed in the followup
commit after the production verification run flagged all four
tools as broken (Bug 9 in the alpha.7 verification report).

**Quote** — Capsule's Party docs at
<https://developer.capsulecrm.com/v2/operations/Party>:

> To add a new entity: create an entity without an id.
>
> To update an existing entity: include the id and any attributes
> that are being updated.
>
> To delete an existing entity: include the id and the following
> JSON attribute `"_delete": true`.

Example payload combining all three (verbatim from the same page):

> ```json
> {
>   "party": {
>     "phoneNumbers": [
>       {
>         "id": 12136,
>         "_delete": true
>       }
>     ],
>     "emailAddresses": [
>       {
>         "id": 12137,
>         "type": "Home"
>       },
>       {
>         "type": "Work",
>         "address": "sales@homestyleshop.co"
>       }
>     ]
>   }
> }
> ```

The same rules apply uniformly to `addresses`, `phoneNumbers`,
`websites`, `emailAddresses`, and custom `fields` on Party,
Opportunity, and Project. The `addresses` case was wire-traced
directly: a `PUT {addresses:[{id, _delete:true}]}` removed the row in
~270 ms and a re-read confirmed it gone — same shape, same behaviour as
the others.

---

## 19. POST /tracks body field is `trackDateOn`, not `startDate`

Sibling to §2. Capsule's POST /tracks body has two field-naming
asymmetries from common API convention:
- The track-definition reference key is `definition` on POST,
  `trackDefinition` on GET (covered in §2).
- The track-start-date key is **`trackDateOn`** on POST. Sending
  `startDate` (the obvious caller-side name) results in Capsule
  silently dropping the field — the resulting track lands at
  today's date and every auto-task computes its `dueOn` from today
  rather than the supplied start.

`trackDateOn` IS visible in Capsule's verbatim POST body example
(see §2's quote), but it's easy to miss when scanning for "where
do I put the start date" and end up at `startDate`. We tripped on
this through alpha.13 (Bug 13 in the §11-12 verification).

**Where in our code:** [`src/tools/tracks.ts`](src/tools/tracks.ts)
`applyTrack()` — the user-facing parameter is `startDate` (more
intuitive), but the handler maps to `trackDateOn` on the way out.

---

## 20. Tag id is a single tenant-global value, not a per-entity link id

When Capsule's per-entity docs (Opportunity, Kase, Party) describe
removing a tag via `{id, _delete: true}`, the phrasing reads as if
the `id` is a per-entity *link id* — i.e. each (entity, tag) pair
has its own row id. We initially documented this — and warned
callers — that the id from `list_tags` was different from the id
from `get_*?embed=tags`. Verified live during the alpha.10
verification: the two are the same id. Capsule uses a single
tenant-global tag id everywhere. Detaching via that id removes the
link on the specific entity; the tag definition persists for other
entities that share it.

**Where in our code:** [`src/tools/tags.ts`](src/tools/tags.ts) —
the file header now states the verified single-id model;
`remove_tag_by_id.tagId`'s description recommends reading via
`embed=tags` first (not because the ids differ, but because that
read confirms the tag is actually attached to the entity — a
list_tags id for a tag NOT on this entity would 422).

**Empirical confirmation** (alpha.10 production verification):
three tags read via `list_tags` and via `get_party?embed=tags`
returned identical ids in both responses. Attaching the same tag
to two different parties resulted in both parties' tag entries
carrying the same id. No per-entity link id distinct from the
global tag id exists in Capsule's model.

---

## 21. Custom-field clearing: `value: null` works for most types but rejects BOOLEAN; BOOLEAN is two-state

For `update_party`, `update_opportunity`, and `update_project`'s
`fields` array, passing `value: null` on a row removes the value
for TEXT / NUMBER / DATE / LIST / LARGE_TEXT / LINK fields cleanly
(Capsule responds 200 OK and the read-back shows the field gone).

**BOOLEAN is the exception.** Sending
`{definition: {id}, value: null}` for a BOOLEAN field returns
`422 field.value: invalid type for field`. Capsule rejects null
specifically for booleans; the API has no other documented "clear"
shape for them. Workaround: set the field to `false`.

**BOOLEAN fields are observably two-state, not three-state.**
Setting `value: false` on a BOOLEAN field is accepted by Capsule
(200 OK, `updatedAt` advances), but the **read-back via
`embed=fields` returns the row absent**, not a row with
`value: false`. So the observable states for a BOOLEAN custom
field are:

- A row exists with `value: true`
- No row exists (achievable via either initial unset OR `value: false`)

Callers comparing BOOLEAN values must treat absent rows as
equivalent to false. Tri-state semantics (true / false / unknown)
are not achievable through Capsule's API. (Earlier versions of
this section suggested a `_delete: true` row-shape workaround for
tri-state; that workaround doesn't actually help because the
read-back from `value: false` is also row-absent.)

**Is this a Capsule bug?** Defensible as a deliberate design
choice: BOOLEAN's value domain is `{true, false}`, so `null` is
genuinely not a valid BOOLEAN, and the 422 is a type rejection
like any other. The framing "BOOLEAN row-existence is the
semantic; `value: false` removes the row" is internally
consistent IF you accept that frame. The visible **API
asymmetry** with other field types' null-clear mechanism is the
hard-to-defend piece — a caller writing generic field-clearing
code has to special-case BOOLEAN — but the behaviour has been
stable across the API-v2 lifetime and there's no signal Capsule
plans to change it. We treat this as **documented Capsule
behaviour with a clean workaround**, not a bug to be fixed.

Re-verified live on 2026-05-13 against the production tenant:
BOOLEAN-null still 422s with the same wording, `value: false`
still removes the row.

**Where in our code:** [`src/tools/custom-field-helpers.ts`](src/tools/custom-field-helpers.ts)
`CustomFieldWriteSchema.value` description spells out the
BOOLEAN-specific rejection and the two-state read-back.

**No Capsule docs page mentions the BOOLEAN-null restriction or
the two-state observable behaviour.**

---

## 22. NUMBER custom-field values are returned as strings via `embed=fields`

A read-back quirk. Setting `value: 3` on a NUMBER custom field
stores correctly, but `get_party?embed=fields` (or the
get_opportunity / get_project equivalents) returns `value: "3"` —
a string, not a number. Callers comparing values across reads and
writes need to coerce.

The other type-direction is consistent — string values come back
as strings, boolean values come back as booleans. NUMBER is the
only type Capsule serialises out as a string instead of its
native JSON type.

**Where in our code:** [`src/tools/_custom-fields.ts`](src/tools/_custom-fields.ts)
`CustomFieldWriteSchema.value` description warns about this.
Observed in alpha.10 verification.

---

## 23. Data tags are NOT auto-attached when setting custom fields under them

In Capsule, custom-field definitions can live under a "data tag"
that gates a set of related field definitions (e.g. an account
might have a `Contract Details` data tag gating contract-related
fields like dates, pricing, terms). The intuitive expectation is
that setting a field under a data tag implicitly attaches the data
tag to the entity. Capsule does NOT do this.

Setting a custom field under a data tag successfully writes the
field — and the row's internal `tagId` is populated — but the
entity's visible `tags` array remains empty unless you explicitly
`add_tag` the data tag. A caller reading `get_project?embed=tags`
after setting fields won't see the data tag.

**Practical effect:** workflows that gate behaviour on "is this
record tagged with X" need to call `add_tag` explicitly after
setting fields; setting fields alone is not enough.

**Where in our code:** [`src/tools/projects.ts`](src/tools/projects.ts)
`update_project.fields` description includes a "Project-specific"
note about this. The same effect applies to parties and
opportunities but it's most operationally relevant to projects,
where data tags commonly gate lifecycle workflows. Observed in
alpha.10 verification.

---

## 24. Capsule's "already done" idempotency error wordings (catch list)

For destructive ops where the target is already gone or never
existed, Capsule returns one of a small set of specific 404/422
error message strings. The connector's `idempotent()` helper
(`src/capsule/idempotent.ts`) catches these to convert "already
done" into a success shape.

The exact wordings, captured from production verifications:

- **`add_additional_party` re-adds:**
  - `party is already a contact for this opportunity` (422)
  - `party is already related to this opportunity` (422) — fires
    when the target is the entity's MAIN party, not an additional.
    Different message, same end-state ("link exists, no-op").
- **`remove_*_by_id` on a not-attached row:**
  - For party child arrays (email/phone/address/website): 404
    (no specific message; Capsule's standard "doesn't exist")
  - For tag detach (PUT with `_delete: true`): 422 with message
    `tag not found to delete` — Capsule uses 422 here, not 404,
    because the PUT itself succeeded at the API layer; only the
    nested-collection mutation failed.
- **DELETE on already-deleted parent:**
  - All `delete_*` tools: 404 (Capsule's standard "doesn't exist")
  - Captures messages like `party not found`, `task not found`,
    `tag not found`.

**Where in our code:** [`src/capsule/idempotent.ts`](src/capsule/idempotent.ts)
defines two predicates — `isCapsule404` (default, covers most
ops) and `isCapsuleTagNotFound` (used by `remove_tag_by_id` for
the 422 case). Other 422s with different wording still surface
as errors.

**No Capsule docs page enumerates these error messages.** They
were captured empirically through the production write-mode
verifications (sections 9-12 of the bug-report runs).

---

## 25. Track instances are NOT cascaded when their parent opp/project is deleted

Capsule's `DELETE /parties/{id}` cascades to linked notes, tasks,
opportunities, projects (kases), and the additional-party links
on those entities. But **track instances applied to those
opportunities/projects survive the cascade** — they become orphan
records, reachable only by track id via `GET /tracks/{id}`. The
auto-tasks created by the track ARE cascaded (because tasks are
opp/project children); the track instance itself is not.

The same is true for direct `DELETE /opportunities/{id}` or
`DELETE /kases/{id}`.

**Practical impact:** negligible per delete. But repeated
apply-track + delete-entity cycles accumulate orphan tracks in
the tenant indefinitely. `list_entity_tracks` can't surface them
(the entity is gone); only `get_track` by id does.

**Workaround:** call `remove_track` explicitly before
`delete_party` / `delete_opportunity` / `delete_project` on each
applied track instance, if orphan accumulation matters.

**Where in our code:** [`src/server.ts`](src/server.ts) —
`delete_party`'s tool description warns about this quirk.
Verified live in §13 of the production write-mode bug-report.

**No Capsule docs page mentions this.** The cascade-on-delete
behaviour is documented but tracks aren't called out as the
exception.

---

## 26. Cross-pipeline / cross-board relocation is silently allowed

Capsule does NOT validate that an opportunity's new `milestoneId`
belongs to its current pipeline, nor that a project's new
`stageId` belongs to its current board. Passing a milestoneId
from a different pipeline on `update_opportunity` silently
relocates the opportunity to that pipeline. Same shape for
`update_project` and stageId.

Second-order quirk: `lastOpenMilestone` (which Capsule maintains
for "what stage did this die at" auditing) can end up
referencing a milestone in the previous pipeline — broken
cross-pipeline provenance.

**Is this a Capsule bug?** Defensible as a deliberate design
choice: in Capsule's data model the opportunity has one canonical
relationship (to a milestone), and the pipeline is derived
(`milestone.pipeline`). The API trades validation for surface
minimalism. The dangling `lastOpenMilestone` is the only piece
that's hard to defend as intentional. The behaviour has been
stable across the API-v2 lifetime, and Capsule's web UI requires
an explicit pipeline-selector step for the same mutation —
suggesting the API team has consciously chosen the lower-friction
surface. We treat this as **documented Capsule behaviour with
footgun potential**, not a bug to be fixed.

**Practical impact for callers:** real risk for any workflow
that constructs milestoneId values from caller input without
first checking the opportunity's current pipeline. A typo or
stale id can move a deal across the org's pipeline boundary
without warning.

**Workaround:** read the entity first; cross-check the new
milestone's `pipeline` (or stage's `board`) before issuing the
update.

**Where in our code:** [`src/tools/opportunities.ts`](src/tools/opportunities.ts)
`update_opportunity.milestoneId` and
[`src/tools/projects.ts`](src/tools/projects.ts)
`update_project.stageId` both carry a verbose WARNING in their
descriptions. A connector-side pre-fetch validation was
considered and rejected as overkill — the description warning
is sufficient given the design-choice framing.

**No Capsule docs page mentions this.** The relocation is
accepted as if it were a normal update. Re-verified live on
2026-05-13 against the production tenant.

---

## 27. Project `owner` / `team` write semantics (asymmetric PUT)

Capsule's data model allows a project to be in one of three
ownership shapes — and Capsule enforces that one of them always
holds:

1. **`owner` alone** — owned by a specific user, no team scope.
2. **`team` alone** — no owner, scoped to a team.
3. **`owner` + `team`** — both set; the owner must be a member of
   the team (users can belong to multiple teams).

Constraints (both 422 on violation):

- **Owner-or-team-required.** A project cannot have both `owner`
  and `team` set to null. Capsule returns `422 kase: owner or team
  is required`.
- **Owner-must-be-in-team.** When both are set, the owner must be
  a member of the team. Capsule returns `422 kase: owner is not a
  member of the team`.

### Rule A — PUT `/kases/{id}`: setting `owner` clears `team`, but setting `team` preserves `owner`

The owner/team half of the PUT semantic is **asymmetric**:

- **`owner` in body, `team` absent** → Capsule clears `team` to
  null. (`update_project { ownerId: U }` alone on a project with
  `team: T` produces `owner: U, team: null` regardless of whether
  U is in T.)
- **`team` in body, `owner` absent** → Capsule preserves the
  existing `owner` server-side and validates owner∈team.
  (`update_project { teamId: T }` alone on a project owned by U
  produces `owner: U, team: T`, or 422 if U ∉ T.)
- **Both in body** → both are set; same membership constraint.
- **Neither in body** (e.g. updating only `name`, `status`, or
  `stage`) → owner and team both preserved.

This is the only owner/team-related rule the API itself imposes.
For the orthogonal `party` / `organisation` parent-reference PUT
rules (when re-parenting an entity to a different party, linking a
person to an org, etc.), see §31.

### Opportunity owner/team updates mirror Rule A

v1.6.1 production verification found the same asymmetric
owner/team PUT semantic on `PUT /opportunities/{id}`:

- **`owner` in body, `team` absent** → Capsule clears `team`.
- **`team` in body, `owner` absent** → Capsule preserves the
  existing `owner` server-side and validates owner∈team.
- **Both in body** → both are set; same membership constraint.

`update_opportunity` now applies the same connector-side mitigation
as `update_project`: when the caller supplies `ownerId` and omits
`teamId`, it fetches the current opportunity, carries the existing
team into the PUT body, and prevents accidental team clears. Unlike
projects, the connector does not expose `ownerId: null` for
opportunities; only `teamId: null` is available for explicit team
unassign.

### Pipeline automation can mutate opportunity `owner` / `team`

Separate from the normal `PUT /opportunities/{id}` API contract,
Capsule tenants can configure Sales Pipeline automation rules that
fire when an opportunity enters a milestone. Production verification
found an "Assign to a Team" milestone automation that cleared
`owner` immediately after `create_opportunity { ownerId, teamId,
milestoneId }`. That is an automation side-effect, not the §27 PUT
rule above.

Practical workaround: after a create or milestone transition that
fires such automation, issue a second `update_opportunity` or
`batch_update_opportunity` carrying both `ownerId` and `teamId`. The
milestone-reached trigger fires on the transition, so the follow-up
PUT preserves the intended owner/team pair.

### Party owner/team PUT semantics (verified v1.6.4)

`PUT /parties/{id}` accepts both `owner` and `team` as
top-level fields on the body, on both person AND organisation
parties. Empirically verified via `scripts/wire-trace-v164.ts`
(7 probes, full cleanup):

- `{ team: { id: T } }` — sets team. Subject to the same
  `owner ∈ team` membership rule as /kases and /opportunities;
  passing a team the current owner doesn't belong to returns
  `422 'owner is not a member of the team'`.
- `{ team: null }` — clears team. 200 on both person and org.
- `{ owner: null }` — clears owner. 200 on both person and org.
  Refutes the pre-v1.6.4 assumption that owner couldn't be
  cleared on parties; that was a client-side guard, not a
  Capsule constraint.
- `{ owner: null, team: { id: T } }` — sets the "team-owned,
  no specific user" state in one PUT. The owner∈team
  membership rule does NOT fire because owner is null. This is
  the canonical pattern for transferring a departed user's
  records to team ownership.

Combined with §27, parties plausibly share the asymmetric
owner-clears-team PUT semantic (PUT `{ owner: { id: X } }`
without `team` may clear the existing team). The v1.6.4
wire-trace did not directly probe this on parties because the
test records started with `team: null`, but by analogy with
/kases and /opportunities it's prudent to apply the same
defensive read-modify-write. `update_party` does so as of
v1.6.4 — when `ownerId` is touched and `teamId` is omitted,
the connector reads the current team and includes it in the
PUT body.

### Opportunity owner-clear + project stage-clear (verified v1.6.5)

Two further probes from `scripts/wire-trace-v165.ts` closed
inconsistencies between the three entity types' update tools:

- `PUT /opportunities/{id} { owner: null }` — accepted (200).
  Mirrors the v1.6.4 party finding. `update_opportunity.ownerId`
  is now nullable, matching `update_party.ownerId` and
  `update_project.ownerId`. The defensive RMW still fires on
  ownerId-touched (whether setting or clearing) to guarantee
  team preservation under the §27 asymmetric semantic.
- `PUT /opportunities/{id} { owner: null, team: { id: T } }` —
  accepted (200). The "team-owned, no specific user" transfer
  pattern works in a single PUT on opportunities, same as on
  parties (v1.6.4 probe G).
- `PUT /kases/{id} { stage: null }` — accepted (200). Removes
  the project from all stages (and therefore all boards). Owner
  and team are preserved across the stage-clear. `update_project.stageId`
  is now nullable.

Combined effect: the `update_*` surface across party, opportunity,
and project is now uniform — `ownerId`, `teamId` are nullable
on all three; party adds nullable `organisationId`; project adds
nullable `stageId`. Callers who learn the clear-via-null semantic
on one tool can apply it to the others.

### Custom-field writes are accepted on CREATE, not just UPDATE (verified v1.6.5)

Probe C of `scripts/wire-trace-v165.ts` verified that Capsule's
POST endpoints accept the same `fields: [{ definition: { id }, value }]`
shape as PUT:

- `POST /parties { ..., fields: [...] }` — accepted (201).
  Custom field values persist on the new record.
- `POST /kases { ..., fields: [...] }` — accepted (201).
- `POST /opportunities { ..., fields: [...] }` — inferred by
  symmetry (the tenant probed had no opportunity custom field
  definitions configured, so no positive case was run). Capsule's
  API consistently mirrors the create/update shape across entity
  types, and the negative case (POST without fields) was the
  previous default — any rejection on POST would be a per-endpoint
  policy, not a body-shape limitation.

`create_party`, `create_opportunity`, `create_project` all expose
the same `fields: z.array(CustomFieldWriteSchema)` field as the
corresponding `update_*` tool. Removes the create-then-update
ritual previously required for setting custom field values on
new records.

### Tenant board automation can mutate `owner` / `team` independently of the API

A separate behaviour to be aware of: Capsule lets tenants
configure **board-level automation rules** that fire on project
creation and stage transitions. These can clear `owner`, set
`team` from a board default, or apply tracks — without any
involvement from the API contract. From the API caller's
perspective the mutation looks indistinguishable from an API
quirk, but it isn't one.

This is not a hypothetical: the §15-supplementary through
alpha.19 verification series spent four reports treating
"`create_project { ownerId, stageId }` drops the owner" as a
Capsule API rule (Bug 17, framed across alpha.{17,18,19}). The
alpha.19-R re-verification with the board automation disabled
showed the API preserves both fields cleanly. Same for the
"board default team" — that was automation, not a data-model
default.

**Practical implication:** when you observe `owner` or `team`
being mutated unexpectedly on create_project, check the target
board's automation configuration before assuming the connector
or the API is at fault. Capsule's API itself preserves whatever
you POST.

### Connector-side mitigation (RMW on update)

`update_project` does a **read-modify-write** when the caller
supplies `ownerId` without `teamId`: fetches the current project,
reads its `team`, includes it in the PUT body. This neutralises
Rule A's "owner-in-body clears team" half — `update_project
{ ownerId }` becomes a safe owner reassignment that preserves
team scope.

No equivalent mitigation needed for `teamId` alone (Capsule
preserves owner server-side per Rule A) or `stageId` alone
(Capsule's PUT doesn't fire any clears when only stage is in
the body).

`create_project` performs no automation-aware coercion — the
descriptions on `create_project.ownerId` / `teamId` / `stageId`
flag the automation caveat so callers know where to look when
they see surprise null owners.

### Where in our code

[`src/tools/projects.ts`](src/tools/projects.ts) —
`update_project` and `create_project` both expose
`ownerId` and `teamId` (nullable on update for explicit unassign).
`update_project` does the RMW for ownerId-without-teamId.
Descriptions surface the Rule A asymmetry on update and the
automation caveat on create.

Captured as Bug 16 (Rule A PUT-clears-team) across the §15,
§15-supplementary, and alpha.{17,18,19} verification reports —
closed at the connector level via RMW. Bug 17 (originally framed
as a Capsule API quirk that drops owner on create) closed in
alpha.19-R as an **automation artifact** in the test tenant,
not a real API behaviour. The schema-level rejection introduced
in alpha.19 (#14) was rolled back in the same wave.

**Earlier wrong framings** worth flagging for future readers
re-reading the alpha.{16,17,18,19}-era code:

1. "owner and team are mutually exclusive" (initial §15 report) —
   wrong; the three shapes are all valid.
2. "team must be a team the owner belongs to or it clears"
   (alpha.16 §27) — wrong; the asymmetry is structural to the
   PUT, not a compatibility check.
3. "PUT rewrites the (owner, team) pair atomically — absent half
   is cleared" (alpha.17 §27) — wrong; Rule A is asymmetric, not
   pair-rewrite.
4. "Bug 17 fixable by supplying `teamId` alongside `ownerId` at
   create time" (alpha.17 descriptions) — wrong; Rule B fires
   regardless of `teamId`.
5. "Two-call workflow: create without stageId, then update with
   stageId — and ONLY the stage-first ordering works" (alpha.18
   descriptions) — partial; the alpha.18 framing claimed
   `update_project { stageId }` clears owner, but alpha.19
   verification couldn't reproduce that. Both orderings (stage-
   first and owner-first) actually work.
6. "Bug 17 / Rule B POST-side: `create_project { ownerId,
   stageId }` always drops owner" (alpha.{17,18,19}, schema-level
   rejection added in alpha.19 #14) — wrong; the alpha.19-R
   re-verification with board automation disabled showed Capsule's
   API preserves both fields cleanly. The drops we'd been
   observing were tenant board automation, not the API. Schema
   rejection rolled back; descriptions soft-pedalled to flag the
   automation possibility instead of claiming a Capsule API rule.

**No Capsule docs page mentions either rule explicitly.**
Verified live in §15-supplementary and the alpha.17 verification
report against production.

---

## 28. `create_*.ownerId` defaults differ per entity

When `ownerId` is omitted on a `create_*` call, the default owner
Capsule applies depends on the entity type:

| Entity | Default owner | Notes |
|---|---|---|
| Party (person or organisation) | API-token owner | |
| Opportunity | API-token owner | Does NOT inherit from linked party — even if the party is owned by user X, an opportunity created on that party with no ownerId comes out owned by the API-token owner. |
| Task | API-token owner | Tasks have no `team` field at all. |
| Project (kase) | API-token owner | Same as the other entities. Earlier versions of this file claimed projects defaulted to `owner: null` — that was an artifact of board automation in the test tenant (see §27). |

The defaults are uniform across entity types, but the
opportunity-doesn't-inherit-from-party asymmetry is still
surprising: a common workflow — "create an opp for a party
owned by user X" — does not produce a party-owner-matching opp.
The opp's owner comes from the API token, not the linked party.

**Where in our code:** [`src/tools/parties.ts`](src/tools/parties.ts),
[`src/tools/opportunities.ts`](src/tools/opportunities.ts),
[`src/tools/tasks.ts`](src/tools/tasks.ts),
[`src/tools/projects.ts`](src/tools/projects.ts) — each
`create_*.ownerId` description states the default explicitly,
including the opportunity-doesn't-inherit-from-party note. Verified
in §15 production verification.

**No Capsule docs page enumerates these per-entity defaults.**

---

## 29. Team membership is NOT exposed by the v2 REST API

Capsule's `/teams` and `/users` endpoints surface team and user
**identity** (id, name, timestamps, status, locale, etc.) but
the **join** between them — which users belong to which teams —
is not dereference-able through the REST surface from either
side.

Verified live (2026-05-13) against the production tenant by
probing five plausible shapes:

| Probe | Result |
|---|---|
| `GET /teams` | Returns `[{id, name, description, createdAt, updatedAt}]` only |
| `GET /teams?embed=users` | `embed=users` silently ignored; identical response shape |
| `GET /teams/{id}` | Same fields as the list, no membership |
| `GET /teams/{id}/users` | **404** — endpoint does not exist |
| `GET /users/{id}` | Returns party info, locale, timezone, status — no `teams` field |

So the team↔user relationship lives in a part of Capsule's
data model that's only readable by the web UI. The
`update_project { ownerId, teamId } → 422 owner is not a member
of the team` validation path (see §27) is the only way to
determine membership programmatically — by probing each
(user, team) pair the caller is interested in.

**Practical effect on connectors:** the `list_teams` tool can
list teams the API token has visibility into, and `list_users`
can list users, but neither can describe membership. Workflows
that need to choose a `(owner, team)` pair compatible with
Capsule's membership constraint have to either know the rosters
out-of-band (web UI / operator knowledge) or accept the 422 as
the discovery mechanism.

**Where in our code:** [`src/tools/metadata.ts`](src/tools/metadata.ts)
`listTeams` wraps `GET /teams` with no embed; nothing higher-
level is achievable without an additional Capsule API endpoint
that doesn't currently exist. The
[`update_project.teamId` description](src/tools/projects.ts)
mentions the 422 path as the membership-validation shape.

**No Capsule docs page mentions the missing membership surface.**

---

## 30. Address `country` is dictionary-validated, not free-text

Capsule validates `address.country` against a small canonical-
English-name dictionary. Inputs not in the dictionary are
**rejected** with `422 address.country: unknown country` —
**not** silently passed through or normalised. This contradicts
the impression that "Capsule normalises country through its
dictionary" gives, and was discovered during the §1 (child-array
semantics) production verification on 2026-05-13.

Probed against the production tenant via fresh, isolated test
parties:

| Input | Result |
|---|---|
| `United States` | accept |
| `USA` | canonicalise → `United States` |
| `United Kingdom` | accept |
| `Czechia` | accept |
| `Germany` | accept |
| `United States of America` | **422 unknown country** |
| `Czech Republic` | **422 unknown country** |
| `UK` | **422 unknown country** |
| `Britain` | **422 unknown country** |
| `Deutschland` | **422 unknown country** |
| `Atlantis` | **422 unknown country** |
| `""` (empty string) | accept, stored as `null` |

So the dictionary is canonical-English-only with a small
aliases table (`USA` is one — others not yet probed). Common
alternative names (`UK`, `Czech Republic`, `Deutschland`,
`United States of America`) are rejected even though a human
reader would consider them obvious synonyms.

**Practical effect on callers:** any workflow that takes a
free-text country from the operator (form input, CSV import,
LLM-paraphrased address) needs to either pre-normalise to the
dictionary or be ready to handle the 422.

**Correction (2026-08-16):** an earlier revision of this note claimed
Capsule exposes no `/countries` enumeration endpoint. That is no
longer true (and may never have been): `GET /countries` returns 200
with 250 rows (`name`, `alpha2Code`, `alpha3Code`, `numericCode`,
`dialCode`) — live-verified. The `name` values are the accepted
country-dictionary spellings. The `list_countries` tool exposes it (cached
reference data); the probe-derived examples above remain as quick
in-description guidance. `GET /currencies` (80 rows: `code`, `symbol`,
`name`) also exists, as does an undocumented `GET /activities`
cross-entity activity feed.

**Where in our code:** [`src/tools/parties.ts`](src/tools/parties.ts)
`AddressSchema` and `addPartyAddressSchema.country` descriptions
spell out the dictionary edges with the probed examples above.

**No Capsule docs page lists the accepted country names.**

---

## 31. Parent-reference (`party` / `organisation` / `opportunity` / `kase`) PUT semantics

The four "parent-reference" fields on PUT — `party` on opp/project/
task, `organisation` on a person-party, `opportunity`/`kase` on a
task — have asymmetric rules around whether `null` is accepted.
Probed empirically during v1.6.3 wire-trace; written up here so
future maintainers don't have to re-probe.

### Rule A — PUT `/opportunities/:id` and PUT `/kases/:id`: `party` MUST be set

Both endpoints require every record to have a primary party.

- `{ party: { id: N } }` → 200, reassigned.
- `{ party: null }` → **422 Validation Failed**
  `"party is required"`.

Practical implication: `update_opportunity.partyId` and
`update_project.partyId` accept positive integers only. Don't
expose `.nullable()` — a caller who needs to "remove" a party from
an opp/project must delete the record entirely.

Independent of the §27 owner/team asymmetric semantic — re-parenting
to a different `party` does NOT clear `owner` or `team`. No
defensive RMW needed.

### Rule B — PUT `/parties/:id` on a PERSON: `organisation` is fully nullable

- `{ organisation: { id: N } }` on a person → 200, person linked
  to org N.
- `{ organisation: null }` on a person → 200, person becomes
  standalone (org link cleared).

Practical implication: `update_party.organisationId` is
`.nullable().optional()` — both set and unlink supported.

### Rule C — PUT `/parties/:id` on an ORGANISATION: `organisation` silently ignored

- `{ organisation: { id: N } }` on an organisation → 200, but the
  returned body shows no `organisation` field on the org (orgs
  don't have a parent org in Capsule's data model). The field is
  silently accepted by the API and silently dropped from the
  response.

Practical implication: no client-side type guard added —
the no-op is harmless. Tool description on `update_party.organisationId`
calls this out so callers don't think it's a connector bug.

### Rule D — PUT `/tasks/:id`: any one parent-ref can be set OR cleared, but only one set at a time

Tasks can be orphan (`party`/`opportunity`/`kase` all null) or
linked to exactly one parent.

- `{ party: { id: N } }` → 200, re-linked.
- `{ party: null }` → 200, task orphaned (if no other parent set).
- `{ opportunity: null, kase: { id: M } }` → 200, atomic swap from
  opp to project.
- `{ party: { id: N }, opportunity: { id: M } }` → **422**
  `"task can be related to at most one entity"`.

Practical implication: `update_task` exposes
`partyId` / `opportunityId` / `projectId`, each `.nullable().optional()`,
with a client-side XOR check (mirrors `create_task`) that allows
nulls but rejects two non-null parent-refs in the same call.

### Where in our code

- `src/tools/opportunities.ts` `updateOpportunitySchema.partyId`
- `src/tools/projects.ts` `updateProjectSchema.partyId`
- `src/tools/parties.ts` `updatePartySchema.organisationId`
- `src/tools/tasks.ts` `updateTaskSchema.{partyId,opportunityId,projectId}`
  + the XOR check in the handler

### Quote

No Capsule docs page explicitly documents these. Findings come from
the `scripts/wire-trace-v163.ts` probe run (12 mutations against a
live tenant, full cleanup) — captured in the script's `PROBE 1`–
`PROBE 12` blocks for re-runnability.

---

## 32. `/parties/{id}/entries` is strictly per-row — no traversal to linked people

Capsule's per-party entries endpoint
(`GET /parties/{partyId}/entries`) returns entries whose `party.id`
matches `partyId` exactly. No upward traversal (person → linked org)
and no downward traversal (org → linked people).

For organisations this is operationally surprising: customer-facing
emails are typically captured with the contact (a person) as the
party — almost never with the org row itself — so an org's
`/entries` response will look empty even when the relationship is
actively conversing. The org's `lastContactedAt` *is* refreshed by
person-level entries (so the org's `get_party` response reads
correctly), but the entries themselves don't surface at the org
level. The mismatch between `lastContactedAt` and the entries list
is the diagnostic signal.

**Quote** — none. Capsule's
[Party docs](https://developer.capsulecrm.com/v2/operations/Party)
describe `/{id}/entries` as "the list of entries linked to this
party" without elaborating on the linked-persons case. Behaviour
verified live, not from docs.

### Verified empirically (v1.6.6 wire-trace)

`scripts/wire-trace-v166.ts` ran five probes against a live tenant
to confirm the semantic before designing the mitigation:

- **Probe 1** — note filed on a linked person → org's `/entries`
  returns 0 entries. Gap confirmed.
- **Probe 2** — note filed on the org → linked person's `/entries`
  doesn't include it. No upward traversal either.
- **Probe 3** — `GET /parties/{orgId}/people` returns the linked
  persons with the expected `{id, type, ...}` shape (same that
  `list_employees` already consumes).
- **Probe 4** — `POST /entries` with
  `parties: [{id: org}, {id: person}]` is rejected with 422 "entry
  must be linked to either a party, opportunity or kase". **Each
  entry is filed against exactly one party row** — no native
  multi-party entries via the API.
- **Probe 5** — `GET /parties/{personId}/people` returns 200 with
  an empty array on a person (no linked-people relationship in the
  data model). Connector can short-circuit cleanly without 404
  handling.

### Connector-side mitigation

`list_party_entries.includeLinkedPersons` (added v1.6.6, optional,
default `false` — preserves the pre-v1.6.6 contract bit-for-bit).
When `true` and `partyId` is an organisation:

1. Fetch `/parties/{orgId}/people` to enumerate linked persons.
2. Fan out `/parties/{personId}/entries` for each linked person in
   parallel (concurrency-capped via `getBatchConcurrency()` — same
   helper the `batch_*` writes use, default 5).
3. Concat + dedup by entry `id` (defensive — probe 4 showed naive
   concat is correctness-safe via the API path, but captured-email
   SMTP routing is a separate code path we can't simulate, so dedup
   is belt-and-suspenders).
4. Sort by `entryAt` descending (tie-break by `id` desc so the sort
   is total).
5. Slice the caller's `(page, perPage)` window over the merged feed.

When `partyId` is a person, `includeLinkedPersons: true` is a no-op:
the `/people` lookup returns empty (probe 5), and the connector
short-circuits to the single-GET fast path. The flag is safe to
default-on in callers without conditional logic.

### Where in our code

- [`src/tools/entries.ts`](src/tools/entries.ts) `listPartyEntries`
  — the `includeLinkedPersons` branch + `fanOutPartyEntries` helper.
- [`scripts/wire-trace-v166.ts`](scripts/wire-trace-v166.ts) — the
  re-runnable probe harness.

---

## 33. No tenant-wide track-instance list; tag definitions ARE deletable

Two endpoint-existence questions, settled empirically by
[`scripts/wire-trace-v167.ts`](scripts/wire-trace-v167.ts) so that two
proposed tools could be graded buildable-or-not before any code was
written.

### `GET /tracks` → 405 — there is NO tenant-wide track-instance list

`GET /tracks` returns **`405 Method not allowed`** (the route exists
but only accepts `POST`, which creates an instance). Track instances
are therefore reachable only:

- entity-scoped: `GET /<entity>/{id}/tracks` (the `list_entity_tracks`
  tool), or
- by known id: `GET /tracks/{id}` (the `get_track` tool).

**Consequence:** the orphan track instances from §25 (which survive
parent deletion) **cannot be enumerated tenant-wide** — if you don't
already hold the orphan's id, there is no read path to it. A proposed
`list_tracks` tool is therefore **not buildable** against Capsule's
v2 API; it was declined on this basis rather than the assumption it
could be added. The only mitigations for orphan accumulation remain
(a) capture the track-instance id at `apply_track` time and
`remove_track` it explicitly before deleting the parent, or (b) clean
up in Capsule's web UI.

### `DELETE /<entity>/tags/{id}` → 204 — tag DEFINITIONS are deletable

A tag definition minted via `add_tag` was removed with
**`DELETE /parties/tags/{id}` → 204`**, and a follow-up
`GET /parties/tags` confirmed it was gone tenant-wide (not merely
detached from one record). Tags are entity-namespaced (separate
`/parties/tags`, `/opportunities/tags`, `/kases/tags` lists), so the
delete path carries the entity prefix.

This is distinct from the tag DETACH path used by `remove_tag_by_id`
(`PUT /<entity>/{id}` with `{tags: [{id, _delete: true}]}`), which
removes a tag from ONE record and leaves the definition intact.
Definition-delete removes the definition from the namespace and from
every record that shared it.

**Where in our code:** [`src/tools/tags.ts`](src/tools/tags.ts)
`deleteTagDefinition` (the `delete_tag_definition` tool, confirm-gated,
idempotent on 404). Verified by `scripts/wire-trace-v167.ts`.

**No Capsule docs page** documents either behaviour explicitly;
both come from the live probe.

---

## How to add to this file

When you discover a new Capsule API quirk:

1. Verify the behaviour live (don't trust the docs alone — Capsule's
   docs occasionally describe behaviour that doesn't match what the
   live API actually does, or vice versa).
2. Add a section here in the format used above: number, terse title,
   description, "Where in our code", "Quote" pulled verbatim from
   the relevant Capsule doc page with the URL inline.
3. Update the relevant source-comment in the file that handles the
   quirk so the inline context is also kept fresh.

The golden rule: **behaviour is authoritative, docs are a snapshot.**
If a quote here drifts from Capsule's docs in the future, that's
useful — it tells you Capsule may have updated their docs (and
possibly their API). Treat it as a prompt to re-verify.

---

## 34. DELETE can return 202 Accepted (long-running deletion job)

`DELETE /parties/{id}` is documented to return **202 Accepted** (not
204) when Capsule schedules the deletion as a long-running operation —
large cascades. The 202 carries a `Location` header with a pollable
job-status URL (`{status, progress, action, id}`). The record WILL be
deleted; an immediate read-back may still find it.

**Where in our code:** `capsuleDelete`
([`src/capsule/client.ts`](src/capsule/client.ts)) returns
`{scheduled: boolean}`; `defineDelete`'s envelope surfaces
`scheduled: true` on 202 so callers don't misread an in-flight
deletion as a failure; `delete_tag_definition` (the doc's own
long-running example) surfaces the same flag. All observed deletes on this tenant so far
returned 204; the 202 path is doc-driven, not yet observed live.

---

## 35. Undocumented party field: `enrichment`

Every party row now carries an `enrichment` key (observed live
2026-08-16; absent from Capsule's Party model docs). Its semantics are
unknown — presumably Capsule's contact-enrichment feature. The
connector passes it through untouched. If Capsule documents it, revisit
whether it deserves surfacing (e.g. an embed or field description).