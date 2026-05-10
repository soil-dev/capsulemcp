/**
 * HTTP entry — for remote-connector deployments (Cloud Run, etc.).
 *
 * Runs the same MCP server the stdio entry does, but exposes it on HTTP
 * via StreamableHTTPServerTransport so Claude.ai's Custom Connector
 * feature can reach it.
 *
 * Two OAuth modes are supported, selected by env-var presence:
 *
 *   - static-client (default, recommended for any public deployment):
 *     One hard-coded client; DCR disabled; the client_secret is the real
 *     auth boundary.
 *     Required env: MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET.
 *     Optional: MCP_OAUTH_REDIRECT_URIS (comma-separated; defaults to
 *     Anthropic's known callback URIs).
 *
 *   - insecure-auto-approve (opt-in, for local / private-network use):
 *     Open DCR + auto-approve. Anyone who can reach the URL gets in.
 *     Required env: MCP_OAUTH_INSECURE_AUTO_APPROVE=1.
 *
 * If neither is configured, the server refuses to start with a clear
 * error message — the secure mode is the path of least resistance.
 *
 * Required env in all modes:
 *   CAPSULE_API_TOKEN     Capsule Personal Access Token (read-scoped)
 *   PUBLIC_BASE_URL       Public origin where this server is reachable
 *   MCP_OAUTH_SIGNING_KEY HMAC key for OAuth tokens (>=16 chars; stable
 *                         across instances; falls back to MCP_SHARED_SECRET)
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects)
 *   CAPSULE_MCP_READONLY  Same semantics as the stdio server
 *   MCP_HTTP_JSON_LIMIT   Body size cap for inbound JSON (default 35mb;
 *                         needs to fit a 25MB attachment base64-encoded
 *                         in the upload_attachment tool call. Express
 *                         accepts shorthand like '50mb' or raw bytes.)
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isReadOnly } from "./capsule/client.js";
import { createCapsuleMcpServer } from "./server.js";
import {
  OAuthProvider,
  InMemoryClientsStore,
  FixedClientStore,
} from "./auth/provider.js";
import { ICON_SVG } from "./icon.js";
import { resolveBaseConfig, selectMode } from "./http/config.js";

// ── Module top-level: wire the pure config helpers into a running server ────

function fatal(message: string): never {
  console.error(`[capsulemcp] FATAL: ${message}`);
  process.exit(1);
}

const baseResult = resolveBaseConfig();
if ("error" in baseResult) fatal(baseResult.error);
const { publicBaseUrl, signingKey, port, jsonLimit } = baseResult.ok;

const modeResult = selectMode();
if ("error" in modeResult) fatal(modeResult.error);
const mode = modeResult.ok;

const issuerUrl = new URL(publicBaseUrl);

// ── Provider construction ───────────────────────────────────────────────────

const oauthProvider =
  mode.kind === "static-client"
    ? new OAuthProvider({
        clientsStore: new FixedClientStore({
          clientId: mode.clientId,
          clientSecret: mode.clientSecret,
          redirectUris: mode.redirectUris,
          clientName: "capsulemcp pre-registered client",
        }),
        signingKey,
      })
    : new OAuthProvider({
        clientsStore: new InMemoryClientsStore(),
        signingKey,
      });

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: jsonLimit }));

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: [],
    resourceName: "Capsule CRM MCP",
  }),
);

// ── Icon (cosmetic) ─────────────────────────────────────────────────────────
//
// Some connector UIs prefer fetching an icon over a URL rather than reading
// it from the MCP serverInfo payload. Serve our SVG at both /icon.svg and
// /favicon.ico (browsers default-fetch the latter). 24h cache — the icon
// rotates approximately never.

const iconHandler = (_req: express.Request, res: express.Response): void => {
  res
    .set("Content-Type", "image/svg+xml")
    .set("Cache-Control", "public, max-age=86400")
    .send(ICON_SVG);
};
app.get("/icon.svg", iconHandler);
app.get("/favicon.ico", iconHandler);

// ── MCP endpoint (gated by Bearer token from the OAuth provider) ────────────

app.post(
  "/mcp",
  requireBearerAuth({ verifier: oauthProvider }),
  async (req, res) => {
    try {
      const server = createCapsuleMcpServer();
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

app.listen(port, () => {
  const readMode = isReadOnly() ? "read-only" : "read-write";
  const authLabel =
    mode.kind === "static-client" ? "static-client" : "INSECURE_AUTO_APPROVE";
  console.log(
    `[capsulemcp] HTTP server listening on :${port} | mode=${readMode} | auth=${authLabel} | issuer=${issuerUrl}`,
  );
  if (mode.kind === "insecure-auto-approve") {
    console.warn(
      "[capsulemcp] WARNING: auth mode is INSECURE_AUTO_APPROVE. " +
        "Anyone who can reach this URL can register a client and use the configured Capsule token. " +
        "Suitable only for local development or private-network deployments. " +
        "For public deployments, set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET.",
    );
  }
});
