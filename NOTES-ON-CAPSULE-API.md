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

Last sync: 2026-05-10. capsulemcp commit: see `git log NOTES-ON-CAPSULE-API.md`.

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

**Where in our code:** the four `get_<entity>s` (plural) tools, each
schema-validated to `min(1).max(10)`. See for example
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
Cloud Run request indefinitely; if Capsule says "wait 50 minutes"
we surface the 429 and let the caller decide rather than holding
the connection open.

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
Opportunity, and Project.

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

## 21. Custom-field clearing: `value: null` works for most types but rejects BOOLEAN

For `update_party`, `update_opportunity`, and `update_project`'s
`fields` array, passing `value: null` on a row removes the value
for TEXT / NUMBER / DATE / LIST / LARGE_TEXT / LINK fields cleanly
(Capsule responds 200 OK and the read-back shows the field gone).

**BOOLEAN is the exception.** Sending
`{definition: {id}, value: null}` for a BOOLEAN field returns
`422 field.value: invalid type for field`. Capsule rejects null
specifically for booleans; the API has no other documented "clear"
shape for them. Workaround: set the field to `false`, which is
how most workflows model "the no value" anyway (`Auto-Renewal
Ceased`, `IsActive`, etc.).

If genuine tri-state BOOLEAN (true / false / unknown) is needed,
the only path is the `_delete: true` row-shape (which requires
knowing the row id, hence a GET-then-PUT) — same shape as the
party-child-array removes in §18.

**Where in our code:** [`src/tools/_custom-fields.ts`](src/tools/_custom-fields.ts)
`CustomFieldWriteSchema.value` description spells out the
BOOLEAN-specific rejection. Documented as Bug 12 in the alpha.10
verification; closed by documentation.

**No Capsule docs page mentions the BOOLEAN-null restriction.**

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
(the entity is gone); only `show_track` by id does.

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

Worse: `lastOpenMilestone` (which Capsule maintains for "what
stage did this die at" auditing) can end up referencing a
milestone in the previous pipeline — broken cross-pipeline
provenance.

**Practical impact:** real risk for any workflow that constructs
milestoneId values from caller input without first checking the
opportunity's current pipeline. A typo or stale id can move a
deal across the org's pipeline boundary without warning.

**Workaround:** read the entity first; cross-check the new
milestone's `pipeline` (or stage's `board`) before issuing the
update.

**Where in our code:** [`src/tools/opportunities.ts`](src/tools/opportunities.ts)
`update_opportunity.milestoneId` and
[`src/tools/projects.ts`](src/tools/projects.ts)
`update_project.stageId` both carry a verbose WARNING in their
descriptions. Captured as Bugs 6 and 7 in the §5-10
production write-mode bug-report; closed by documentation
(a connector-side pre-fetch validation was considered and rejected
as overkill until someone gets bitten).

**No Capsule docs page mentions this.** The relocation is
accepted as if it were a normal update.

---

## 27. Project `owner` / `team` write semantics (asymmetric PUT, owner-dropping POST)

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

Three non-obvious write-side rules govern how these shapes are
reached via the API:

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
- **Neither in body** (e.g. updating only `name`) → owner/team
  both preserved.

### Rule B — PUT `/kases/{id}`: `stage` in body clears `owner`

When `stage` is in the PUT body, Capsule clears `owner` to null,
**regardless of whether `owner` is also in the body**. So even
`update_project { ownerId: U, stageId: S }` results in
`owner: null`. There is no body shape that includes `stage` and
produces a non-null `owner` in one call.

