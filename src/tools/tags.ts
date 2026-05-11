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
 * Tag id model — verified live during the alpha.10 production run:
 * Capsule uses a SINGLE id per tag across both list_tags and
 * embed=tags on an entity. Earlier wording on these tools warned
 * that the two were different — that turned out to be wrong; both
 * sources return the same id and remove_tag_by_id accepts either.
 * The descriptions now recommend reading via embed=tags anyway,
 * because that confirms the tag is actually attached to the
 * specific entity before you try to remove it (a list_tags id
 * for a tag NOT on this entity would 422 "tag not found to delete").
 *
 * Capsule docs:
 *   https://developer.capsulecrm.com/v2/operations/Party
 *   https://developer.capsulecrm.com/v2/operations/Opportunity
 *   https://developer.capsulecrm.com/v2/operations/Project
 */

import { z } from "zod";
import { capsuleGet, capsulePut } from "../capsule/client.js";
import {
  idempotentWithResult,
  isCapsuleTagNotFound,
} from "../capsule/idempotent.js";

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
      "Name of the tag to attach. Capsule resolves by name: if a tag with this name already exists in the tenant it is attached to the entity; if not, Capsule creates the tag and attaches it. Names are tenant-global. Capsule matches case-INSENSITIVELY when resolving (so 'VIP' and 'vip' attach the same tag), preserving the canonical casing from whichever variant was created first. To ensure consistent casing in your tag list, call list_tags first and reuse the exact name from there. Idempotent — re-attaching an already-attached tag is harmless.",
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
      "The tag's id. Read via get_party / get_opportunity / get_project with embed='tags' — each tag entry in the response has an `id` field. list_tags returns the same ids for the same tags, so either source works; reading via embed first is the safer pattern because it confirms the tag is actually attached to this entity before you try to remove it (otherwise Capsule returns 422 'tag not found to delete'). Removing detaches the tag from this entity only; the tag definition itself persists in the tenant for other entities that share it.",
    ),
});

export async function removeTagById(
  input: z.infer<typeof removeTagByIdSchema>,
) {
  const { entity, entityId, tagId } = input;
  const wrapper = ENTITY_TO_WRAPPER[entity];
  return idempotentWithResult(
    () =>
      capsulePut<Record<string, unknown>>(`/${entity}/${entityId}`, {
        [wrapper]: { tags: [{ id: tagId, _delete: true }] },
      }),
    (result) => ({
      removed: true,
      alreadyRemoved: false,
      entity,
      entityId,
      tagId,
      ...result,
    }),
    () => ({ removed: true, alreadyRemoved: true, entity, entityId, tagId }),
    // Tag detach uses PUT with _delete: true and 422s with "tag not
    // found to delete" on a not-attached tag, instead of the standard
    // 404. Other 422s with different wording still surface.
    isCapsuleTagNotFound,
  );
}
