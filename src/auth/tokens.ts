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
import { z } from "zod";

// Schema is the source of truth; the interface below is derived from it
// so a drift between runtime validation and TypeScript shape can't happen.
// The HMAC verification already ensures an attacker can't forge claims,
// but Zod-validating the parsed payload is defence-in-depth against a
// future signing-key compromise / downgrade — a malformed claim (missing
// `expiresAt`, non-string `clientId`, etc.) would otherwise propagate
// into downstream AuthInfo with NaN-compared expiry checks.
const SignedTokenClaimsSchema = z.object({
  type: z.enum(["access", "refresh"]),
  clientId: z.string().min(1),
  resource: z.string().optional(),
  scopes: z.array(z.string()),
  expiresAt: z.number().int(),
  nonce: z.string().min(1),
});

export type SignedTokenClaims = z.infer<typeof SignedTokenClaimsSchema>;

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

  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new TokenSignatureError("malformed payload");
  }
  const parsed = SignedTokenClaimsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TokenSignatureError("malformed payload");
  }
  const claims = parsed.data;
  if (claims.expiresAt < Date.now()) {
    throw new TokenExpiredError();
  }
  return claims;
}
