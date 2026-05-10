import { z } from "zod";
import {
  capsuleDelete,
  capsuleGet,
  capsulePostNoContent,
} from "../capsule/client.js";

// Inter-entity relationships:
//
//   list_additional_parties(entity, entityId)
//     GET /<entity>/{id}/parties — secondary party links on an
//     opportunity or project. The "main" party is on the entity itself
//     (opportunity.party); additional parties are e.g. partners,
//     consultants, or referrers also involved in the deal.
//   add_additional_party(entity, entityId, partyId)
//     POST /<entity>/{id}/parties/{partyId}
//   remove_additional_party(entity, entityId, partyId, confirm)
//     DELETE /<entity>/{id}/parties/{partyId}
//
//   list_associated_projects(opportunityId)
//     GET /opportunities/{id}/kases — projects linked to a given
//     opportunity. Inverse direction (projects → opportunities) is
//     covered by the project's `opportunity` field.
//
// `entity` for additional parties is "opportunities" or "kases" only.
// (Capsule's API uses /kases for projects.)

const RelationshipEntity = z
  .enum(["opportunities", "kases"])
  .describe(
    "Which entity has the additional-party links. Use 'kases' for projects.",
  );

// ── List additional parties ─────────────────────────────────────────────────

export const listAdditionalPartiesSchema = z.object({
  entity: RelationshipEntity,
  entityId: z.number().int().positive().describe("ID of the opportunity or project."),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'."),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listAdditionalParties(
  input: z.infer<typeof listAdditionalPartiesSchema>,
) {
  const { data, nextPage } = await capsuleGet<{ parties: unknown[] }>(
    `/${input.entity}/${input.entityId}/parties`,
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}

// ── Add additional party ────────────────────────────────────────────────────

export const addAdditionalPartySchema = z.object({
  entity: RelationshipEntity,
  entityId: z.number().int().positive(),
  partyId: z
    .number()
    .int()
    .positive()
    .describe("ID of the party (person or organisation) to link as an additional party."),
});

export async function addAdditionalParty(
  input: z.infer<typeof addAdditionalPartySchema>,
) {
  // Capsule returns 204 No Content on success — there's no JSON body
  // to parse. `capsulePostNoContent` handles the empty response cleanly.
  await capsulePostNoContent(
    `/${input.entity}/${input.entityId}/parties/${input.partyId}`,
  );
  return {
    linked: true,
    entity: input.entity,
    entityId: input.entityId,
    partyId: input.partyId,
  };
}

// ── Remove additional party ─────────────────────────────────────────────────

export const removeAdditionalPartySchema = z.object({
  entity: RelationshipEntity,
  entityId: z.number().int().positive(),
  partyId: z.number().int().positive(),
  confirm: z
    .literal(true)
    .describe(
      "Must be set to true. Removes the link between the entity and the additional party. The party itself is not deleted. Reversible by re-adding the link.",
    ),
});

export async function removeAdditionalParty(
  input: z.infer<typeof removeAdditionalPartySchema>,
) {
  if (input.confirm !== true) {
    throw new Error("remove_additional_party requires confirm: true");
  }
  await capsuleDelete(
    `/${input.entity}/${input.entityId}/parties/${input.partyId}`,
  );
  return {
    removed: true,
    entity: input.entity,
    entityId: input.entityId,
    partyId: input.partyId,
  };
}

// ── List associated projects (opportunity → projects) ───────────────────────

export const listAssociatedProjectsSchema = z.object({
  opportunityId: z.number().int().positive(),
  embed: z.string().optional().describe("Comma-separated embeds, e.g. 'tags,fields'."),
  page: z.number().int().positive().optional().default(1),
  perPage: z.number().int().min(1).max(100).optional().default(25),
});

export async function listAssociatedProjects(
  input: z.infer<typeof listAssociatedProjectsSchema>,
) {
  // Capsule's API uses /kases for projects.
  const { data, nextPage } = await capsuleGet<{ kases: unknown[] }>(
    `/opportunities/${input.opportunityId}/kases`,
    { embed: input.embed, page: input.page, perPage: input.perPage },
  );
  return { ...data, nextPage };
}
