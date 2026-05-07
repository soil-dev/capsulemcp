/**
 * HTTP entry — for remote-connector deployments (Cloud Run, etc.).
 *
 * Runs the same MCP server the stdio entry does, but exposes it on HTTP
 * via StreamableHTTPServerTransport so Claude.ai's Custom Connector
 * feature can reach it. Designed for stateless single-container
 * deployments: each /mcp request constructs a fresh server + transport
 * pair.
 *
 * Authentication is OAuth 2.1 with Dynamic Client Registration (RFC
 * 7591), as required by Anthropic's Custom Connector machinery. The
 * MCP SDK's mcpAuthRouter installs the standard /authorize, /token,
 * /register, and /.well-known/* endpoints. Our AutoApproveOAuthProvider
 * issues HMAC-signed access tokens — a Claude user goes through the
 * silent OAuth dance, gets a token, and the token then gates /mcp via
 * requireBearerAuth.
 *
 * Required env:
 *   CAPSULE_API_TOKEN     Capsule Personal Access Token (read-scoped recommended)
 *   PUBLIC_BASE_URL       Public origin where this server is reachable,
 *                         e.g. https://capsulemcp-production-...run.app.
 *                         Used to build OAuth metadata URLs.
 *   MCP_OAUTH_SIGNING_KEY HMAC signing key for OAuth tokens. Must be a
 *                         stable secret >= 16 chars long. Treat like a
 *                         private key. Falls back to MCP_SHARED_SECRET
 *                         for backwards compat with v0.1.0 deployments.
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects this)
 *   CAPSULE_MCP_READONLY  Same semantics as the stdio server.
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isReadOnly } from "./capsule/client.js";
import { createCapsuleMcpServer } from "./server.js";
import { AutoApproveOAuthProvider } from "./auth/provider.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];
const SIGNING_KEY =
  process.env["MCP_OAUTH_SIGNING_KEY"] ?? process.env["MCP_SHARED_SECRET"];

if (!PUBLIC_BASE_URL) {
  console.error(
    "[capsulemcp] FATAL: PUBLIC_BASE_URL is not set. " +
      "It must be the public origin of this server (e.g. https://example.run.app), " +
      "used to build OAuth metadata and authorization redirect URLs.",
  );
  process.exit(1);
}
if (!SIGNING_KEY || SIGNING_KEY.length < 16) {
  console.error(
    "[capsulemcp] FATAL: MCP_OAUTH_SIGNING_KEY (or MCP_SHARED_SECRET) " +
      "must be set and at least 16 chars long. It is the HMAC key used to " +
      "sign OAuth access tokens; rotating it invalidates all outstanding tokens.",
  );
  process.exit(1);
}

const issuerUrl = new URL(PUBLIC_BASE_URL);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── OAuth provider + router ─────────────────────────────────────────────────

const oauthProvider = new AutoApproveOAuthProvider(SIGNING_KEY);

// Installs /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /register
// at the application root. Per the SDK, this MUST be at the root.
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: [],
    resourceName: "Capsule CRM MCP",
  }),
);

// ── MCP endpoint (gated by Bearer token from the OAuth provider) ────────────

app.post(
  "/mcp",
  requireBearerAuth({ verifier: oauthProvider }),
  async (req, res) => {
    try {
      const server = createCapsuleMcpServer();
      // Stateless: one transport per request. Cloud Run instances are
      // ephemeral and traffic can land on any of them, so we don't try
      // to track sessions across requests. Omitting sessionIdGenerator
      // is the SDK's documented stateless trigger.
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
  },
);

// Stateless mode doesn't expose a server-pushed event stream. Reject
// GET/DELETE on /mcp with a clear message rather than 404.
app.get("/mcp", requireBearerAuth({ verifier: oauthProvider }), (_req, res) => {
  res.status(405).json({
    error: "method_not_allowed",
    message: "Use POST for MCP requests; this server runs in stateless mode.",
  });
});
app.delete("/mcp", requireBearerAuth({ verifier: oauthProvider }), (_req, res) => {
  res.status(405).json({
    error: "method_not_allowed",
    message: "Use POST for MCP requests; this server runs in stateless mode.",
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const mode = isReadOnly() ? "read-only" : "read-write";
  console.log(
    `[capsulemcp] HTTP server listening on :${PORT} | mode=${mode} | auth=OAuth | issuer=${issuerUrl}`,
  );
});
