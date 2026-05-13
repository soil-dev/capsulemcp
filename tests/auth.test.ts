import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  issueToken,
  verifyToken,
  TokenSignatureError,
  TokenExpiredError,
} from "../src/auth/tokens.js";
import { FixedClientStore, InMemoryClientsStore, OAuthProvider } from "../src/auth/provider.js";

// Helper: matches the auto-approve mode (open DCR + InMemoryClientsStore).
// Used by the tests below so each one isn't repeating the construction.
function autoApproveProvider(signingKey: string): OAuthProvider {
  return new OAuthProvider({
    clientsStore: new InMemoryClientsStore(),
    signingKey,
    // Tests don't want the periodic GC timer keeping the event loop
    // alive past assertion time.
    enableAuthCodeGc: false,
  });
}

const KEY = "0123456789abcdef0123456789abcdef";

// PKCE test fixture. `exchangeAuthorizationCode` does a constant-time
// PKCE check (`skipLocalPkceValidation = true` on the provider tells
// the SDK to defer to us). Tests that drive the authorize → token
// roundtrip need a real (verifier, challenge) pair so the check
// passes; tests that probe the rejection path use a deliberately-
// non-matching verifier.
const PKCE_VERIFIER = "test-verifier-1234567890abcdefghijklmnopqrstuv";
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

// ── Token signing ───────────────────────────────────────────────────────────

describe("issueToken / verifyToken", () => {
  it("round-trips claims", () => {
    const claims = {
      type: "access" as const,
      clientId: "abc",
      scopes: ["read"],
      expiresAt: Date.now() + 60_000,
      nonce: "n1",
    };
    const tok = issueToken(claims, KEY);
    const back = verifyToken(tok, KEY);
    expect(back.clientId).toBe("abc");
    expect(back.scopes).toEqual(["read"]);
    expect(back.type).toBe("access");
  });

  it("rejects modified payload", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() + 60_000, nonce: "n" },
      KEY,
    );
    const [body, sig] = tok.split(".") as [string, string];
    // Flip a bit in the payload
    const tampered = `${body.slice(0, -2)}AB.${sig}`;
    expect(() => verifyToken(tampered, KEY)).toThrow(TokenSignatureError);
  });

  it("rejects token signed with a different key", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() + 60_000, nonce: "n" },
      KEY,
    );
    expect(() => verifyToken(tok, "ffffffffffffffffffffffffffffffff")).toThrow(TokenSignatureError);
  });

  it("rejects expired tokens", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() - 1, nonce: "n" },
      KEY,
    );
    expect(() => verifyToken(tok, KEY)).toThrow(TokenExpiredError);
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyToken("not-a-token", KEY)).toThrow(TokenSignatureError);
    expect(() => verifyToken("a.b.c", KEY)).toThrow(TokenSignatureError);
  });

  it("rejects HMAC-valid tokens whose payload doesn't match the claims schema", async () => {
    // Hand-craft a token with a non-string `clientId` and a valid HMAC.
    // The signature check would pass — Zod-validation is the gate that
    // catches this. Without the runtime schema-check, `expiresAt < Date.now()`
    // would NaN-compare to false and the malformed claim would propagate.
    const { createHmac } = await import("node:crypto");
    const malformed = JSON.stringify({
      type: "access",
      clientId: 12345, // must be string
      scopes: [],
      expiresAt: Date.now() + 60_000,
      nonce: "n",
    });
    const payloadB64 = Buffer.from(malformed, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sigBuf = createHmac("sha256", KEY).update(payloadB64).digest();
    const sigB64 = sigBuf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tok = `${payloadB64}.${sigB64}`;
    expect(() => verifyToken(tok, KEY)).toThrow(TokenSignatureError);
  });
});

// ── Provider ────────────────────────────────────────────────────────────────

