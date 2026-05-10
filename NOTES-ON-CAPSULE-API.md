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
