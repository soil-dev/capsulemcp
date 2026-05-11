/**
 * Tag operations.
 *
 * Read: `list_tags(entity)` returns the tenant-global tag dictionary
 * scoped to a resource type (parties / opportunities / kases).
 *
 * Writes (alpha.10+): atomic add/remove on a specific entity, mirroring
 * the per-row pattern used by the email/phone/address/website tools in
 * src/tools/parties.ts:
 *   - `add_tag(entity, entityId, tagName)` — attach by name; Capsule
 *     resolves to an existing tag in the tenant or creates a fresh one.
 *   - `remove_tag_by_id(entity, entityId, tagId)` — detach from this
 *     entity only; the tag persists in the tenant for other entities
 *     that share it.
 *
 * IMPORTANT — two different "tag IDs":
 *   - The GLOBAL tag id (from list_tags) identifies a tag definition
 *     in the tenant.
 *   - The PER-ENTITY LINK id (from get_party / get_opportunity /
 *     get_project with `embed=tags`) is the row id of the entity↔tag
 *     link on a specific record.
 * For `remove_tag_by_id` Capsule REQUIRES the per-entity link id, not
 * the global tag id. The tool description spells that out.
 *
 * Capsule docs:
 *   https://developer.capsulecrm.com/v2/operations/Party
 *   https://developer.capsulecrm.com/v2/operations/Opportunity
 *   https://developer.capsulecrm.com/v2/operations/Project
 */

import { z } from "zod";
import { capsuleGet, capsulePut } from "../capsule/client.js";

const TAG_LIST_PATH = {
  parties: "/parties/tags",
  opportunities: "/opportunities/tags",
  kases: "/kases/tags",
} as const;

// Capsule's path component is `parties` / `opportunities` / `kases`;
// the body wrapper key is `party` / `opportunity` / `kase`.
const ENTITY_TO_WRAPPER = {
  parties: "party",
  opportunities: "opportunity",
  kases: "kase",
} as const;

const TagEntity = z
  .enum(["parties", "opportunities", "kases"])
  .describe(
    "Which entity type. Use 'kases' for projects (Capsule's legacy path name).",
  );

// ── list_tags (read) ──────────────────────────────────────────────────────

export const listTagsSchema = z.object({
  entity: z.enum(["parties", "opportunities", "kases"]).describe(
    "The resource type to list tags for",
  ),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export async function listTags(input: z.infer<typeof listTagsSchema>) {
  const path = TAG_LIST_PATH[input.entity];
  const { data, nextPage } = await capsuleGet<{ tags: unknown[] }>(path, {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ── add_tag (write) ───────────────────────────────────────────────────────

export const addTagSchema = z.object({
  entity: TagEntity,
  entityId: z.number().int().positive().describe("The party/opportunity/kase id."),
  tagName: z
    .string()
    .min(1)
    .describe(
      "Name of the tag to attach. Capsule resolves by name: if a tag with this name already exists in the tenant it is attached to the entity; if not, Capsule creates the tag and attaches it. Names are case-sensitive and tenant-global. Use list_tags first if you need to avoid accidentally creating a near-duplicate (e.g. 'Zendesk' vs 'zendesk'). Idempotent — re-attaching an already-attached tag is harmless.",
    ),
});

export async function addTag(input: z.infer<typeof addTagSchema>) {
  const { entity, entityId, tagName } = input;
  const wrapper = ENTITY_TO_WRAPPER[entity];
  return capsulePut<Record<string, unknown>>(`/${entity}/${entityId}`, {
    [wrapper]: { tags: [{ name: tagName }] },
  });
}

// ── remove_tag_by_id (write) ──────────────────────────────────────────────

export const removeTagByIdSchema = z.object({
  entity: TagEntity,
  entityId: z.number().int().positive().describe("The party/opportunity/kase id."),
  tagId: z
    .number()
    .int()
    .positive()
    .describe(
      "The PER-ENTITY tag LINK id — NOT the global tag id from list_tags. " +
        "Read the entity with embed=tags (e.g. get_party with embed='tags'), and use the `id` field on each tag entry in the response. " +
        "Removing detaches the tag from this entity only; the tag itself persists in the tenant for other entities that share it.",
    ),
});

export async function removeTagById(
  input: z.infer<typeof removeTagByIdSchema>,
) {
  const { entity, entityId, tagId } = input;
  const wrapper = ENTITY_TO_WRAPPER[entity];
  return capsulePut<Record<string, unknown>>(`/${entity}/${entityId}`, {
    [wrapper]: { tags: [{ id: tagId, _delete: true }] },
  });
}
