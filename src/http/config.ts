/**
 * Pure config / mode-selection helpers for the HTTP entry. Kept in a
 * separate module so tests can import them without triggering the
 * top-level server-startup code in `src/http.ts`.
 */

// Anthropic's known Custom Connector callback URIs. Used as the default
// redirect_uris allow-list in static-client mode when the env var is not
// set. Update as Anthropic publishes new ones.
export const DEFAULT_ANTHROPIC_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.ai/api/oauth/callback",
  "https://claude.ai/oauth/callback",
];

// ── Mode selection ──────────────────────────────────────────────────────────

export type Mode =
  | { kind: "static-client"; clientId: string; clientSecret: string; redirectUris: string[] }
  | { kind: "insecure-auto-approve" };

export type SelectModeResult = { ok: Mode } | { error: string };

/**
 * Decide which OAuth mode to run in based on env. Pure — never throws,
 * never exits the process. The HTTP entry wraps this with fatal() on
 * error.
 */
export function selectMode(env: NodeJS.ProcessEnv = process.env): SelectModeResult {
  const CLIENT_ID = env["MCP_OAUTH_CLIENT_ID"];
  const CLIENT_SECRET = env["MCP_OAUTH_CLIENT_SECRET"];
  const REDIRECT_URIS_ENV = env["MCP_OAUTH_REDIRECT_URIS"];
  const insecureAutoApprove =
    env["MCP_OAUTH_INSECURE_AUTO_APPROVE"] === "1" ||
    env["MCP_OAUTH_INSECURE_AUTO_APPROVE"]?.toLowerCase() === "true";

  if (CLIENT_ID && CLIENT_SECRET) {
    const redirectUris = REDIRECT_URIS_ENV
      ? REDIRECT_URIS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ANTHROPIC_REDIRECT_URIS;
    if (!redirectUris.length) {
      return {
        error: "MCP_OAUTH_REDIRECT_URIS was set but contained no usable URIs",
      };
    }
    return {
      ok: {
        kind: "static-client",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUris,
      },
    };
  }
  if (CLIENT_ID || CLIENT_SECRET) {
    return {
      error:
        "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must both be set to enable static-client mode (got only one).",
    };
  }
  if (insecureAutoApprove) {
    return { ok: { kind: "insecure-auto-approve" } };
  }
  return {
    error:
      "No OAuth mode configured. Either:\n" +
      "  - Set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET (recommended for public deployments)\n" +
      "  - Or set MCP_OAUTH_INSECURE_AUTO_APPROVE=1 (only safe for local development or private-network deployments)",
  };
}

// ── Base-config validation ──────────────────────────────────────────────────

export interface BaseConfig {
  publicBaseUrl: string;
  signingKey: string;
  port: number;
  jsonLimit: string;
}

export type BaseConfigResult = { ok: BaseConfig } | { error: string };

/**
 * Validate the env vars required regardless of OAuth mode.
 *
 * - PUBLIC_BASE_URL: required.
 * - MCP_OAUTH_SIGNING_KEY (or its v0.1.0-era alias MCP_SHARED_SECRET):
 *   required, ≥16 chars.
 * - PORT: optional, defaults to 8080 (Cloud Run injects).
 * - MCP_HTTP_JSON_LIMIT: optional, defaults to '35mb' (fits a 25MB
 *   attachment base64-encoded in upload_attachment).
 */
export function resolveBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfigResult {
  const publicBaseUrl = env["PUBLIC_BASE_URL"];
  if (!publicBaseUrl) {
    return {
      error:
        "PUBLIC_BASE_URL is not set. It must be the public origin of this server (e.g. https://example.run.app), used to build OAuth metadata and authorization redirect URLs.",
    };
  }
  const signingKey = env["MCP_OAUTH_SIGNING_KEY"] ?? env["MCP_SHARED_SECRET"];
  if (!signingKey || signingKey.length < 16) {
    return {
      error:
        "MCP_OAUTH_SIGNING_KEY (or MCP_SHARED_SECRET) must be set and at least 16 chars long. It is the HMAC key used to sign OAuth access tokens; rotating it invalidates all outstanding tokens.",
    };
  }
  const port = parseInt(env["PORT"] ?? "8080", 10);
  const jsonLimit = env["MCP_HTTP_JSON_LIMIT"] ?? "35mb";
  return { ok: { publicBaseUrl, signingKey, port, jsonLimit } };
}
