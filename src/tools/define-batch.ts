/**
 * Helper for building `batch_<entity>` MCP tools that fan out a single
 * write per item via `batchExecute`.
 *
 * Every items-style batch tool (`batch_update_party`,
 * `batch_update_opportunity`, `batch_add_tag`, `batch_remove_tag_by_id`,
 * …) follows the same shape:
 *
 *   - Schema is `z.object({ items: z.array(<single-schema>).min(1).max(50).describe(...) })`
 *   - Handler calls `batchExecute(toolName, input.items, single, opts)`
 *
 * Centralising the shape means the schema cap (50), the per-item array
 * description hint, and the wiring to `batchExecute` stay uniform —
 * adding a new batch tool reduces to "specify the single schema +
 * single handler + a per-item description string".
 *
 * Excluded by design: `batch_complete_task` uses `{ids: array(positiveId)}`
 * shape rather than `{items: array(singleSchema)}` (it wraps each id in
 * `{id}` before calling the single handler). Different enough that
 * sharing a helper would force generic gymnastics for marginal gain;
 * it stays inline in tasks.ts.
 */

import { z } from "zod";
import { type BatchOpts, type BatchResponse, batchExecute } from "../capsule/batch.js";
import { stripDescriptions } from "./strip-descriptions.js";

interface DefineBatchArgs<S extends z.ZodObject<z.ZodRawShape>> {
  /** Tool name, e.g. "batch_update_party". Used in `batchExecute` and `batch.complete` logs. */
  toolName: string;
  /** Zod schema for a single item. Items go through this validator individually. */
  itemSchema: S;
  /** Description text for the `items` array on the batch schema. Surfaces to the LLM via tools/list. */
  itemDescription: string;
  /** Single-item handler invoked per element. The same handler the non-batch tool uses. */
  itemHandler: (item: z.infer<S>) => Promise<unknown>;
}

export function defineBatch<S extends z.ZodObject<z.ZodRawShape>>(args: DefineBatchArgs<S>) {
  // Register a description-stripped clone of the item schema: the
  // nested .describe() text would otherwise be serialized into
  // tools/list twice (once on the co-registered single tool — the
  // canonical copy — and again here), ~17 KB of pure duplication
  // across the five batch tools. Validation is identical; the cast
  // back to S is sound because stripDescriptions only removes
  // metadata, never structure or checks.
  const itemSchema = stripDescriptions(args.itemSchema) as S;
  const schema = z.object({
    items: z.array(itemSchema).min(1).max(50).describe(args.itemDescription),
  });

  async function handler(
    input: z.infer<typeof schema>,
    opts: BatchOpts = {},
  ): Promise<BatchResponse<unknown>> {
    return batchExecute(args.toolName, input.items, args.itemHandler, opts);
  }

  return { schema, handler };
}
