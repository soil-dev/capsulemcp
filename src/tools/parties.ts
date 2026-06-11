import { z } from "zod";
import { setNullableRef, setRef } from "./body-helpers.js";
import { defineBatch } from "./define-batch.js";
import { EMBED_TAGS_FIELDS_DESCRIPTION } from "./descriptions.js";
import { defineDelete } from "./define-delete.js";
import { readEntityRefs } from "./preserve-refs.js";
import { positiveId, paginationFields } from "./shared-schemas.js";
import { capsuleGet, capsulePost, capsulePut, capsuleGetList } from "../capsule/client.js";
import { chunkedMultiGet } from "../capsule/multi-get.js";
import { idempotentWithResult } from "../capsule/idempotent.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./custom-field-helpers.js";

// ── Shared sub-schemas ──────────────────────────────────────────────────────

const EmailAddressSchema = z.object({
  address: z.string().email(),
  type: z.string().optional(),
});

const PhoneNumberSchema = z.object({
  // Capsule rejects empty strings with `phoneNumber.number: number is
  // required`. Enforce at the schema layer to catch typos pre-call,
  // matching how EmailAddressSchema's address field behaves.
  number: z.string().min(1),
  type: z.string().optional(),
});

const CountryDescription =
  "Country name. Capsule validates this against a small canonical-English-name dictionary; inputs not in the dictionary are REJECTED with 422 'address.country: unknown country' (NOT silently passed through or normalised). " +
  "Probed examples — accepted: `United States`, `United Kingdom`, `Czechia`, `Germany`. Aliased: `USA → United States`. Rejected: `United States of America`, `Czech Republic` (use `Czechia`), `UK`/`Britain` (use `United Kingdom`), `Deutschland` (use `Germany`). " +
  "Empty string is accepted and stored as `null` — a de-facto 'clear' shape. To discover an accepted name, read an existing party that already has the country set.";

const AddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional().describe(CountryDescription),
  zip: z.string().optional(),
});

// Capsule's API names this field `address`, not `url`. The name is
// generic because the value depends on `service`: a URL when
// `service: "URL"`, but a handle (e.g. "@acmeco") for social
// services like "TWITTER", "INSTAGRAM" — so blanket URL-validation
// would reject valid Capsule data. The 422 message Capsule returns
// when the wrong key is sent is "website.address: address is required".
//
// The cross-field check below applies URL-validation *only* when
// `service` is `"URL"` (or omitted — Capsule defaults to URL). Two
// gates:
//
//   1. Syntactic — must parse as a URL via the WHATWG URL parser.
//   2. Scheme — must be http: or https:. A small deny-list blocks the
//      obvious XSS schemes, but a positive web-URL allow-list is safer
//      for downstream UIs that may turn stored websites into links.
//
// Without the scheme gate, the connector would happily write values
// like `javascript:alert(1)` or `file:///...` into Capsule's website
// field; Capsule stores user-supplied strings verbatim, so the impact
// lives in whoever renders them later. Reject at the schema layer to
// avoid shifting that responsibility to every consumer.
function validateWebsiteAddress(
  data: { address: string; service?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  // Only validate when the address will be interpreted as a URL.
  // Empty `service` defaults to "URL" per Capsule's docs.
  const isUrlService = data.service === undefined || data.service === "URL";
  if (!isUrlService) return;

  if (!URL.canParse(data.address)) {
    ctx.addIssue({
      code: "custom",
      path: ["address"],
      message:
        "When service is 'URL' (or omitted), address must be a valid URL like 'https://example.com'. For a social handle, set service to the matching type (e.g. service='TWITTER', address='@handle').",
    });
    return;
  }
  const parsed = new URL(data.address);
  // Capsule itself doesn't sanitize what it stores; this is a
  // defence-in-depth gate against the connector being used to plant
  // a harmful link via a write tool. Keep URL websites to normal web
  // URLs; non-web identifiers belong under their explicit service
  // types (TWITTER, GITHUB, SKYPE, etc.).
  const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    ctx.addIssue({
      code: "custom",
      path: ["address"],
      message: `When service is 'URL', address protocol '${parsed.protocol}' is not allowed. Use http: or https:.`,
    });
  }
}

