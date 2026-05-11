/**
 * Shared schema + body-mapping for custom-field writes on
 * `update_party`, `update_opportunity`, `update_project`. Imported
 * from each of those tool files; defining it once eliminates the
 * three-place drift risk that surfaced through alpha.10–alpha.12 as
 * the descriptions and value-type rules accumulated.
 *
 * Capsule's PUT body accepts three shapes for `fields` items:
 *   {definition: {id: <defId>}, value: <value>}  // set/create
 *   {id: <rowId>, value: <newValue>}             // update existing row
 *   {id: <rowId>, _delete: true}                 // remove the row
 *
 * We expose only the first form: callers address a field by its
 * definitionId (discoverable via list_custom_fields). Capsule
 * resolves whether the value already exists for this entity and
 * updates or creates accordingly. To clear a value, pass `value:
 * null` — works for TEXT / NUMBER / DATE / LIST but not BOOLEAN
 * (Bug 12 from the alpha.10 verification; set BOOLEAN to false
 * instead).
 *
 * The filename is `_` prefixed so the dir listing groups shared
 * helpers ahead of resource modules.
 */

import { z } from "zod";

export const CustomFieldWriteSchema = z.object({
  definitionId: z
    .number()
    .int()
    .positive()
    .describe(
      "The custom-field definition id from list_custom_fields. Identifies which field on the entity to set.",
    ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe(
      "The new value. String for TEXT / DATE / LIST / LARGE_TEXT / LINK fields, number for NUMBER fields, boolean for BOOLEAN fields. " +
        "Clearing: pass null for TEXT / NUMBER / DATE / LIST (Capsule removes the row). BOOLEAN does NOT accept null and Capsule responds 422 'invalid type for field'; set the BOOLEAN to false instead. " +
        "NUMBER quirks: Capsule stores numerics correctly but the read-back via embed=fields returns them as STRINGS (e.g. value=3 reads as '3'); callers comparing values must coerce. " +
        "TEXT quirks: value='' has the same observable effect as value=null (row removed); empty-string and never-set are indistinguishable.",
    ),
});

export type CustomFieldWriteInput = z.infer<typeof CustomFieldWriteSchema>;

/**
 * Per-tool description for the wrapping `fields` array parameter.
 * Customise the entity-name reference in the embed=fields example
 * via the `entityToolName` argument (e.g. "get_party",
 * "get_opportunity", "get_project"); the rest of the text is the
 * same across all three tools.
 */
export function fieldsArrayDescriptor(entityToolName: string): string {
  return (
    "Set custom field values on this record. PARTIAL UPDATE: only the definitions you list are touched; any field NOT in this array is left unchanged. " +
    `Discover available definitions via list_custom_fields; read current values via ${entityToolName} with embed='fields'.`
  );
}

/**
 * Map the caller-facing `[{definitionId, value}]` shape to Capsule's
 * PUT-body shape `[{definition: {id}, value}]`. Used by the three
 * update_* handlers. Returns undefined when `fields` is undefined so
 * callers can use `if (mapped !== undefined) body.fields = mapped`.
 */
export function mapFieldsForBody(
  fields: CustomFieldWriteInput[] | undefined,
): Array<{ definition: { id: number }; value: unknown }> | undefined {
  if (fields === undefined) return undefined;
  return fields.map((f) => ({
    definition: { id: f.definitionId },
    value: f.value,
  }));
}
