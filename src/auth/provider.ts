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

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  issueToken,
  verifyToken,
  TokenExpiredError,
  TokenSignatureError,
  type SignedTokenClaims,
} from "./tokens.js";

const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AuthCodeState {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
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
  private readonly secretBuffer: Buffer;

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
    this.secretBuffer = Buffer.from(args.clientSecret);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId !== this.client.client_id) return undefined;
    return this.client;
  }

  /**
   * Constant-time check that a presented client_secret matches the one
   * configured at startup. Used by the auth router during /token grant
   * validation. The router calls clientsStore.getClient(id) and then
   * compares secrets itself, but providing this helper keeps the
   * comparison logic in one place if the SDK shape ever changes.
   */
  verifyClientSecret(presented: string): boolean {
    const a = Buffer.from(presented);
    if (a.length !== this.secretBuffer.length) return false;
    return timingSafeEqual(a, this.secretBuffer);
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly authCodes = new Map<string, AuthCodeState>();
  private readonly signingKey: string;

  constructor(args: {
    clientsStore: OAuthRegisteredClientsStore;
    signingKey: string;
  }) {
    if (!args.signingKey || args.signingKey.length < 16) {
      throw new Error("OAuthProvider: signing key must be at least 16 chars long");
    }
    this.clientsStore = args.clientsStore;
    this.signingKey = args.signingKey;
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
    const code = randomBytes(32).toString("hex");
    this.authCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    this.gcAuthCodes();

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
    this.authCodes.delete(authorizationCode);
    return this.issueTokenPair(client.client_id);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
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
    return this.issueTokenPair(client.client_id);
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
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: Math.floor(claims.expiresAt / 1000),
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private issueTokenPair(clientId: string): OAuthTokens {
    const now = Date.now();
    const access = issueToken(
      {
        type: "access",
        clientId,
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

  private gcAuthCodes(): void {
    const now = Date.now();
    for (const [code, state] of this.authCodes.entries()) {
      if (state.expiresAt < now) this.authCodes.delete(code);
    }
  }
}

// ── Backwards-compat alias ──────────────────────────────────────────────────
//
// v0.2.0 exported `AutoApproveOAuthProvider`. Keep the name as an alias so
// any external code importing it still works.

export class AutoApproveOAuthProvider extends OAuthProvider {
  constructor(signingKey: string) {
    super({ clientsStore: new InMemoryClientsStore(), signingKey });
  }
}
