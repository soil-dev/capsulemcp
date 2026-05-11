import { z } from "zod";
import {
  CapsuleApiError,
  capsuleDelete,
  capsuleGet,
  capsulePost,
  capsulePut,
} from "../capsule/client.js";
import {
  CustomFieldWriteSchema,
  fieldsArrayDescriptor,
  mapFieldsForBody,
} from "./_custom-fields.js";

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

const AddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  zip: z.string().optional(),
});

// Capsule's API names this field `address`, not `url`. The name is
// generic because the value depends on `service`: a URL when
// `service: "URL"`, but a handle (e.g. "@anton") for social
// services like "TWITTER", "INSTAGRAM" — so URL-validation here
// would reject valid Capsule data. The 422 message Capsule returns
// when the wrong key is sent is "website.address: address is required".
const WebsiteSchema = z.object({
  address: z
    .string()
    .min(1)
    .describe(
      "The website address. A URL when service='URL', or a handle (e.g. '@anton') for social services like 'TWITTER', 'INSTAGRAM'. Capsule names this field `address` regardless of service type.",
    ),
  // Capsule's complete service list, copied verbatim from a 422
  // response body for a `PIGEON_POST` test:
  //   "options are: URL, SKYPE, TWITTER, LINKED_IN, FACEBOOK, XING,
  //    FEED, GOOGLE_PLUS, FLICKR, GITHUB, YOUTUBE, INSTAGRAM,
  //    PINTEREST, TIKTOK, THREADS, BLUESKY, SNAPCHAT"
  // Locked at the schema layer so typos surface before any HTTP
  // round-trip. If Capsule adds new services, the 422 will tell us.
  service: z
    .enum([
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
    ])
    .optional()
    .describe(
      "Service type. One of: URL, SKYPE, TWITTER, LINKED_IN, FACEBOOK, XING, FEED, GOOGLE_PLUS, FLICKR, GITHUB, YOUTUBE, INSTAGRAM, PINTEREST, TIKTOK, THREADS, BLUESKY, SNAPCHAT. Defaults to 'URL' if omitted.",
    ),
});

// ── Tool definitions ────────────────────────────────────────────────────────