// Capsule's complete service list, copied verbatim from a 422
// response body for a `PIGEON_POST` test:
//   "options are: URL, SKYPE, TWITTER, LINKED_IN, FACEBOOK, XING,
//    FEED, GOOGLE_PLUS, FLICKR, GITHUB, YOUTUBE, INSTAGRAM,
//    PINTEREST, TIKTOK, THREADS, BLUESKY, SNAPCHAT"
// Locked at the schema layer so typos surface before any HTTP
// round-trip. If Capsule adds new services, the 422 will tell us.
const WebsiteServiceEnum = z.enum([
  "URL",
  "SKYPE",
  "TWITTER",
  "LINKED_IN",
  "FACEBOOK",
  "XING",
  "FEED",
  "GOOGLE_PLUS",
  "FLICKR",
  "GITHUB",
  "YOUTUBE",
  "INSTAGRAM",
  "PINTEREST",
  "TIKTOK",
  "THREADS",
  "BLUESKY",
  "SNAPCHAT",
]);

const WebsiteSchema = z
  .object({
    address: z
      .string()
      .min(1)
      .describe(
        "The website address. A URL when service='URL', or a handle (e.g. '@acmeco') for social services like 'TWITTER', 'INSTAGRAM'. Capsule names this field `address` regardless of service type.",
      ),
    service: WebsiteServiceEnum.optional().describe(
      "Service type. One of: URL, SKYPE, TWITTER, LINKED_IN, FACEBOOK, XING, FEED, GOOGLE_PLUS, FLICKR, GITHUB, YOUTUBE, INSTAGRAM, PINTEREST, TIKTOK, THREADS, BLUESKY, SNAPCHAT. Defaults to 'URL' if omitted.",
    ),
  })
  .superRefine(validateWebsiteAddress);

// ── Tool definitions ────────────────────────────────────────────────────────

export const searchPartiesSchema = z.object({
  q: z.string().optional().describe("Free-text search query"),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
  ...paginationFields,
});

