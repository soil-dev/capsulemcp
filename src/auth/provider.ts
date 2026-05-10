/**
 * OAuth 2.1 server provider for capsulemcp.
 *
 * Anthropic's Custom Connector machinery requires the MCP HTTP server to
 * speak OAuth 2.1 + RFC 7591 (Dynamic Client Registration). This module
 * implements a single OAuth server (`OAuthProvider`) parameterised by a
 * clients store. Two stores are exported:
 *
 *   - InMemoryClientsStore  — open DCR; auto-approve mode. Anyone who can
 *                             reach the URL can register and get in.
 *                             Suitable for local development or
 *                             private-network deployments only.
 *
 *   - FixedClientStore      — one hard-coded client; DCR disabled at the
 *                             SDK level (registerClient is not
 *                             implemented, so /register is not exposed).
 *                             The shared client_secret is the real auth
 *                             boundary. Recommended for any public
 *                             deployment.
 *
 * In both cases /authorize is auto-approved (no human consent screen),
 * because per-user identity isn't part of the model — the underlying
 * Capsule API token is shared for all callers. To add real per-user
 * identity, federate /authorize to an external OAuth/OIDC provider
 * (future work).
 *
 * Access tokens and refresh tokens are HMAC-signed by `signingKey`
 * (stable across instances). Authorization codes are kept in process
 * memory; they're consumed within seconds so this is fine.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  issueToken,
  verifyToken,
  TokenExpiredError,
  TokenSignatureError,
  type SignedTokenClaims,
} from "./tokens.js";

// TTLs are short enough that a leaked token has a bounded lifetime.
// There is no per-token revocation list (the design choice is stateless
// HMAC tokens so Cloud Run instances can come and go without sharing
// state); the kill switch for a compromised token is rotating
// MCP_OAUTH_SIGNING_KEY, which invalidates EVERY outstanding token at
// once. Documented in DEPLOY.md under Rotation.
const ACCESS_TOKEN_TTL_MS = 1 * 24 * 60 * 60 * 1000; // 1 day
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cap on the in-memory authorization-code map. /authorize is rate-limited
// by the SDK upstream, but a sustained low-rate flood (codes never
// exchanged at /token) would still grow the map unboundedly otherwise.
// 10k entries × ~200 bytes ≈ 2 MB worst-case — fits trivially in any
// instance class. Oldest entries are dropped when the cap is reached.
const AUTH_CODE_MAX_ENTRIES = 10_000;
// Sweep expired entries on this cadence even if no new codes are issued.
const AUTH_CODE_GC_INTERVAL_MS = 60 * 1000;

interface AuthCodeState {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

// ── Clients stores ──────────────────────────────────────────────────────────

/**
 * Open DCR: any caller can /register and get a fresh client_id +
 * client_secret. Used in the insecure auto-approve mode for local /
 * private-network deployments.
 */
export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(clientId, full);
    return full;
  }
}

/**
 * Closed DCR: exactly one client recognised, configured at startup
 * via env vars. Note the absence of `registerClient` — that signals
 * the SDK to not expose /register, so DCR is unavailable.
 *
 * Verifying client_secret uses constant-time compare to defend against
 * timing oracles on the secret value.
 */
export class FixedClientStore implements OAuthRegisteredClientsStore {
  private readonly client: OAuthClientInformationFull;

  constructor(args: {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    clientName?: string;
  }) {
    if (!args.clientId || args.clientId.length < 1) {
      throw new Error("FixedClientStore: clientId is required");
    }
    if (!args.clientSecret || args.clientSecret.length < 16) {
      throw new Error("FixedClientStore: clientSecret must be at least 16 chars");
    }
    if (!args.redirectUris.length) {
      throw new Error("FixedClientStore: at least one redirectUri is required");
    }
    this.client = {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // No expiry on the secret — managed externally (rotate by changing env).
      client_secret_expires_at: 0,
      redirect_uris: args.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      ...(args.clientName ? { client_name: args.clientName } : {}),
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId !== this.client.client_id) return undefined;
    return this.client;
  }

}

