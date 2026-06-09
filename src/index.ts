import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isReadOnly } from "./capsule/client.js";
import { createCapsuleMcpServer } from "./server.js";

// Fail fast on missing CAPSULE_API_TOKEN. Without this the server would
// boot, register tools, and only error out on the first tool invocation —
// a confusing UX in MCP-host UIs where the failure surfaces as "tool
// errored" rather than "server failed to start." Matches the HTTP entry's
// fail-fast pattern in src/http.ts.
if (!process.env["CAPSULE_API_TOKEN"]) {
  console.error(
    "[capsulemcp] CAPSULE_API_TOKEN environment variable is not set. " +
      "Generate a Personal Access Token via My Preferences → API Authentication Tokens in Capsule.",
  );
  process.exit(1);
}

// MCP Tasks (SEP-1686) require a per-caller `clientId` for the task
// store's tenant-isolation boundary — which is why the HTTP transport
// derives it from OAuth. The stdio transport is inherently single-tenant
// (one local process, one user), so we supply a fixed synthetic clientId
// here; that's the correct scope, and it's the only thing that was
// keeping `MCP_TASKS_ENABLED=1` from wiring tasks on stdio. Harmless when
// tasks are disabled (the default): `createCapsuleMcpServer` only
// consults clientId when `MCP_TASKS_ENABLED` is set.
const STDIO_CLIENT_ID = "stdio-local";
const server = createCapsuleMcpServer({ clientId: STDIO_CLIENT_ID });
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