export async function searchParties(input: z.infer<typeof searchPartiesSchema>) {
  // Capsule uses a dedicated /parties/search endpoint when filtering by query.
  // Plain GET /parties ignores `q` and returns the full list, so we must route.
  const path = input.q ? "/parties/search" : "/parties";
  return capsuleGetList<{ parties: unknown[] }>(path, {
    q: input.q,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const getPartySchema = z.object({
  id: positiveId.describe("Party ID"),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getParty(input: z.infer<typeof getPartySchema>) {
  const { data } = await capsuleGet<{ party: unknown }>(`/parties/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 50 parties by id. Capsule's native multi-id GET
// path (`/parties/<id1>,<id2>,...`) caps at 10 ids per request; when
// the caller asks for more, this tool transparently splits the input
// into 10-id chunks, fans out the resulting Capsule GETs in parallel,
// and concatenates the responses. Caller-facing shape is identical to
// the single-chunk case — fan-out is internal.

export const getPartiesSchema = z.object({
  ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Array of party IDs (1–50). Capsule's native batch-fetch endpoint caps at 10 per request; the connector transparently splits larger sets into 10-id chunks and fans out the Capsule calls in parallel. Result shape is identical regardless of input size.",
    ),
  embed: z.string().optional().describe(EMBED_TAGS_FIELDS_DESCRIPTION),
});

export async function getParties(input: z.infer<typeof getPartiesSchema>) {
  return chunkedMultiGet("/parties", "parties", input.ids, { embed: input.embed });
}

// ───────────────────────────────────────────────────────────────────────────

export const listPartyOpportunitiesSchema = z.object({
  partyId: positiveId,
  ...paginationFields,
});

export async function listPartyOpportunities(input: z.infer<typeof listPartyOpportunitiesSchema>) {
  return capsuleGetList<{ opportunities: unknown[] }>(`/parties/${input.partyId}/opportunities`, {
    page: input.page,
    perPage: input.perPage,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const listPartyProjectsSchema = z.object({
  partyId: positiveId,
  ...paginationFields,
});

export async function listPartyProjects(input: z.infer<typeof listPartyProjectsSchema>) {
  return capsuleGetList<{ kases: unknown[] }>(`/parties/${input.partyId}/kases`, {
    page: input.page,
    perPage: input.perPage,
  });
}

// ───────────────────────────────────────────────────────────────────────────

// IMPORTANT: child arrays (emailAddresses, phoneNumbers, addresses,
// websites) are APPEND-ONLY in Capsule's PUT semantics. Sending an
// array does NOT replace the existing items — every item you pass is
// added on top. For surgical control over these lists (replacing a
// value, removing one entry, changing a single type) prefer the
// dedicated atomic tools: add_party_email_address /
// remove_party_email_address_by_id, and the phone/address/website
// equivalents. The bulk arrays here are kept for callers who want to
// add multiple items in a single round-trip.
const PartyWriteBaseSchema = {
  about: z.string().optional(),
  emailAddresses: z
    .array(EmailAddressSchema)
    .optional()
    .describe(
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_email_address and remove_party_email_address_by_id. Passing `[]` here is a silent no-op (does not clear the list and does not advance updatedAt).",
    ),
  phoneNumbers: z
    .array(PhoneNumberSchema)
    .optional()
    .describe(
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_phone_number and remove_party_phone_number_by_id.",
    ),
  addresses: z
    .array(AddressSchema)
    .optional()
    .describe(
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_address and remove_party_address_by_id. The `country` field is mapped through Capsule's country dictionary — see `add_party_address.country` for the dictionary edges (small canonical-English-name list; inputs not in the dictionary are REJECTED with 422, not silently dropped).",
    ),
  websites: z
    .array(WebsiteSchema)
    .optional()
    .describe(
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_website and remove_party_website_by_id.",
    ),
  ownerId: positiveId
    .nullable()
    .optional()
    .describe(
      "Pass a user ID to set, or `null` to unassign (verified empirically in v1.6.4 wire-trace — Capsule accepts `owner: null` on PUT /parties/:id for both persons and organisations). Discover IDs via list_users. " +
        "WARNING: Capsule's PUT on /parties has the same asymmetric owner/team semantic documented in NOTES-ON-CAPSULE-API.md §27 for /kases — setting `owner` while omitting `team` is plausibly clearing-prone. When you supply `ownerId` and omit `teamId`, this connector reads the party's current team and includes it in the PUT body to preserve it across the owner change. Supply `teamId` explicitly to change it.",
    ),
  teamId: positiveId
    .nullable()
    .optional()
    .describe(
      "Assign to team ID (discover via list_teams). Pass a team ID to set, or `null` to unassign. Capsule enforces the owner∈team membership constraint — passing a team the current owner doesn't belong to returns 422 'owner is not a member of the team'. Combine `ownerId: null` + `teamId: <T>` in one call to transfer a party to team-ownership with no specific user (verified empirically in v1.6.4 wire-trace; the membership rule doesn't fire when owner is null).",
    ),
};

export const createPartySchema = z.object({
  type: z.enum(["person", "organisation"]),
  // person
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  jobTitle: z.string().optional(),
  organisationId: positiveId.optional().describe("Link person to an existing organisation ID"),
  // organisation
  name: z.string().optional(),
  ...PartyWriteBaseSchema,
  ownerId: positiveId
    .optional()
    .describe(
      "Assign to user ID. Defaults to the API-token owner when omitted. To create a team-owned party with no specific user, first create the party, then call update_party with `ownerId: null` and `teamId`.",
    ),
  teamId: positiveId
    .optional()
    .describe(
      "Assign to team ID (discover via list_teams). Omit to leave team unset on create. To clear an existing team or create a team-owned party with no specific owner, use update_party after creation.",
    ),
  fields: z
    .array(CustomFieldWriteSchema)
    .optional()
    .describe(
      fieldsArrayDescriptor("get_party") +
        " Verified empirically in v1.6.5 wire-trace: Capsule's POST /parties accepts the same `fields[]` shape as PUT, so callers can set custom field values on creation without a follow-up update.",
    ),
});

export async function createParty(input: z.infer<typeof createPartySchema>) {
  const { ownerId, teamId, organisationId, fields, ...rest } = input;

  const body: Record<string, unknown> = { ...rest };
  // On create, only positive integer IDs are accepted by the schema.
  // `setRef` still keeps this defensive at runtime and skips absent
  // values, so Capsule's create defaults are left intact when omitted.
  setRef(body, "owner", ownerId);
  setRef(body, "team", teamId);
  setRef(body, "organisation", organisationId);
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePost<{ party: unknown }>("/parties", { party: body });
}

// ───────────────────────────────────────────────────────────────────────────

// Custom-field write schema, descriptor, and body-mapper all live in
// custom-field-helpers.ts (shared across update_party /
// update_opportunity / update_project).

export const updatePartySchema = z.object({
  id: positiveId,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  jobTitle: z.string().optional(),
  name: z.string().optional(),
  organisationId: positiveId
    .nullable()
    .optional()
    .describe(
      "For PERSON parties: link to an organisation by id, or `null` to unlink (the person becomes an orphan / standalone record). Discover org IDs via search_parties / filter_parties with type=organisation. " +
        "For ORGANISATION parties: silently ignored by Capsule's API — organisations don't have a parent organisation in the data model. Empirically verified in v1.6.3 wire-trace; no client-side type guard since the no-op is harmless.",
    ),
  fields: z.array(CustomFieldWriteSchema).optional().describe(fieldsArrayDescriptor("get_party")),
  ...PartyWriteBaseSchema,
});

export async function updateParty(input: z.infer<typeof updatePartySchema>) {
  const { id, ownerId, teamId, organisationId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }

  // Defeat Capsule's owner→clears-team asymmetric PUT semantic on
  // /parties (NOTES-ON-CAPSULE-API.md §27, extended to parties in
  // §31 via v1.6.4 wire-trace). When ownerId is being touched and
  // teamId is omitted, read the current team and carry it forward;
  // skip the GET when teamId is explicit.
  let resolvedTeamId: number | null | undefined = teamId;
  if (ownerId !== undefined && teamId === undefined) {
    ({ teamId: resolvedTeamId } = await readEntityRefs(`/parties/${id}`, "party"));
  }

  setNullableRef(body, "owner", ownerId);
  setNullableRef(body, "team", resolvedTeamId);
  setNullableRef(body, "organisation", organisationId);
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ party: unknown }>(`/parties/${id}`, { party: body });
}

// ── batch_update_party (write, fan-out) ────────────────────────────────────

export const { schema: batchUpdatePartySchema, handler: batchUpdateParty } = defineBatch({
  toolName: "batch_update_party",
  itemSchema: updatePartySchema,
  itemDescription:
    "Array of 1–50 update_party inputs. Each item is the same shape as a single update_party call — id is required, every other field is optional. Capped at 50 so a single tool call can't burn an outsized share of Capsule's hourly per-token rate budget (~4000 req/h).",
  itemHandler: updateParty,
});

// ───────────────────────────────────────────────────────────────────────────

export const { schema: deletePartySchema, handler: deleteParty } = defineDelete({
  toolName: "delete_party",
  pathPrefix: "/parties",
  confirmHint:
    "Must be set to true. Deletes the party AND all linked notes, tasks, opportunities, and projects. " +
    "Deleting an ORGANISATION does NOT delete people linked to it via organisationId — their `organisation` field is silently cleared to null and they survive as standalone records. " +
    "Irreversible.",
});

// ── Atomic child-array operations ──────────────────────────────────────────
//
// Capsule's `PUT /parties/{id}` treats child arrays (emailAddresses,
// phoneNumbers, addresses, websites) as merge-not-replace. The
// add_party_*  and remove_party_*_by_id tools below give callers
// atomic, surgical control over those arrays without the surprises of
// the bulk-array path on `update_party` (which is append-only).
//
// Every add_* tool issues a single PUT with one new item — Capsule
// appends and returns the updated party.
//
// Every remove_*_by_id tool issues a single PUT with one
// `{id, _delete: true}` entry — Capsule removes that specific item
// and returns the updated party. (Note: the field is `_delete`, NOT
// the Rails-style `_destroy`. Capsule silently ignores `_destroy`,
// returning 200 OK with the row still present — see
// NOTES-ON-CAPSULE-API.md §18.)
// No `confirm: true` gate: removing one
// email address is reversible (re-add the value); only whole-record
// deletes (`delete_party`, `delete_opportunity`, ...) carry the
// confirm requirement.

/**
 * Factory for the four `remove_party_<row>_by_id` tools, which differ
 * only by the embedded-array key and the caller-facing id field name.
 * Encodes Capsule's `{id, _delete: true}` deletion shape (the field is
 * `_delete`, NOT Rails-style `_destroy` — NOTES-ON-CAPSULE-API.md §18)
 * and the idempotent already-removed envelope exactly once.
 *
 * The localized cast on the schema shape is required because a
 * computed property key (`[opts.idField]`) degrades TypeScript's
 * inference to an index signature; the cast restores the precise
 * per-tool field name for `z.infer` consumers.
 */
function definePartySubResourceRemove(opts: {
  arrayKey: string;
  idField: string;
  rowNoun: string;
}) {
  // Computed property keys degrade TS inference, so the shape is typed
  // as a uniform string-keyed record — the runtime shape (exactly
  // `partyId` + the per-tool id field, both positiveId) is what the MCP
  // layer serializes and validates.
  const shape: Record<string, typeof positiveId> = {
    partyId: positiveId,
    [opts.idField]: positiveId.describe(
      `Capsule's id for the ${opts.rowNoun} row. Read it from get_party (each entry in ${opts.arrayKey} carries an id).`,
    ),
  };
  const schema = z.object(shape);

  async function handler(input: z.infer<typeof schema>) {
    const partyId = input["partyId"] as number;
    const rowId = input[opts.idField] as number;
    return idempotentWithResult(
      () =>
        capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
          party: { [opts.arrayKey]: [{ id: rowId, _delete: true }] },
        }),
      (result): Record<string, unknown> => ({
        removed: true,
        alreadyRemoved: false,
        partyId,
        [opts.idField]: rowId,
        ...result,
      }),
      (): Record<string, unknown> => ({
        removed: true,
        alreadyRemoved: true,
        partyId,
        [opts.idField]: rowId,
      }),
    );
  }

  return { schema, handler };
}

// emailAddresses ─────────────────────────────────────────────────────

export const addPartyEmailAddressSchema = z.object({
  partyId: positiveId,
  address: z.string().email(),
  type: z.string().optional().describe("Free-form label, e.g. 'Work', 'Home'."),
});

export async function addPartyEmailAddress(input: z.infer<typeof addPartyEmailAddressSchema>) {
  const { partyId, address, type } = input;
  const item: Record<string, unknown> = { address };
  if (type !== undefined) item["type"] = type;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { emailAddresses: [item] },
  });
}

