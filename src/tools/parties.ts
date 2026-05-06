import { z } from "zod";
import { capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

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

const WebsiteSchema = z.object({
  url: z.string().url(),
  service: z.string().optional(),
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