Team appears to be preserved across stage-only updates (the
alpha.18 verification didn't flag team clearing in this path).

### Rule C — POST `/kases`: `stage` in body clears `owner`

Symmetric to Rule B but at create time. POSTing
`{ owner: {id: U}, stage: <S> }` produces `owner: null, team:
<board-default>, stage: <S>`. The owner-clearing fires whenever
`stage` is present in the create body, regardless of `team`.

### How to reach `owner + team + stage` end state

There is **no single API call** that reaches this state. The
working workflow is **stage-first, owner-second**:

1. `create_project { partyId, stageId }` (omit `ownerId` and
   `teamId`) → `owner: null, team: <board default>, stage: <S>`.
2. `update_project { ownerId: U }` (optionally `+ teamId: T` to
   change away from the board default) → connector's RMW carries
   the current team forward; Capsule preserves stage because
   `stage` is not in this PUT body; owner is set.

The reverse order ("create with owner+team, update with stage")
does NOT work — the stage-only update clears the owner per
Rule B.

`create_project { partyId, stageId, teamId }` (with an explicit
non-default team but no owner) also fails: Capsule appears to
implicitly attach the API-token user as owner and 422 on
owner-must-be-in-team. So `teamId` at create time is only safe
when combined with a compatible `ownerId` AND without `stageId`.

### Connector-side mitigation (alpha.18, refined in alpha.19)

`update_project` does a **read-modify-write** when the caller
supplies `ownerId` without `teamId`: fetches the current project,
reads its `team`, includes it in the PUT body. This neutralises
Rule A's "owner-in-body clears team" half.

No equivalent mitigation for `teamId` alone (Capsule preserves
owner server-side per Rule A) or `stageId` alone (the
owner-clearing per Rule B is independent of body shape — adding
`owner` to the same body doesn't preserve it, so RMW can't help).

### Where in our code

[`src/tools/projects.ts`](src/tools/projects.ts) —
`update_project` and `create_project` both expose
`ownerId` and `teamId` (nullable on update for explicit unassign).
`update_project` does the RMW for ownerId-without-teamId.
Descriptions on `create_project.stageId` and
`update_project.stageId` walk callers through the stage-first
workflow.

Captured as Bug 16 (Rule A PUT-clears-team), Bug 17 (Rule C
POST-drops-owner), and an unnumbered Rule B clarification across
the §15, §15-supplementary, alpha.17, and alpha.18 verification
reports. Bug 16 closed at the connector level by RMW; Bugs 17
and the Rule B / Rule C cluster documented as Capsule API limits
with the stage-first workaround.

**Earlier wrong framings** worth flagging for future readers
re-reading the alpha.{16,17,18}-era code:

1. "owner and team are mutually exclusive" (initial §15 report) —
   wrong; the three shapes are all valid.
2. "team must be a team the owner belongs to or it clears"
   (alpha.16 §27) — wrong; the asymmetry is structural to the
   PUT, not a compatibility check.
3. "PUT rewrites the (owner, team) pair atomically — absent half
   is cleared" (alpha.17 §27) — wrong; Rule A is asymmetric, not
   pair-rewrite.
4. "Bug 17 fixable by supplying `teamId` alongside `ownerId` at
   create time" (alpha.17 descriptions) — wrong; Rule C fires
   regardless of `teamId`.
5. "Two-call workflow: create without stageId, then update with
   stageId" (alpha.18 descriptions) — wrong; the update-with-stage
   leg clears owner per Rule B. The actual workflow is stage-first,
   owner-second.

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
| Project (kase) | **null** | Project gets its `team` field from the board's default team instead, when a `stageId` is supplied (see §27 for the PUT/POST owner-team write semantics). |

The asymmetry is real and surprising. A common workflow — "create
an opp for a party owned by user X" — does not produce a
party-owner-matching opp.

**Where in our code:** [`src/tools/parties.ts`](src/tools/parties.ts),
[`src/tools/opportunities.ts`](src/tools/opportunities.ts),
[`src/tools/tasks.ts`](src/tools/tasks.ts),
[`src/tools/projects.ts`](src/tools/projects.ts) — each
`create_*.ownerId` description states the default explicitly,
including the opportunity-doesn't-inherit-from-party note. Verified
in §15 production verification.

**No Capsule docs page enumerates these per-entity defaults.**

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
