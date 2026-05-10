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

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthProvider } from "../auth/provider.js";
import { createCapsuleMcpServer } from "../server.js";
import { ICON_SVG } from "../icon.js";

export interface AppOptions {
  oauthProvider: OAuthProvider;
  issuerUrl: URL;
  jsonLimit: string;
  resourceName?: string;
}

export function createApp(opts: AppOptions): express.Express {
  const { oauthProvider, issuerUrl, jsonLimit } = opts;
  const resourceName = opts.resourceName ?? "Capsule CRM MCP";

  const app = express();
  app.use(express.json({ limit: jsonLimit }));

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: [],
      resourceName,
    }),
  );

  // ── Icon (cosmetic) ──────────────────────────────────────────────────────
  // Some connector UIs prefer fetching an icon over a URL rather than reading
  // it from the MCP serverInfo payload. Serve our SVG at both /icon.svg and
  // /favicon.ico (browsers default-fetch the latter). 24h cache — the icon
  // rotates approximately never.
  const iconHandler = (
    _req: express.Request,
    res: express.Response,
  ): void => {
    res
      .set("Content-Type", "image/svg+xml")
      .set("Cache-Control", "public, max-age=86400")
      .send(ICON_SVG);
  };
  app.get("/icon.svg", iconHandler);
  app.get("/favicon.ico", iconHandler);

  // ── MCP endpoint (gated by Bearer token from the OAuth provider) ─────────
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

  app.get(
    "/mcp",
    requireBearerAuth({ verifier: oauthProvider }),
    (_req, res) => {
      res.status(405).json({
        error: "method_not_allowed",
        message:
          "Use POST for MCP requests; this server runs in stateless mode.",
      });
    },
  );
  app.delete(
    "/mcp",
    requireBearerAuth({ verifier: oauthProvider }),
    (_req, res) => {
      res.status(405).json({
        error: "method_not_allowed",
        message:
          "Use POST for MCP requests; this server runs in stateless mode.",
      });
    },
  );

  return app;
}
