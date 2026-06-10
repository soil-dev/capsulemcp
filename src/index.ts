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

/**
 * Exit cleanly when the MCP client disconnects. The stdio transport's
 * lifetime IS the client connection: when the host (Claude Desktop, etc.)
 * tears down the pipe — on quit, on a reconnect flap, or by abandoning a
 * replaced instance — this process should die, not linger.
 *
 * The SDK's StdioServerTransport listens only for stdin `data`/`error`;
 * it never watches for EOF and keeps stdin referenced, so without this an
 * abandoned instance runs forever — a zombie that accumulates across
 * reconnects, pins resources, and can confuse the host's next connection.
 * We watch every disconnect signal and exit 0:
 *
 *   - stdin `end`/`close`         — client closed the pipe (normal disconnect)
 *   - stdin/stdout `error`        — pipe broke / client gone (EPIPE/ECONNRESET)
 *   - reparented to init (ppid 1) — the host died and orphaned us; an
 *     unref'd poll catches it without keeping the event loop alive
 *
 * Mitigation, not cure: it can't stop a host from spawning a duplicate,
 * nor force-exit an idle instance whose pipes the host still holds open —
 * those are host-side. But a genuinely *disconnected* instance now exits
 * promptly instead of lingering.
 */
function exitOnDisconnect(): void {
  let exiting = false;
  const die = (): void => {
    if (exiting) return;
    exiting = true;
    process.exit(0);
  };
  process.stdin.on("end", die);
  process.stdin.on("close", die);
  process.stdin.on("error", die);
  // EPIPE when the client stops reading our stdout.
  process.stdout.on("error", die);
  // Parent-death watchdog. `unref` so it never keeps the process alive on
  // its own — it only fires while stdin still holds the loop open.
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) die();
  }, 30_000);
  orphanCheck.unref?.();
}

try {
  await server.connect(transport);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[capsulemcp] Failed to start: ${message}`);
  process.exit(1);
}

// Connected. Arm disconnect-exit so an abandoned instance can't linger
// as a zombie after the host drops the pipe.
exitOnDisconnect();
