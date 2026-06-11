/**
 * Deep-strip `.describe()` metadata from a Zod schema tree.
 *
 * Why: the `batch_*` tools embed their single-tool item schema
 * wholesale, so every nested field description was serialized into
 * `tools/list` twice — once on the single tool (the canonical copy)
 * and again inside the batch tool's `items` array. That duplication
 * is ~17 KB of the catalog payload with zero information content,
 * since the single tool is always co-registered (same read-only gate)
 * and the batch `items` description explicitly points at it.
 *
 * How: walk the schema tree; for container nodes, rebuild via
 * `clone({...def, <children>})` — zod v4 keeps refinements
 * (`refine`/`superRefine`) in `def.checks`, so cloning the def
 * preserves validation exactly. For any node carrying a description,
 * chain `.meta({ description: undefined })`, which removes the
 * description from JSON-Schema serialization without touching checks.
 *
 * Fail-open: node types the walker doesn't recognize pass through
 * untouched — worst case a description survives; validation can never
 * change.
 */

import { z } from "zod";

type Cloneable = z.ZodType & {
  clone(def: Record<string, unknown>): z.ZodType;
};

function cloneWithDef(node: z.ZodType, patch: Record<string, unknown>): z.ZodType {
  const def = (node as unknown as { def: Record<string, unknown> }).def;
  return (node as Cloneable).clone({ ...def, ...patch });
}

export function stripDescriptions(schema: z.ZodType): z.ZodType {
  let node: z.ZodType = schema;

  if (node instanceof z.ZodObject) {
    const shape = node.def.shape as Record<string, z.ZodType>;
    const next: Record<string, z.ZodType> = {};
    let changed = false;
    for (const [key, child] of Object.entries(shape)) {
      next[key] = stripDescriptions(child);
      if (next[key] !== child) changed = true;
    }
    if (changed) node = cloneWithDef(node, { shape: next });
  } else if (node instanceof z.ZodArray) {
    const element = stripDescriptions(node.def.element as z.ZodType);
    if (element !== node.def.element) node = cloneWithDef(node, { element });
  } else if (
    node instanceof z.ZodOptional ||
    node instanceof z.ZodNullable ||
    node instanceof z.ZodDefault ||
    node instanceof z.ZodReadonly
  ) {
    const innerType = stripDescriptions(node.def.innerType as z.ZodType);
    if (innerType !== node.def.innerType) node = cloneWithDef(node, { innerType });
  } else if (node instanceof z.ZodUnion) {
    const options = (node.def.options as z.ZodType[]).map(stripDescriptions);
    if (options.some((o, i) => o !== (node as z.ZodUnion).def.options[i])) {
      node = cloneWithDef(node, { options });
    }
  } else if (node instanceof z.ZodPipe) {
    // z.preprocess (positiveId) compiles to a pipe; descriptions on the
    // pipe node itself are handled below, inner stages recursed here.
    const inSchema = stripDescriptions(node.def.in as z.ZodType);
    const outSchema = stripDescriptions(node.def.out as z.ZodType);
    if (inSchema !== node.def.in || outSchema !== node.def.out) {
      node = cloneWithDef(node, { in: inSchema, out: outSchema });
    }
  }

  if (node.description !== undefined) {
    node = node.meta({ description: undefined });
  }
  return node;
}