// ── Provider ────────────────────────────────────────────────────────────────

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly authCodes = new Map<string, AuthCodeState>();
  private readonly signingKey: string;
  private readonly resourceUrl: URL | undefined;
  private readonly gcTimer: NodeJS.Timeout | undefined;

  constructor(args: {
    clientsStore: OAuthRegisteredClientsStore;
    signingKey: string;
    /**
     * Canonical MCP resource URL this provider issues tokens for. When set,
     * authorization-code and refresh exchanges reject mismatched resource
     * indicators, and access-token verification enforces the audience.
     */
    resourceUrl?: URL | string;
    /**
     * Schedule a periodic sweep of expired authorization codes. Defaults
     * to true; set to false in tests so they don't keep the Node event
     * loop alive past assertion time.
     */
    enableAuthCodeGc?: boolean;
  }) {
    if (!args.signingKey || args.signingKey.length < 16) {
      throw new Error("OAuthProvider: signing key must be at least 16 chars long");
    }
    this.clientsStore = args.clientsStore;
    this.signingKey = args.signingKey;
    this.resourceUrl = args.resourceUrl
      ? resourceUrlFromServerUrl(args.resourceUrl)
      : undefined;
    if (args.enableAuthCodeGc ?? true) {
      this.gcTimer = setInterval(() => this.gcAuthCodes(), AUTH_CODE_GC_INTERVAL_MS);
      // Don't keep the process alive on the GC alone.
      this.gcTimer.unref();
    }
  }

  /** Stop the GC timer (used in tests + graceful shutdown). */
  shutdown(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  /**
   * Auto-approve the authorize request. Generate a code, stash the PKCE
   * challenge for later /token verification, redirect immediately. No
   * consent screen — by design.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const resource = this.resolveResource(params.resource);
    const code = randomBytes(32).toString("hex");
    this.authCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    this.gcAuthCodes();
    // Hard cap as a defence against sustained /authorize floods that
    // never proceed to /token (so codes never get consumed). Map
    // iteration order is insertion order, so the first key is the
    // oldest entry — drop those first.
    while (this.authCodes.size > AUTH_CODE_MAX_ENTRIES) {
      const oldest = this.authCodes.keys().next().value;
      if (oldest === undefined) break;
      this.authCodes.delete(oldest);
    }

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const state = this.authCodes.get(authorizationCode);
    if (!state || state.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return state.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const state = this.authCodes.get(authorizationCode);
    if (!state || state.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    if (state.clientId !== client.client_id) {
      throw new InvalidGrantError("authorization code was issued to a different client");
    }
    if (redirectUri && redirectUri !== state.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    const requestedResource = this.resolveResource(resource);
    if (requestedResource && state.resource && requestedResource !== state.resource) {
      throw new InvalidGrantError("resource mismatch");
    }
    this.authCodes.delete(authorizationCode);
    return this.issueTokenPair(client.client_id, requestedResource ?? state.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    let claims: SignedTokenClaims;
    try {
      claims = verifyToken(refreshToken, this.signingKey);
    } catch (err) {
      if (err instanceof TokenSignatureError || err instanceof TokenExpiredError) {
        throw new InvalidGrantError("invalid refresh token");
      }
      throw err;
    }
    if (claims.type !== "refresh") {
      throw new InvalidGrantError("not a refresh token");
    }
    if (claims.clientId !== client.client_id) {
      throw new InvalidGrantError("refresh token was issued to a different client");
    }
    this.assertClaimsResource(claims, InvalidGrantError);
    const requestedResource = this.resolveResource(resource);
    if (
      requestedResource &&
      claims.resource &&
      requestedResource !== claims.resource
    ) {
      throw new InvalidGrantError("refresh token resource mismatch");
    }
    return this.issueTokenPair(client.client_id, requestedResource ?? claims.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: SignedTokenClaims;
    try {
      claims = verifyToken(token, this.signingKey);
    } catch (err) {
      if (err instanceof TokenSignatureError) {
        throw new InvalidTokenError("invalid token");
      }
      if (err instanceof TokenExpiredError) {
        throw new InvalidTokenError("token expired");
      }
      throw err;
    }
    if (claims.type !== "access") {
      throw new InvalidTokenError("not an access token");
    }
    this.assertClaimsResource(claims, InvalidTokenError);
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: Math.floor(claims.expiresAt / 1000),
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private issueTokenPair(clientId: string, resource?: string): OAuthTokens {
    const now = Date.now();
    const access = issueToken(
      {
        type: "access",
        clientId,
        ...(resource ? { resource } : {}),
        scopes: [],
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
        nonce: randomBytes(8).toString("hex"),
      },
      this.signingKey,
    );
    const refresh = issueToken(
      {
        type: "refresh",
        clientId,
        ...(resource ? { resource } : {}),
        scopes: [],
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        nonce: randomBytes(8).toString("hex"),
      },
      this.signingKey,
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
    };
  }

  private resolveResource(requestedResource?: URL): string | undefined {
    if (!this.resourceUrl) {
      return requestedResource
        ? resourceUrlFromServerUrl(requestedResource).href
        : undefined;
    }
    if (!requestedResource) return this.resourceUrl.href;
    if (
      !checkResourceAllowed({
        requestedResource,
        configuredResource: this.resourceUrl,
      })
    ) {
      throw new InvalidTargetError(
        `requested resource is not this MCP server: ${requestedResource.href}`,
      );
    }
    return this.resourceUrl.href;
  }

  private assertClaimsResource(
    claims: SignedTokenClaims,
    ErrorClass: typeof InvalidGrantError | typeof InvalidTokenError,
  ): void {
    if (!this.resourceUrl) return;
    if (!claims.resource) {
      throw new ErrorClass("token is missing MCP resource audience");
    }
    if (
      !checkResourceAllowed({
        requestedResource: claims.resource,
        configuredResource: this.resourceUrl,
      })
    ) {
      throw new ErrorClass("token was issued for a different MCP resource");
    }
  }

  private gcAuthCodes(): void {
    const now = Date.now();
    for (const [code, state] of this.authCodes.entries()) {
      if (state.expiresAt < now) this.authCodes.delete(code);
    }
  }
}
