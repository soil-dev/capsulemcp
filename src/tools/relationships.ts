import { z } from "zod";
import {
  ENTITY_PATH,
  positiveId,
  paginationFields,
  embedParam,
  PARTY_EMBEDS,
  PROJECT_EMBEDS,
} from "./shared-schemas.js";
import { confirmFlag } from "./confirm-flag.js";
import {
  CapsuleApiError,
  capsuleDelete,
  capsuleGetList,
  capsulePostNoContent,
} from "../capsule/client.js";
import { idempotent } from "../capsule/idempotent.js";

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
// `entity` for additional parties is "opportunities" or "projects" only.
// (Capsule's API uses /kases for projects.)

const RelationshipEntity = z
  .enum(["opportunities", "projects"])
  .describe("Which entity has the additional-party links.");

// ── List additional parties ─────────────────────────────────────────────────

export const listAdditionalPartiesSchema = z.object({
  entity: RelationshipEntity,
  entityId: positiveId.describe("ID of the opportunity or project."),
  embed: embedParam(PARTY_EMBEDS),
  ...paginationFields,
});

export async function listAdditionalParties(input: z.infer<typeof listAdditionalPartiesSchema>) {
  return capsuleGetList<{ parties: unknown[] }>(
    `/${ENTITY_PATH[input.entity]}/${input.entityId}/parties`,
    {
      embed: input.embed,
      page: input.page,
      perPage: input.perPage,
    },
  );
}

// ── Add additional party ────────────────────────────────────────────────────

export const addAdditionalPartySchema = z.object({
  entity: RelationshipEntity,
  entityId: positiveId,
  partyId: positiveId.describe(
    "ID of the party (person or organisation) to link as an additional party.",
  ),
});

export async function addAdditionalParty(input: z.infer<typeof addAdditionalPartySchema>) {
  // Capsule returns 204 No Content on success — there's no JSON body
  // to parse. `capsulePostNoContent` handles the empty response cleanly.
  //
  // Idempotency: Capsule rejects a re-add of an already-linked party
  // with `422 party is already a contact for this opportunity` (or the
  // equivalent on kases). We catch that specific 422 and convert it to
  // a success shape with `alreadyLinked: true`, so the tool delivers
  // on the "idempotent — re-adding is harmless" promise in its
  // description. Other 422s (and any other error class) still surface.
  //
  // Also catches the symmetric `party is already related to this
  // opportunity` case (Capsule's wording when the target party is the
  // MAIN party on the entity, not an additional). Different error
  // message, same end-state ("link exists, no-op").
  try {
    await capsulePostNoContent(
      `/${ENTITY_PATH[input.entity]}/${input.entityId}/parties/${input.partyId}`,
    );
    return {
      linked: true,
      alreadyLinked: false,
      entity: input.entity,
      entityId: input.entityId,
      partyId: input.partyId,
    };
  } catch (err) {
    if (err instanceof CapsuleApiError && err.status === 422) {
      const msg = err.message.toLowerCase();
      if (msg.includes("already a contact") || msg.includes("already related")) {
        return {
          linked: true,
          alreadyLinked: true,
          entity: input.entity,
          entityId: input.entityId,
          partyId: input.partyId,
        };
      }
    }
    throw err;
  }
}

// ── Remove additional party ─────────────────────────────────────────────────

export const removeAdditionalPartySchema = z.object({
  entity: RelationshipEntity,
  entityId: positiveId,
  partyId: positiveId,
  confirm: confirmFlag().describe(
    "Must be set to true. Removes the link between the entity and the additional party. The party itself is not deleted. Reversible by re-adding the link.",
  ),
});

export async function removeAdditionalParty(input: z.infer<typeof removeAdditionalPartySchema>) {
  if (input.confirm !== true) {
    throw new Error("remove_additional_party requires confirm: true");
  }
  // Capsule's 404 here covers both "party doesn't exist" and "party
  // isn't linked to this entity" — both are observationally "the link
  // doesn't exist", treat both as already-removed.
  return idempotent(
    () => capsuleDelete(`/${ENTITY_PATH[input.entity]}/${input.entityId}/parties/${input.partyId}`),
    () => ({
      removed: true,
      alreadyRemoved: false,
      entity: input.entity,
      entityId: input.entityId,
      partyId: input.partyId,
    }),
    () => ({
      removed: true,
      alreadyRemoved: true,
      entity: input.entity,
      entityId: input.entityId,
      partyId: input.partyId,
    }),
  );
}

// ── List associated projects (opportunity → projects) ───────────────────────

export const listAssociatedProjectsSchema = z.object({
  opportunityId: positiveId,
  embed: embedParam(PROJECT_EMBEDS),
  ...paginationFields,
});

export async function listAssociatedProjects(input: z.infer<typeof listAssociatedProjectsSchema>) {
  // Capsule's API uses /kases for projects.
  return capsuleGetList<{ projects: unknown[] }>(`/opportunities/${input.opportunityId}/kases`, {
    embed: input.embed,
    page: input.page,
    perPage: input.perPage,
  });
}
