/**
 * Auto-approve OAuth 2.1 server provider for capsulemcp.
 *
 * Anthropic's Custom Connector machinery requires the MCP HTTP server to
 * speak the OAuth 2.1 + RFC 7591 (Dynamic Client Registration) protocol.
 * Building a real OAuth server with login pages, consent screens, and
 * per-user identity is overkill for an internal read-only org connector
 * backed by a single shared Capsule API token. This provider satisfies
 * the protocol surface while doing the simplest thing on every step:
 *
 *   - DCR /register: accept any registration; mint random client_id and
 *     client_secret; remember it in process memory.
 *   - /authorize: auto-approve; immediately redirect with an
 *     authorization code containing PKCE challenge claims.
 *   - /token: verify the code, issue an HMAC-signed access token (and
 *     refresh token).
 *   - access tokens: HMAC-signed, stateless (no server-side storage),
 *     verifiable from the signing key alone.
 *
 * Trade-offs documented:
 *   - The DCR client store is in-memory; if the Cloud Run instance dies,
 *     existing access tokens still verify (signing key is stable) but a
 *     refresh would fail because the client_id is unknown. Anthropic
 *     would re-register on next use, which is silent.
 *   - Authorization codes are also in-memory; they're consumed within
 *     seconds so this is fine.
 *   - All clients get the same effective access — the underlying Capsule
 *     API token is shared. This is by design for a read-only org
 *     connector.
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

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
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

export class AutoApproveOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore = new InMemoryClientsStore();
  private readonly authCodes = new Map<string, AuthCodeState>();
  private readonly signingKey: string;

  constructor(signingKey: string) {
    if (!signingKey || signingKey.length < 16) {
      throw new Error(
        "AutoApproveOAuthProvider: signing key must be at least 16 chars long",
      );
    }
    this.signingKey = signingKey;
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

    // Best-effort GC of expired codes — keeps the map from growing.
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

    // Codes are single-use.
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
