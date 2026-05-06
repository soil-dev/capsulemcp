import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isReadOnly } from "./capsule/client.js";
import { createCapsuleMcpServer } from "./server.js";

const server = createCapsuleMcpServer();
const transport = new StdioServerTransport();

if (isReadOnly()) {
  // Stdout is reserved for MCP protocol traffic — log boot info to stderr.
  console.error("[capsulemcp] read-only mode: write/delete tools are not registered");
}

try {
  await server.connect(transport);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[capsulemcp] Failed to start: ${message}`);
  process.exit(1);
}
