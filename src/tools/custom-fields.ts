import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

// Custom field SCHEMA endpoints (read-only here). Each entity type
// (parties, opportunities, kases) has its own custom-field namespace.
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
  .enum(["parties", "opportunities", "kases"])
  .describe("Which entity type's custom field schema to inspect. Use 'kases' for projects.");

// ── List custom field definitions ───────────────────────────────────────────

export const listCustomFieldsSchema = z.object({
  entity: CustomFieldEntity,
});

export async function listCustomFields(input: z.infer<typeof listCustomFieldsSchema>) {
  const { data } = await capsuleGet<{ definitions: unknown[] }>(
    `/${input.entity}/fields/definitions`,
  );
  return data;
}

// ── Show one custom field definition ────────────────────────────────────────

export const getCustomFieldSchema = z.object({
  entity: CustomFieldEntity,
  fieldId: z.number().int().positive().describe("Custom field definition id."),
});

export async function getCustomField(input: z.infer<typeof getCustomFieldSchema>) {
  const { data } = await capsuleGet<{ definition: unknown }>(
    `/${input.entity}/fields/definitions/${input.fieldId}`,
  );
  return data;
}
