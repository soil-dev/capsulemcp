import { z } from "zod";
import { ENTITY_PATH, positiveId } from "./shared-schemas.js";
import { capsuleGetCached } from "../capsule/client.js";

// Custom field SCHEMA endpoints (read-only here). Each entity type
// (parties, opportunities, projects) has its own custom-field namespace.
//
//   GET /<entity>/fields/definitions        — list all field definitions
//   GET /<entity>/fields/definitions/{id}   — show one definition
//
// These describe the SHAPE of custom fields (name, type, options for
// list-type fields, validation rules) — NOT the values on individual
// records. To read values on a record, use the entity's `embed=fields`
// parameter on get_party / get_opportunity / get_project.
//
// Create / update / delete of custom field definitions is admin work
// best done in Capsule's web UI; not exposed.

const CustomFieldEntity = z
  .enum(["parties", "opportunities", "projects"])
  .describe("Which entity type's custom field schema to inspect.");

// ── List custom field definitions ───────────────────────────────────────────

export const listCustomFieldsSchema = z.object({
  entity: CustomFieldEntity,
});

export async function listCustomFields(input: z.infer<typeof listCustomFieldsSchema>) {
  const { data } = await capsuleGetCached<{ definitions: unknown[] }>(
    `/${ENTITY_PATH[input.entity]}/fields/definitions`,
  );
  return data;
}

// ── Show one custom field definition ────────────────────────────────────────

export const getCustomFieldSchema = z.object({
  entity: CustomFieldEntity,
  id: positiveId.describe("Custom field definition id."),
});

export async function getCustomField(input: z.infer<typeof getCustomFieldSchema>) {
  const { data } = await capsuleGetCached<{ definition: unknown }>(
    `/${input.entity}/fields/definitions/${input.id}`,
  );
  return data;
}
