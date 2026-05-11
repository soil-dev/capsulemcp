/**
 * Helper to register an MCP tool whose handler returns any value and
 * needs to be wrapped in the standard JSON-stringify-into-text MCP
 * response shape.
 *
 * Why this exists:
 * - Reduces 8 lines per `server.tool(...)` registration to a single
 *   call, collapsing >400 LOC of repetitive wrapper boilerplate
 *   in src/server.ts.
 * - Puts the tool NAME and DESCRIPTION on the same call (positional
 *   args 2 and 3), eliminating the "Edit collapses two adjacent
 *   string lines" footgun that has hit the alpha series three times
 *   while editing description text.
 *
 * The exception is `get_attachment` — its handler does
 * content-type-aware response shaping (image vs text vs binary) and
 * needs the raw `server.tool(...)` call. That registration stays
 * inline.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";

/** Wrap a handler's return value in the MCP `content: [{text}]` shape. */
function wrapAsText(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Register an MCP tool whose handler takes a zod-typed input and
 * returns any JSON-serialisable value. The value gets wrapped in the
 * standard MCP text-content response.
 */
export function registerTool<Schema extends z.ZodObject<ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  schema: Schema,
  handler: (input: z.infer<Schema>) => Promise<unknown>,
): void {
  // Use the SDK config-form registerTool with the full Zod schema. The
  // deprecated shape overload rebuilds z.object(schema.shape), which drops
  // object-level refinements such as superRefine.
  const registerWithSchema = server.registerTool.bind(server) as (
    toolName: string,
    config: { description: string; inputSchema: Schema },
    callback: (input: z.infer<Schema>) => Promise<CallToolResult>,
  ) => void;

  registerWithSchema(name, { description, inputSchema: schema }, async (input) => {
    const result = await handler(input);
    return wrapAsText(result);
  });
}