describe("OAuthProvider in auto-approve mode (open DCR)", () => {
  it("rejects too-short signing keys", () => {
    expect(() => autoApproveProvider("short")).toThrow(/at least 16/);
  });

  it("clientsStore registers and retrieves clients", async () => {
    const p = autoApproveProvider(KEY);
    const c = await p.clientsStore.registerClient!({
      redirect_uris: ["http://localhost/cb"],
    });
    expect(c.client_id).toBeTruthy();
    expect(c.client_id_issued_at).toBeGreaterThan(0);

    const back = await p.clientsStore.getClient(c.client_id);
    expect(back?.client_id).toBe(c.client_id);
  });

  it("authorize -> exchangeAuthorizationCode -> verifyAccessToken roundtrip", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({
      redirect_uris: ["http://localhost/cb"],
    });

    // Mock express Response just enough to capture the redirect
    let redirectedTo: string | undefined;
    const fakeRes = {
      redirect: (url: string) => {
        redirectedTo = url;
      },
    };

    await p.authorize(
      client,
      {
        codeChallenge: PKCE_CHALLENGE,
        redirectUri: "http://localhost/cb",
        state: "s1",
      },
      fakeRes as never,
    );

    expect(redirectedTo).toBeDefined();
    const url = new URL(redirectedTo!);
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    // Server stored the challenge for the code (PKCE check is the SDK's job)
    const stashedChallenge = await p.challengeForAuthorizationCode(client, code!);
    expect(stashedChallenge).toBe(PKCE_CHALLENGE);

    // Exchange the code for tokens
    const tokens = await p.exchangeAuthorizationCode(client, code!, PKCE_VERIFIER);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe("Bearer");

    // Validate the access token
    const auth = await p.verifyAccessToken(tokens.access_token);
    expect(auth.clientId).toBe(client.client_id);
  });

  it("rejects re-use of a consumed authorization code", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(client, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    await p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER);
    await expect(p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects refresh tokens from a different client", async () => {
    const p = autoApproveProvider(KEY);
    const a = await p.clientsStore.registerClient!({ redirect_uris: ["http://a/cb"] });
    const b = await p.clientsStore.registerClient!({ redirect_uris: ["http://b/cb"] });

    let redirected: string | undefined;
    await p.authorize(a, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://a/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(a, code, PKCE_VERIFIER);

    await expect(p.exchangeRefreshToken(b, tokens.refresh_token!)).rejects.toThrow(
      /different client/,
    );
  });

  it("verifyAccessToken rejects refresh tokens (wrong type)", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(client, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER);

    await expect(p.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow();
  });
});

// ── FixedClientStore ────────────────────────────────────────────────────────

describe("FixedClientStore", () => {
  const baseArgs = {
    clientId: "fixed-id",
    clientSecret: "0123456789abcdef0123456789abcdef",
    redirectUris: ["http://localhost:9999/cb"],
  };

  it("rejects empty clientId", () => {
    expect(() => new FixedClientStore({ ...baseArgs, clientId: "" })).toThrow(/clientId/);
  });

  it("rejects too-short clientSecret", () => {
    expect(() => new FixedClientStore({ ...baseArgs, clientSecret: "short" })).toThrow(
      /at least 16/,
    );
  });

  it("rejects empty redirectUris", () => {
    expect(() => new FixedClientStore({ ...baseArgs, redirectUris: [] })).toThrow(/redirectUri/);
  });

  it("getClient returns the configured client only for the configured id", () => {
    const store = new FixedClientStore(baseArgs);
    expect(store.getClient("fixed-id")?.client_id).toBe("fixed-id");
    expect(store.getClient("anyone-else")).toBeUndefined();
  });

  it("does not implement registerClient (DCR disabled)", () => {
    const store = new FixedClientStore(baseArgs);
    expect((store as { registerClient?: unknown }).registerClient).toBeUndefined();
  });

  // verifyClientSecret was previously exposed but never called by the
  // MCP SDK's auth router (which compares secrets itself), so it was
  // dead code and the misleading "constant-time defense-in-depth" comment
  // was removed in the post-pre-1.0 audit cleanup.
});

