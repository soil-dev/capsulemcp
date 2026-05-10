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

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];
const SIGNING_KEY =
  process.env["MCP_OAUTH_SIGNING_KEY"] ?? process.env["MCP_SHARED_SECRET"];

const CLIENT_ID = process.env["MCP_OAUTH_CLIENT_ID"];
const CLIENT_SECRET = process.env["MCP_OAUTH_CLIENT_SECRET"];
const REDIRECT_URIS_ENV = process.env["MCP_OAUTH_REDIRECT_URIS"];
const INSECURE_AUTO_APPROVE =
  process.env["MCP_OAUTH_INSECURE_AUTO_APPROVE"] === "1" ||
  process.env["MCP_OAUTH_INSECURE_AUTO_APPROVE"]?.toLowerCase() === "true";

// Anthropic's known Custom Connector callback URIs. Used as the default
// redirect_uris allow-list in static-client mode when the env var is not
// set. Update as Anthropic publishes new ones.
const DEFAULT_ANTHROPIC_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.ai/api/oauth/callback",
  "https://claude.ai/oauth/callback",
];

function fatal(message: string): never {
  console.error(`[capsulemcp] FATAL: ${message}`);
  process.exit(1);
}

if (!PUBLIC_BASE_URL) {
  fatal(
    "PUBLIC_BASE_URL is not set. It must be the public origin of this server (e.g. https://example.run.app), used to build OAuth metadata and authorization redirect URLs.",
  );
}
if (!SIGNING_KEY || SIGNING_KEY.length < 16) {
  fatal(
    "MCP_OAUTH_SIGNING_KEY (or MCP_SHARED_SECRET) must be set and at least 16 chars long. It is the HMAC key used to sign OAuth access tokens; rotating it invalidates all outstanding tokens.",
  );
}

// ── Mode selection ──────────────────────────────────────────────────────────

type Mode =
  | { kind: "static-client"; clientId: string; clientSecret: string; redirectUris: string[] }
  | { kind: "insecure-auto-approve" };

function selectMode(): Mode {
  if (CLIENT_ID && CLIENT_SECRET) {
    const redirectUris = REDIRECT_URIS_ENV
      ? REDIRECT_URIS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ANTHROPIC_REDIRECT_URIS;
    if (!redirectUris.length) {
      fatal("MCP_OAUTH_REDIRECT_URIS was set but contained no usable URIs");
    }
    return {
      kind: "static-client",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris,
    };
  }
  if (CLIENT_ID || CLIENT_SECRET) {
    fatal(
      "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must both be set to enable static-client mode (got only one).",
    );
  }
  if (INSECURE_AUTO_APPROVE) {
    return { kind: "insecure-auto-approve" };
  }
  fatal(
    "No OAuth mode configured. Either:\n" +
      "  - Set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET (recommended for public deployments)\n" +
      "  - Or set MCP_OAUTH_INSECURE_AUTO_APPROVE=1 (only safe for local development or private-network deployments)",
  );
}

const mode = selectMode();
const issuerUrl = new URL(PUBLIC_BASE_URL);

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
        signingKey: SIGNING_KEY,
      })
    : new OAuthProvider({
        clientsStore: new InMemoryClientsStore(),
        signingKey: SIGNING_KEY,
      });

// ── Express app ─────────────────────────────────────────────────────────────

// Inbound JSON body limit. Default 35MB so a 25MB attachment fits with
// base64 expansion (25MB × 4/3 ≈ 33.3MB) plus surrounding JSON. Without
// this, upload_attachment fails with PayloadTooLargeError on anything
// non-trivial. Override via MCP_HTTP_JSON_LIMIT if your deployment
// needs to support larger files.
const JSON_LIMIT = process.env["MCP_HTTP_JSON_LIMIT"] ?? "35mb";

const app = express();
app.use(express.json({ limit: JSON_LIMIT }));

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

app.listen(PORT, () => {
  const readMode = isReadOnly() ? "read-only" : "read-write";
  const authLabel =
    mode.kind === "static-client" ? "static-client" : "INSECURE_AUTO_APPROVE";
  console.log(
    `[capsulemcp] HTTP server listening on :${PORT} | mode=${readMode} | auth=${authLabel} | issuer=${issuerUrl}`,
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
