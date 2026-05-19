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
 *                         across instances)
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects)
 *   CAPSULE_MCP_READONLY  Same semantics as the stdio server
 *   MCP_HTTP_JSON_LIMIT   Body size cap for inbound JSON (default 35mb;
 *                         needs to fit a 25MB attachment base64-encoded
 *                         in the upload_attachment tool call. Express
 *                         accepts shorthand like '50mb' or raw bytes.)
 *   MCP_HTTP_TRUST_PROXY  Number of proxy hops to trust (default 1).
 *                         See src/http/config.ts for the decision tree.
 *   CAPSULE_MCP_CACHE_DISABLED  Set to 1 / true / yes / on to disable
 *                               the per-instance reference-data cache.
 *                               Default unset (cache enabled).
 *   CAPSULE_MCP_CACHE_TTL_MS    TTL for the per-instance reference-data
 *                               cache (default 300000 = 5 min). Only
 *                               consulted when caching is enabled. See
 *                               src/capsule/cache.ts for the list of
 *                               cached endpoints and DESIGN.md L13.
 *   CAPSULE_MCP_LOG_VERBOSE     Set to 1 / true / yes / on to emit
 *                               single-line JSON events to stderr for
 *                               cache hit / miss / invalidate / evict.
 *                               Cloud Run auto-parses these into
 *                               jsonPayload fields for queryable logs.
 *                               Off by default — flip on briefly to
 *                               measure cache effectiveness / detailed
 *                               batch failure reasons, then off.
 *                               batch.complete summaries emit
 *                               regardless.
 *                               See OPTIMIZATIONS.md and src/log.ts.
 *   CAPSULE_MCP_BATCH_CONCURRENCY  Max parallel HTTP requests when a
 *                                  batch_* tool fans out (default 5;
 *                                  clamped to [1, 50]). See
 *                                  src/capsule/batch.ts.
 */

import { isReadOnly } from "./capsule/client.js";
import { OAuthProvider, InMemoryClientsStore, FixedClientStore } from "./auth/provider.js";
import { resolveBaseConfig, selectMode } from "./http/config.js";
import { createApp } from "./http/app.js";

// ── Module top-level: wire the pure config helpers into a running server ────

function fatal(message: string): never {
  console.error(`[capsulemcp] FATAL: ${message}`);
  process.exit(1);
}

const baseResult = resolveBaseConfig();
if ("error" in baseResult) fatal(baseResult.error);
const { publicBaseUrl, signingKey, port, jsonLimit, trustProxy } = baseResult.ok;

// Pass publicBaseUrl so selectMode can refuse insecure-auto-approve mode
// for non-loopback hostnames (defence-in-depth for misconfigured public
// deployments).
const modeResult = selectMode(process.env, publicBaseUrl);
if ("error" in modeResult) fatal(modeResult.error);
const mode = modeResult.ok;

const issuerUrl = new URL(publicBaseUrl);
const mcpResourceUrl = new URL("/mcp", issuerUrl);

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
        resourceUrl: mcpResourceUrl,
      })
    : new OAuthProvider({
        clientsStore: new InMemoryClientsStore(),
        signingKey,
        resourceUrl: mcpResourceUrl,
      });

// ── Build app and start ─────────────────────────────────────────────────────

const app = createApp({
  oauthProvider,
  issuerUrl,
  jsonLimit,
  allowedOrigins: baseResult.ok.allowedOrigins,
  trustProxy,
});

app.listen(port, () => {
  const readMode = isReadOnly() ? "read-only" : "read-write";
  const authLabel = mode.kind === "static-client" ? "static-client" : "INSECURE_AUTO_APPROVE";
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