// ── PKCE verification (we do this ourselves, constant-time) ────────────────

describe("OAuthProvider PKCE verification (constant-time, S256)", () => {
  // The SDK's bundled pkce-challenge does its compare with native `===`.
  // We opt out via `skipLocalPkceValidation = true` and do the check
  // ourselves with timingSafeEqual in exchangeAuthorizationCode. These
  // tests cover the happy path and each of the rejection paths.

  it("accepts a code_verifier that hashes to the stored challenge", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(client, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER);
    expect(tokens.access_token).toBeTruthy();
  });

  it("rejects a code_verifier whose hash doesn't match the stored challenge", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(client, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    await expect(
      p.exchangeAuthorizationCode(client, code, "wrong-verifier-deadbeefdeadbeefdeadbeefdead"),
    ).rejects.toThrow(/code_verifier does not match/);
    // The code must NOT be consumed by a failed PKCE check — otherwise a
    // network glitch on the legitimate exchange would burn the code.
    // Retrying with the correct verifier should still succeed.
    const tokens = await p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER);
    expect(tokens.access_token).toBeTruthy();
  });

  it("rejects a missing code_verifier with a clear InvalidGrantError", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(client, { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" }, {
      redirect: (u: string) => {
        redirected = u;
      },
    } as never);
    const code = new URL(redirected!).searchParams.get("code")!;
    await expect(p.exchangeAuthorizationCode(client, code, undefined)).rejects.toThrow(
      /code_verifier required/,
    );
  });

  it("rejects a verifier valid for a DIFFERENT code (cross-code attack)", async () => {
    // Each authorization code's stored challenge is independent. A
    // verifier that satisfies code A's challenge must not be accepted
    // for code B's exchange.
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });

    const verifierB = "different-verifier-abcdefghijklmnopqrstuvwxyz";
    const challengeB = createHash("sha256").update(verifierB).digest("base64url");

    const redirects: string[] = [];
    const fakeRes = (i: number) => ({
      redirect: (u: string) => {
        redirects[i] = u;
      },
    });

    await p.authorize(
      client,
      { codeChallenge: PKCE_CHALLENGE, redirectUri: "http://x/cb" },
      fakeRes(0) as never,
    );
    await p.authorize(
      client,
      { codeChallenge: challengeB, redirectUri: "http://x/cb" },
      fakeRes(1) as never,
    );
    const codeA = new URL(redirects[0]!).searchParams.get("code")!;
    const codeB = new URL(redirects[1]!).searchParams.get("code")!;

    // verifierB satisfies challengeB → must be rejected against codeA.
    await expect(p.exchangeAuthorizationCode(client, codeA, verifierB)).rejects.toThrow(
      /code_verifier does not match/,
    );
    // PKCE_VERIFIER satisfies PKCE_CHALLENGE → must be rejected against codeB.
    await expect(p.exchangeAuthorizationCode(client, codeB, PKCE_VERIFIER)).rejects.toThrow(
      /code_verifier does not match/,
    );
    // Sanity: each verifier accepted against its own code.
    expect(
      (await p.exchangeAuthorizationCode(client, codeA, PKCE_VERIFIER)).access_token,
    ).toBeTruthy();
    expect((await p.exchangeAuthorizationCode(client, codeB, verifierB)).access_token).toBeTruthy();
  });

  it("exposes skipLocalPkceValidation = true (so the SDK defers to us)", () => {
    // The opt-out is what tells the SDK's /token handler to pass
    // code_verifier through instead of running its own (non-constant-
    // time) verifyChallenge. If this flag ever flips back to false the
    // tests above would still pass — but the SDK's `===` would run
    // first, defeating the point of doing this ourselves.
    const p = autoApproveProvider(KEY);
    expect(p.skipLocalPkceValidation).toBe(true);
  });
});

