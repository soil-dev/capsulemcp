/**
 * Express app factory for the HTTP transport. Pure — takes a fully
 * constructed OAuth provider and config, returns an `express.Express`
 * instance. Doesn't call `app.listen()` itself; the caller decides
 * when to start serving (or not, in tests).
 *
 * Lives in its own module so tests can import it without triggering
 * the side effects in `src/http.ts` (env validation, process.exit on
 * missing config, app.listen).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthProvider } from "../auth/provider.js";
import { createCapsuleMcpServer } from "../server.js";
import { ICON_SVG } from "../icon.js";

export interface AppOptions {
  oauthProvider: OAuthProvider;
  issuerUrl: URL;
  jsonLimit: string;
  allowedOrigins: string[];
  resourceName?: string;
  /**
   * Express `trust proxy` setting. Required when running behind a
   * reverse proxy that injects `X-Forwarded-For` (e.g. Cloud Run, an
   * nginx ingress). The MCP SDK's auth router applies
   * `express-rate-limit` to /authorize, /token, and /register; with
   * the default `trust proxy=false`, express-rate-limit treats the
   * presence of `X-Forwarded-For` as a misconfiguration and may
   * refuse the request.
   *
   * Defaults to `1` (trust the immediately-upstream proxy), which is
   * correct for Cloud Run and most single-hop ingress setups. Set to
   * `false` to disable, or to a higher integer if there are multiple
   * proxy hops in front of the server.
   */
  trustProxy?: boolean | number | string;
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function timingSafeSecretEqual(provided: string, expected: string): boolean {
  // Compare fixed-width digests so the equality check doesn't branch on
  // the raw client_secret length before timingSafeEqual runs.
  return timingSafeEqual(secretDigest(provided), secretDigest(expected));
}

