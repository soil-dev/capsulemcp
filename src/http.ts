/**
 * HTTP entry — for remote-connector deployments (Cloud Run, etc.).
 *
 * Runs the same MCP server the stdio entry does, but exposes it on
 * HTTP via StreamableHTTPServerTransport so Claude.ai's Custom
 * Connector feature can reach it. Designed for stateless
 * single-container deployments: each /mcp request constructs a fresh
 * server + transport pair.
 *
 * Required env:
 *   CAPSULE_API_TOKEN     Capsule Personal Access Token (read-scoped recommended)
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects this)
 *   MCP_SHARED_SECRET     If set, every request must include
 *                         `Authorization: Bearer <secret>` or it's rejected.
 *                         Strongly recommended for any public deployment.
 *   CAPSULE_MCP_READONLY  Same semantics as the stdio server.
 */

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isReadOnly } from "./capsule/client.js";
import { createCapsuleMcpServer } from "./server.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const SHARED_SECRET = process.env["MCP_SHARED_SECRET"];

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── Auth middleware ─────────────────────────────────────────────────────────

function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  if (!SHARED_SECRET) {
    // Auth not configured — let the request through. Fine for private
    // VPC deployments; anything reachable from the internet should set
    // MCP_SHARED_SECRET.
    next();
    return;
  }
  const auth = req.header("authorization");
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// ── Health check (unauthenticated) ──────────────────────────────────────────

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, readOnly: isReadOnly() });
});

// ── MCP endpoint ────────────────────────────────────────────────────────────

app.post("/mcp", requireSharedSecret, async (req, res) => {
  try {
    const server = createCapsuleMcpServer();
    // Stateless: one transport per request. Cloud Run instances are
    // ephemeral and traffic can land on any of them, so we don't try to
    // track sessions across requests. Omitting sessionIdGenerator is
    // the SDK's documented stateless trigger.
    const transport = new StreamableHTTPServerTransport({});

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[capsulemcp] /mcp error: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message });
    }
  }
});

// Stateless mode doesn't expose a server-pushed event stream, so reject
// GET/DELETE on /mcp with a clear message rather than letting express
// 404 them.
app.get("/mcp", requireSharedSecret, (_req, res) => {
  res.status(405).json({ error: "method_not_allowed", message: "Use POST for MCP requests; this server runs in stateless mode." });
});
app.delete("/mcp", requireSharedSecret, (_req, res) => {
  res.status(405).json({ error: "method_not_allowed", message: "Use POST for MCP requests; this server runs in stateless mode." });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const mode = isReadOnly() ? "read-only" : "read-write";
  const auth = SHARED_SECRET ? "shared-secret required" : "OPEN (no auth)";
  console.log(`[capsulemcp] HTTP server listening on :${PORT} | mode=${mode} | auth=${auth}`);
  if (!SHARED_SECRET) {
    console.warn(
      "[capsulemcp] WARNING: MCP_SHARED_SECRET is unset. " +
        "Anyone who can reach this endpoint can use the configured Capsule token. " +
        "Set MCP_SHARED_SECRET unless this server is on a private network.",
    );
  }
});