const removePartyEmailAddress = definePartySubResourceRemove({
  arrayKey: "emailAddresses",
  idField: "emailAddressId",
  rowNoun: "email-address",
});
export const removePartyEmailAddressByIdSchema = removePartyEmailAddress.schema;
export const removePartyEmailAddressById = removePartyEmailAddress.handler;

// phoneNumbers ───────────────────────────────────────────────────────

export const addPartyPhoneNumberSchema = z.object({
  partyId: positiveId,
  number: z.string().min(1),
  type: z.string().optional().describe("Free-form label, e.g. 'Work', 'Mobile'."),
});

export async function addPartyPhoneNumber(input: z.infer<typeof addPartyPhoneNumberSchema>) {
  const { partyId, number, type } = input;
  const item: Record<string, unknown> = { number };
  if (type !== undefined) item["type"] = type;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { phoneNumbers: [item] },
  });
}

const removePartyPhoneNumber = definePartySubResourceRemove({
  arrayKey: "phoneNumbers",
  idField: "phoneNumberId",
  rowNoun: "phone-number",
});
export const removePartyPhoneNumberByIdSchema = removePartyPhoneNumber.schema;
export const removePartyPhoneNumberById = removePartyPhoneNumber.handler;

// addresses ──────────────────────────────────────────────────────────

