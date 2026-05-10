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
    // Reject malformed URIs early — Express OAuth handlers would
    // otherwise crash deep in the SDK at request time with an
    // unhelpful trace.
    const bad = redirectUris.find((u) => !URL.canParse(u));
    if (bad) {
      return {
        error: `MCP_OAUTH_REDIRECT_URIS contains a malformed URL: ${bad}`,
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
 * - MCP_OAUTH_SIGNING_KEY: required, ≥16 chars.
 * - PORT: optional, default 8080.
 * - MCP_HTTP_JSON_LIMIT: optional, default '35mb' (fits a 25MB
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
  // Validate URL syntax up front. Without this check, the URL
  // constructor in src/http.ts throws an unhelpful TypeError at
  // startup; with it, the operator sees a clear config error.
  if (!URL.canParse(publicBaseUrl)) {
    return {
      error: `PUBLIC_BASE_URL is not a valid URL: ${publicBaseUrl}`,
    };
  }
  const parsedBaseUrl = new URL(publicBaseUrl);
  // Require https in production. Allow http only for localhost /
  // 127.0.0.1 / ::1 so local development still works. OAuth over
  // plaintext on a public URL is a security mistake worth blocking
  // at startup rather than catching in code review.
  const isLocal =
    parsedBaseUrl.hostname === "localhost" ||
    parsedBaseUrl.hostname === "127.0.0.1" ||
    parsedBaseUrl.hostname === "[::1]" ||
    parsedBaseUrl.hostname === "::1";
  // Allowed combinations:
  //   - https:// anywhere
  //   - http://  only for localhost / 127.0.0.1 / ::1
  // Anything else (ftp://, ws://, schemeless 'localhost:3000' which
  // URL.canParse accepts as protocol="localhost:", etc.) is rejected.
  const isHttps = parsedBaseUrl.protocol === "https:";
  const isHttpLocal = parsedBaseUrl.protocol === "http:" && isLocal;
  if (!isHttps && !isHttpLocal) {
    return {
      error: `PUBLIC_BASE_URL must be https://… (or http://localhost for development); got ${parsedBaseUrl.protocol}//${parsedBaseUrl.hostname}.`,
    };
  }

  const signingKey = env["MCP_OAUTH_SIGNING_KEY"];
  if (!signingKey || signingKey.length < 16) {
    return {
      error:
        "MCP_OAUTH_SIGNING_KEY must be set and at least 16 chars long. It is the HMAC key used to sign OAuth access tokens; rotating it invalidates all outstanding tokens.",
    };
  }

  const portRaw = env["PORT"] ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      error: `PORT must be an integer in 1..65535 (got ${JSON.stringify(portRaw)}).`,
    };
  }

  const jsonLimit = env["MCP_HTTP_JSON_LIMIT"] ?? "35mb";
  return { ok: { publicBaseUrl, signingKey, port, jsonLimit } };
}