describe("OAuthProvider authCodes cap (DoS hardening)", () => {
  it("caps the in-memory authorization-code map at 10k entries", async () => {
    // Sustained /authorize flood with no /token follow-up would
    // otherwise grow the Map unbounded. The cap drops the oldest entry
    // each insert past 10k.
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({
      redirect_uris: ["http://localhost/cb"],
    });
    const fakeRes = { redirect: () => {} };

    // Push 10100 codes through. We don't need to verify any of them —
    // just check the internal Map didn't grow past the cap.
    for (let i = 0; i < 10100; i++) {
      await p.authorize(
        client,
        {
          codeChallenge: `c${i}`,
          redirectUri: "http://localhost/cb",
          state: `s${i}`,
        },
        fakeRes as never,
      );
    }
    const size = (p as unknown as { authCodes: Map<string, unknown> }).authCodes.size;
    expect(size).toBeLessThanOrEqual(10_000);
    p.shutdown();
  });
});

// ── OAuthProvider with FixedClientStore — end-to-end via the provider API ───

describe("OAuthProvider + FixedClientStore", () => {
  const KEY_LOCAL = "0123456789abcdef0123456789abcdef";
  const SECRET = "fixed-client-secret-must-be-strong-32";
  const RESOURCE_URL = new URL("https://mcp.example.com/mcp");

  function makeProvider() {
    return new OAuthProvider({
      clientsStore: new FixedClientStore({
        clientId: "fixed-id",
        clientSecret: SECRET,
        redirectUris: ["http://x/cb"],
      }),
      signingKey: KEY_LOCAL,
      resourceUrl: RESOURCE_URL,
      enableAuthCodeGc: false,
    });
  }

  it("authorize -> token -> verify roundtrip works for the configured client", async () => {
    const p = makeProvider();
    const client = p.clientsStore.getClient("fixed-id")!;
    let redirected: string | undefined;
    await p.authorize(
      client,
      {
        codeChallenge: PKCE_CHALLENGE,
        redirectUri: "http://x/cb",
        resource: RESOURCE_URL,
      },
      {
        redirect: (u: string) => {
          redirected = u;
        },
      } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code, PKCE_VERIFIER);
    expect(tokens.access_token).toBeTruthy();
    const auth = await p.verifyAccessToken(tokens.access_token);
    expect(auth.clientId).toBe("fixed-id");
  });

  it("rejects authorization requests for a different MCP resource", async () => {
    const p = makeProvider();
    const client = p.clientsStore.getClient("fixed-id")!;
    await expect(
      p.authorize(
        client,
        {
          codeChallenge: PKCE_CHALLENGE,
          redirectUri: "http://x/cb",
          resource: new URL("https://attacker.example/mcp"),
        },
        { redirect: () => {} } as never,
      ),
    ).rejects.toThrow(/requested resource/);
  });

  it("rejects token exchange when token request resource differs from the authorization resource", async () => {
    const p = makeProvider();
    const client = p.clientsStore.getClient("fixed-id")!;
    let redirected: string | undefined;
    await p.authorize(
      client,
      {
        codeChallenge: PKCE_CHALLENGE,
        redirectUri: "http://x/cb",
        resource: RESOURCE_URL,
      },
      {
        redirect: (u: string) => {
          redirected = u;
        },
      } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;

    await expect(
      p.exchangeAuthorizationCode(
        client,
        code,
        PKCE_VERIFIER,
        "http://x/cb",
        new URL("https://mcp.example.com/other"),
      ),
    ).rejects.toThrow(/resource/);
  });

  it("rejects access tokens missing the MCP resource audience", async () => {
    const p = makeProvider();
    const tok = issueToken(
      {
        type: "access",
        clientId: "fixed-id",
        scopes: [],
        expiresAt: Date.now() + 60_000,
        nonce: "n",
      },
      KEY_LOCAL,
    );

    await expect(p.verifyAccessToken(tok)).rejects.toThrow(/resource audience/);
  });

  it("getClient returns undefined for unregistered ids", async () => {
    const p = makeProvider();
    expect(await p.clientsStore.getClient("not-the-fixed-one")).toBeUndefined();
  });
});
