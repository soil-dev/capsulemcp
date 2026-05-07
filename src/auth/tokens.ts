/**
 * Stateless HMAC-signed tokens for the auto-approve OAuth provider.
 *
 * Format: base64url(JSON payload).base64url(HMAC-SHA256(payload, key))
 *
 * Tokens are self-contained — verification only requires the signing key,
 * not server-side storage. This makes the OAuth implementation tolerate
 * Cloud Run's ephemeral instances (cold-down → new instance → still
 * verifies tokens issued by the previous one, as long as the signing key
 * is stable across instances).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenType = "access" | "refresh" | "code";

export interface SignedTokenClaims {
  type: TokenType;
  clientId: string;
  scopes: string[];
  /** ms-since-epoch when this token expires. */
  expiresAt: number;
  /** PKCE code_challenge from the authorize step (only set on type=code). */
  codeChallenge?: string;
  /** Redirect URI bound at authorize time (only set on type=code). */
  redirectUri?: string;
  /** Random nonce so two tokens with otherwise identical claims differ. */
  nonce: string;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, key: string): string {
  return b64urlEncode(createHmac("sha256", key).update(payload).digest());
}

export function issueToken(claims: SignedTokenClaims, signingKey: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = sign(payloadB64, signingKey);
  return `${payloadB64}.${sig}`;
}

export class TokenSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenSignatureError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("token expired");
    this.name = "TokenExpiredError";
  }
}

/**
 * Verify an HMAC-signed token. Throws TokenSignatureError or
 * TokenExpiredError on failure. Returns the parsed claims on success.
 */
export function verifyToken(token: string, signingKey: string): SignedTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new TokenSignatureError("malformed token");
  }
  const [payloadB64, providedSig] = parts as [string, string];
  const expectedSig = sign(payloadB64, signingKey);

  // Constant-time compare on raw bytes
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenSignatureError("invalid signature");
  }

  let claims: SignedTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as SignedTokenClaims;
  } catch {
    throw new TokenSignatureError("malformed payload");
  }
  if (claims.expiresAt < Date.now()) {
    throw new TokenExpiredError();
  }
  return claims;
}