export const addPartyAddressSchema = z.object({
  partyId: positiveId,
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional().describe(CountryDescription),
  zip: z.string().optional(),
  type: z.string().optional().describe("Free-form label, e.g. 'Office', 'Home'."),
});

export async function addPartyAddress(input: z.infer<typeof addPartyAddressSchema>) {
  const { partyId, ...rest } = input;
  const item: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) item[k] = v;
  }
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { addresses: [item] },
  });
}

const removePartyAddress = definePartySubResourceRemove({
  arrayKey: "addresses",
  idField: "addressId",
  rowNoun: "address",
});
export const removePartyAddressByIdSchema = removePartyAddress.schema;
export const removePartyAddressById = removePartyAddress.handler;

// websites ───────────────────────────────────────────────────────────

export const addPartyWebsiteSchema = z
  .object({
    partyId: positiveId,
    address: z
      .string()
      .min(1)
      .describe(
        "The website address. A URL when service='URL', or a handle (e.g. '@acmeco') for social services.",
      ),
    service: WebsiteServiceEnum.optional().describe("Defaults to 'URL' if omitted."),
  })
  .superRefine(validateWebsiteAddress);

export async function addPartyWebsite(input: z.infer<typeof addPartyWebsiteSchema>) {
  const { partyId, address, service } = input;
  const item: Record<string, unknown> = { address };
  if (service !== undefined) item["service"] = service;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { websites: [item] },
  });
}

const removePartyWebsite = definePartySubResourceRemove({
  arrayKey: "websites",
  idField: "websiteId",
  rowNoun: "website",
});
export const removePartyWebsiteByIdSchema = removePartyWebsite.schema;
export const removePartyWebsiteById = removePartyWebsite.handler;