export const searchPartiesSchema = z.object({
  q: z.string().optional().describe("Free-text search query"),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function searchParties(input: z.infer<typeof searchPartiesSchema>) {
  // Capsule uses a dedicated /parties/search endpoint when filtering by query.
  // Plain GET /parties ignores `q` and returns the full list, so we must route.
  const path = input.q ? "/parties/search" : "/parties";
  const { data, nextPage } = await capsuleGet<{ parties: unknown[] }>(path, {
    q: input.q,
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const getPartySchema = z.object({
  id: z.number().int().positive().describe("Party ID"),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
});

export async function getParty(input: z.infer<typeof getPartySchema>) {
  const { data } = await capsuleGet<{ party: unknown }>(`/parties/${input.id}`, {
    embed: input.embed,
  });
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
//
// Batch fetch up to 10 parties by id in a single call. Capsule's path
// syntax: GET /parties/<id1>,<id2>,... — the server caps at 10 per call.

export const getPartiesSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Array of party IDs (1–10). Capsule caps batch fetches at 10."),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'"),
});

export async function getParties(input: z.infer<typeof getPartiesSchema>) {
  const { data } = await capsuleGet<{ parties: unknown[] }>(
    `/parties/${input.ids.join(",")}`,
    { embed: input.embed },
  );
  return data;
}

// ───────────────────────────────────────────────────────────────────────────

export const listPartyOpportunitiesSchema = z.object({
  partyId: z.number().int().positive(),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listPartyOpportunities(
  input: z.infer<typeof listPartyOpportunitiesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{ opportunities: unknown[] }>(
    `/parties/${input.partyId}/opportunities`,
    { page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const listPartyProjectsSchema = z.object({
  partyId: z.number().int().positive(),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listPartyProjects(
  input: z.infer<typeof listPartyProjectsSchema>,
) {
  const { data, nextPage } = await capsuleGet<{ kases: unknown[] }>(
    `/parties/${input.partyId}/kases`,
    { page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
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
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_address and remove_party_address_by_id. Capsule canonicalises `country` through its country dictionary (e.g. 'USA' → 'United States') — normalisation, not rejection.",
    ),
  websites: z
    .array(WebsiteSchema)
    .optional()
    .describe(
      "APPEND-ONLY: items are merged into the existing list, never replaced. For atomic add/remove/replace use add_party_website and remove_party_website_by_id.",
    ),
  ownerId: z.number().int().positive().optional().describe("Assign to user ID"),
};

export const createPartySchema = z.object({
  type: z.enum(["person", "organisation"]),
  // person
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  jobTitle: z.string().optional(),
  organisationId: z.number().int().positive().optional().describe("Link person to an existing organisation ID"),
  // organisation
  name: z.string().optional(),
  ...PartyWriteBaseSchema,
});

export async function createParty(input: z.infer<typeof createPartySchema>) {
  const { ownerId, organisationId, ...rest } = input;

  const body: Record<string, unknown> = { ...rest };
  if (ownerId) body["owner"] = { id: ownerId };
  if (organisationId) body["organisation"] = { id: organisationId };

  return capsulePost<{ party: unknown }>("/parties", { party: body });
}

// ───────────────────────────────────────────────────────────────────────────

// Custom-field write schema, descriptor, and body-mapper all live in
// _custom-fields.ts (shared across update_party / update_opportunity /
// update_project).

export const updatePartySchema = z.object({
  id: z.number().int().positive(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  jobTitle: z.string().optional(),
  name: z.string().optional(),
  fields: z
    .array(CustomFieldWriteSchema)
    .optional()
    .describe(fieldsArrayDescriptor("get_party")),
  ...PartyWriteBaseSchema,
});

export async function updateParty(input: z.infer<typeof updatePartySchema>) {
  const { id, ownerId, fields, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (ownerId) body["owner"] = { id: ownerId };
  const mappedFields = mapFieldsForBody(fields);
  if (mappedFields !== undefined) body["fields"] = mappedFields;

  return capsulePut<{ party: unknown }>(`/parties/${id}`, { party: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const deletePartySchema = z.object({
  id: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe(
      "Must be set to true. Deletes the party AND all linked notes, tasks, opportunities, and projects (kases). " +
        "Deleting an ORGANISATION does NOT delete people linked to it via organisationId — their `organisation` field is silently cleared to null and they survive as standalone records. " +
        "Irreversible.",
    ),
});

export async function deleteParty(input: z.infer<typeof deletePartySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_party requires confirm: true");
  }
  try {
    await capsuleDelete(`/parties/${input.id}`);
    return { deleted: true, alreadyDeleted: false, id: input.id };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return { deleted: true, alreadyDeleted: true, id: input.id };
    }
    throw err;
  }
}

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
// returning 200 OK with the row still present — see Bug 9 in the
// v1.0.0-alpha.7 verification report and NOTES-ON-CAPSULE-API.md §18.)
// No `confirm: true` gate: removing one
// email address is reversible (re-add the value); only whole-record
// deletes (`delete_party`, `delete_opportunity`, ...) carry the
// confirm requirement.

// emailAddresses ─────────────────────────────────────────────────────

export const addPartyEmailAddressSchema = z.object({
  partyId: z.number().int().positive(),
  address: z.string().email(),
  type: z.string().optional().describe("Free-form label, e.g. 'Work', 'Home'."),
});

export async function addPartyEmailAddress(
  input: z.infer<typeof addPartyEmailAddressSchema>,
) {
  const { partyId, address, type } = input;
  const item: Record<string, unknown> = { address };
  if (type !== undefined) item["type"] = type;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { emailAddresses: [item] },
  });
}

export const removePartyEmailAddressByIdSchema = z.object({
  partyId: z.number().int().positive(),
  emailAddressId: z
    .number()
    .int()
    .positive()
    .describe(
      "Capsule's id for the email-address row. Read it from get_party (each entry in emailAddresses carries an id).",
    ),
});

export async function removePartyEmailAddressById(
  input: z.infer<typeof removePartyEmailAddressByIdSchema>,
) {
  const { partyId, emailAddressId } = input;
  try {
    const result = await capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
      party: { emailAddresses: [{ id: emailAddressId, _delete: true }] },
    });
    return {
      removed: true,
      alreadyRemoved: false,
      partyId,
      emailAddressId,
      ...result,
    };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return {
        removed: true,
        alreadyRemoved: true,
        partyId,
        emailAddressId,
      };
    }
    throw err;
  }
}

// phoneNumbers ───────────────────────────────────────────────────────

export const addPartyPhoneNumberSchema = z.object({
  partyId: z.number().int().positive(),
  number: z.string().min(1),
  type: z.string().optional().describe("Free-form label, e.g. 'Work', 'Mobile'."),
});

export async function addPartyPhoneNumber(
  input: z.infer<typeof addPartyPhoneNumberSchema>,
) {
  const { partyId, number, type } = input;
  const item: Record<string, unknown> = { number };
  if (type !== undefined) item["type"] = type;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { phoneNumbers: [item] },
  });
}

export const removePartyPhoneNumberByIdSchema = z.object({
  partyId: z.number().int().positive(),
  phoneNumberId: z
    .number()
    .int()
    .positive()
    .describe(
      "Capsule's id for the phone-number row. Read it from get_party (each entry in phoneNumbers carries an id).",
    ),
});

export async function removePartyPhoneNumberById(
  input: z.infer<typeof removePartyPhoneNumberByIdSchema>,
) {
  const { partyId, phoneNumberId } = input;
  try {
    const result = await capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
      party: { phoneNumbers: [{ id: phoneNumberId, _delete: true }] },
    });
    return {
      removed: true,
      alreadyRemoved: false,
      partyId,
      phoneNumberId,
      ...result,
    };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return {
        removed: true,
        alreadyRemoved: true,
        partyId,
        phoneNumberId,
      };
    }
    throw err;
  }
}

// addresses ──────────────────────────────────────────────────────────

export const addPartyAddressSchema = z.object({
  partyId: z.number().int().positive(),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z
    .string()
    .optional()
    .describe(
      "Capsule canonicalises through its country dictionary (e.g. 'USA' is stored as 'United States') — normalisation, not rejection.",
    ),
  zip: z.string().optional(),
  type: z.string().optional().describe("Free-form label, e.g. 'Office', 'Home'."),
});

export async function addPartyAddress(
  input: z.infer<typeof addPartyAddressSchema>,
) {
  const { partyId, ...rest } = input;
  const item: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) item[k] = v;
  }
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { addresses: [item] },
  });
}