export function createApp(opts: AppOptions): express.Express {
  const { oauthProvider, issuerUrl, jsonLimit, allowedOrigins } = opts;
  const resourceName = opts.resourceName ?? "Capsule CRM MCP";
  const trustProxy = opts.trustProxy ?? 1;

  // The MCP server lives at /mcp under the issuer. Advertise its
  // path-specific protected-resource metadata at
  // /.well-known/oauth-protected-resource/mcp, and include the
  // metadata URL in WWW-Authenticate on /mcp's 401s so generic
  // OAuth/MCP clients can discover it without baked-in knowledge.
  const mcpResourceUrl = new URL("/mcp", issuerUrl);
  const mcpResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);

  const app = express();
  // MUST be set before mcpAuthRouter so the rate-limit middleware
  // inside the SDK's auth router sees the configured trust setting.
  app.set("trust proxy", trustProxy);

  // Constant-time client_secret pre-check on /token. Mounted BEFORE
  // mcpAuthRouter so we authenticate the client first; the SDK's own
  // client-auth (which uses native `!==` and is therefore not
  // constant-time) then runs on a known-valid secret, closing the
  // timing channel for invalid-secret attackers.
  //
  // For secret-bearing clients, reads client_secret_post only (form body).
  // The SDK's downstream auth doesn't support client_secret_basic, so
  // supporting it here would create a half-working path. The
  // FixedClientStore default of `token_endpoint_auth_method:
  // "client_secret_post"` is what static-client callers actually use.
  //
  // Wrapped as URL-encoded middleware because mcpAuthRouter installs
  // its own body parser internally; we need access to req.body here,
  // so we duplicate the small parse. Both parses are idempotent.
  app.post("/token", express.urlencoded({ extended: false }), async (req, res, next) => {
    const sendInvalidClient = (description: string): void => {
      res.status(401).json({
        error: "invalid_client",
        error_description: description,
      });
    };

    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId =
      typeof body["client_id"] === "string" ? (body["client_id"] as string) : undefined;
    const providedSecret =
      typeof body["client_secret"] === "string" ? (body["client_secret"] as string) : undefined;

    if (!clientId) {
      sendInvalidClient("client credentials required");
      return;
    }

    let expected: Awaited<ReturnType<typeof oauthProvider.clientsStore.getClient>>;
    try {
      expected = await oauthProvider.clientsStore.getClient(clientId);
    } catch {
      res.status(500).json({
        error: "server_error",
        error_description: "client lookup failed",
      });
      return;
    }

    // Always run a fixed-width digest comparison before branching on
    // whether the client exists. Otherwise an attacker could distinguish
    // "unknown clientId" from "known clientId, wrong secret" by timing.
    const expectedSecret =
      expected && typeof expected.client_secret === "string" && expected.client_secret
        ? expected.client_secret
        : "";
    const secretsMatch = timingSafeSecretEqual(providedSecret ?? "", expectedSecret);
    if (!expected) {
      sendInvalidClient("client authentication failed");
      return;
    }

    // Public DCR clients (`token_endpoint_auth_method: "none"`) have no
    // client_secret. Let the SDK's downstream auth middleware handle that
    // standards path; the pre-check only replaces secret-bearing compares.
    if (!expectedSecret) {
      next();
      return;
    }

    const expiresAt = expected.client_secret_expires_at;
    const secretExpired =
      typeof expiresAt === "number" && expiresAt !== 0 && expiresAt < Math.floor(Date.now() / 1000);
    if (providedSecret === undefined || !secretsMatch || secretExpired) {
      sendInvalidClient("client authentication failed");
      return;
    }
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: [],
      resourceName,
      resourceServerUrl: mcpResourceUrl,
    }),
  );

  // ── Icon (cosmetic) ──────────────────────────────────────────────────────
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

  // ── MCP endpoint (gated by Bearer token from the OAuth provider) ─────────
  const guardOrigin: express.RequestHandler = (req, res, next) => {
    const origin = req.get("Origin");
    if (!origin) {
      next();
      return;
    }
    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      });
      return;
    }
    if (!allowedOrigins.includes(normalizedOrigin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin is not allowed" },
        id: null,
      });
      return;
    }
    next();
  };

  // Per-client rate limit on /mcp. Keyed by the authenticated clientId
  // (set by requireBearerAuth onto req.auth) so one abusive caller can't
  // exhaust the shared Capsule API quota for everyone else on the same
  // deployment. The window/ceiling here are intentionally generous —
  // enough that a normal Claude session won't ever notice, low enough
  // that a runaway loop trips before the upstream 4000-rph cap.
  // Operators on heavy-tenant deployments can override via env. Tests
  // disable it via MCP_HTTP_RATE_LIMIT_DISABLED.
  const rateLimitWindowMs = Number(process.env["MCP_HTTP_RATE_LIMIT_WINDOW_MS"]) || 60_000;
  const rateLimitMax = Number(process.env["MCP_HTTP_RATE_LIMIT_MAX"]) || 600;
  const rateLimitDisabled = process.env["MCP_HTTP_RATE_LIMIT_DISABLED"] === "1";
  const mcpRateLimit = rateLimit({
    windowMs: rateLimitWindowMs,
    limit: rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const clientId = (req as { auth?: { clientId?: string } }).auth?.clientId;
      // Fallback to IP for unauthenticated paths (shouldn't reach here
      // post-requireBearerAuth, but defensive). express-rate-limit's
      // default IP key generator goes through `req.ip`, which respects
      // the `trust proxy` setting we already configure.
      return clientId ?? req.ip ?? "unknown";
    },
    skip: () => rateLimitDisabled,
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too Many Requests" },
        id: null,
      });
    },
  });

  const guardProtocolVersion: express.RequestHandler = (req, res, next) => {
    const protocolVersion = req.get("MCP-Protocol-Version");
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version: ${protocolVersion}`,
        },
        id: null,
      });
      return;
    }
    next();
  };

  app.post(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    express.json({ limit: jsonLimit }),
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
        // Log a low-cardinality summary to stderr (operator-visible) but
        // return only a generic shape to the caller. The full err.message
        // can include Capsule response bodies (party names, validation
        // strings, ...) which is operator-visible PII we don't want
        // smearing across log aggregators by default. Set
        // MCP_HTTP_DEBUG=1 to opt in to the verbose form on this path.
        const name = err instanceof Error ? err.name : typeof err;
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: number }).status)
            : undefined;
        const summary = status !== undefined ? `${name} ${status}` : name;
        if (process.env["MCP_HTTP_DEBUG"] === "1") {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[capsulemcp] /mcp error: ${summary} — ${message}`);
        } else {
          console.error(`[capsulemcp] /mcp error: ${summary}`);
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error" });
        }
      }
    },
  );

  app.get(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    (_req, res) => {
      res.set("Allow", "POST").status(405).json({
        error: "method_not_allowed",
        message: "Use POST for MCP requests; this server runs in stateless mode.",
      });
    },
  );
  app.delete(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    (_req, res) => {
      res.set("Allow", "POST").status(405).json({
        error: "method_not_allowed",
        message: "Use POST for MCP requests; this server runs in stateless mode.",
      });
    },
  );

  return app;
}
