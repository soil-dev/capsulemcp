import { z } from "zod";
import { capsuleDelete, capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

// ── Shared sub-schemas ──────────────────────────────────────────────────────

const EmailAddressSchema = z.object({
  address: z.string().email(),
  type: z.string().optional(),
});

const PhoneNumberSchema = z.object({
  number: z.string(),
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
  service: z
    .string()
    .optional()
    .describe(
      "Service type, e.g. 'URL', 'TWITTER', 'INSTAGRAM', 'LINKED_IN'. Defaults to 'URL' if omitted.",
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

const PartyWriteBaseSchema = {
  about: z.string().optional(),
  emailAddresses: z.array(EmailAddressSchema).optional(),
  phoneNumbers: z.array(PhoneNumberSchema).optional(),
  addresses: z.array(AddressSchema).optional(),
  websites: z.array(WebsiteSchema).optional(),
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

export const updatePartySchema = z.object({
  id: z.number().int().positive(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  jobTitle: z.string().optional(),
  name: z.string().optional(),
  ...PartyWriteBaseSchema,
});

export async function updateParty(input: z.infer<typeof updatePartySchema>) {
  const { id, ownerId, ...rest } = input;

  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  if (ownerId) body["owner"] = { id: ownerId };

  return capsulePut<{ party: unknown }>(`/parties/${id}`, { party: body });
}

// ───────────────────────────────────────────────────────────────────────────

export const deletePartySchema = z.object({
  id: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe("Must be set to true. Deletes the party AND all linked notes/tasks/opportunities. Irreversible."),
});

export async function deleteParty(input: z.infer<typeof deletePartySchema>) {
  if (input.confirm !== true) {
    throw new Error("delete_party requires confirm: true");
  }
  await capsuleDelete(`/parties/${input.id}`);
  return { deleted: true, id: input.id };
}