export const removePartyAddressByIdSchema = z.object({
  partyId: z.number().int().positive(),
  addressId: z
    .number()
    .int()
    .positive()
    .describe(
      "Capsule's id for the address row. Read it from get_party (each entry in addresses carries an id).",
    ),
});

export async function removePartyAddressById(
  input: z.infer<typeof removePartyAddressByIdSchema>,
) {
  const { partyId, addressId } = input;
  try {
    const result = await capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
      party: { addresses: [{ id: addressId, _delete: true }] },
    });
    return {
      removed: true,
      alreadyRemoved: false,
      partyId,
      addressId,
      ...result,
    };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return {
        removed: true,
        alreadyRemoved: true,
        partyId,
        addressId,
      };
    }
    throw err;
  }
}

// websites ───────────────────────────────────────────────────────────

export const addPartyWebsiteSchema = z.object({
  partyId: z.number().int().positive(),
  address: z
    .string()
    .min(1)
    .describe(
      "The website address. A URL when service='URL', or a handle (e.g. '@anton') for social services.",
    ),
  service: z
    .enum([
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
    ])
    .optional()
    .describe("Defaults to 'URL' if omitted."),
});

export async function addPartyWebsite(
  input: z.infer<typeof addPartyWebsiteSchema>,
) {
  const { partyId, address, service } = input;
  const item: Record<string, unknown> = { address };
  if (service !== undefined) item["service"] = service;
  return capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
    party: { websites: [item] },
  });
}

export const removePartyWebsiteByIdSchema = z.object({
  partyId: z.number().int().positive(),
  websiteId: z
    .number()
    .int()
    .positive()
    .describe(
      "Capsule's id for the website row. Read it from get_party (each entry in websites carries an id).",
    ),
});

export async function removePartyWebsiteById(
  input: z.infer<typeof removePartyWebsiteByIdSchema>,
) {
  const { partyId, websiteId } = input;
  try {
    const result = await capsulePut<{ party: unknown }>(`/parties/${partyId}`, {
      party: { websites: [{ id: websiteId, _delete: true }] },
    });
    return {
      removed: true,
      alreadyRemoved: false,
      partyId,
      websiteId,
      ...result,
    };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 404) {
      return {
        removed: true,
        alreadyRemoved: true,
        partyId,
        websiteId,
      };
    }
    throw err;
  }
}
