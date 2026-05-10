import { describe, it, expect } from "vitest";
import {
  issueToken,
  verifyToken,
  TokenSignatureError,
  TokenExpiredError,
} from "../src/auth/tokens.js";
import {
  FixedClientStore,
  InMemoryClientsStore,
  OAuthProvider,
} from "../src/auth/provider.js";

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
    const tampered = body.slice(0, -2) + "AB" + "." + sig;
    expect(() => verifyToken(tampered, KEY)).toThrow(TokenSignatureError);
  });

  it("rejects token signed with a different key", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() + 60_000, nonce: "n" },
      KEY,
    );
    expect(() => verifyToken(tok, "ffffffffffffffffffffffffffffffff")).toThrow(
      TokenSignatureError,
    );
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
        codeChallenge: "challenge-from-pkce-verifier",
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
    expect(stashedChallenge).toBe("challenge-from-pkce-verifier");

    // Exchange the code for tokens
    const tokens = await p.exchangeAuthorizationCode(client, code!);
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
    await p.authorize(
      client,
      { codeChallenge: "c", redirectUri: "http://x/cb" },
      { redirect: (u: string) => { redirected = u; } } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    await p.exchangeAuthorizationCode(client, code);
    await expect(p.exchangeAuthorizationCode(client, code)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects refresh tokens from a different client", async () => {
    const p = autoApproveProvider(KEY);
    const a = await p.clientsStore.registerClient!({ redirect_uris: ["http://a/cb"] });
    const b = await p.clientsStore.registerClient!({ redirect_uris: ["http://b/cb"] });

    let redirected: string | undefined;
    await p.authorize(
      a,
      { codeChallenge: "c", redirectUri: "http://a/cb" },
      { redirect: (u: string) => { redirected = u; } } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(a, code);

    await expect(
      p.exchangeRefreshToken(b, tokens.refresh_token!),
    ).rejects.toThrow(/different client/);
  });

  it("verifyAccessToken rejects refresh tokens (wrong type)", async () => {
    const p = autoApproveProvider(KEY);
    const client = await p.clientsStore.registerClient!({ redirect_uris: ["http://x/cb"] });
    let redirected: string | undefined;
    await p.authorize(
      client,
      { codeChallenge: "c", redirectUri: "http://x/cb" },
      { redirect: (u: string) => { redirected = u; } } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code);

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
    expect(() => new FixedClientStore({ ...baseArgs, clientId: "" })).toThrow(
      /clientId/,
    );
  });

  it("rejects too-short clientSecret", () => {
    expect(
      () => new FixedClientStore({ ...baseArgs, clientSecret: "short" }),
    ).toThrow(/at least 16/);
  });

  it("rejects empty redirectUris", () => {
    expect(() => new FixedClientStore({ ...baseArgs, redirectUris: [] })).toThrow(
      /redirectUri/,
    );
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
    const size = (p as unknown as { authCodes: Map<string, unknown> }).authCodes
      .size;
    expect(size).toBeLessThanOrEqual(10_000);
    p.shutdown();
  });
});

// ── OAuthProvider with FixedClientStore — end-to-end via the provider API ───

describe("OAuthProvider + FixedClientStore", () => {
  const KEY_LOCAL = "0123456789abcdef0123456789abcdef";
  const SECRET = "fixed-client-secret-must-be-strong-32";

  function makeProvider() {
    return new OAuthProvider({
      clientsStore: new FixedClientStore({
        clientId: "fixed-id",
        clientSecret: SECRET,
        redirectUris: ["http://x/cb"],
      }),
      signingKey: KEY_LOCAL,
      enableAuthCodeGc: false,
    });
  }

  it("authorize -> token -> verify roundtrip works for the configured client", async () => {
    const p = makeProvider();
    const client = p.clientsStore.getClient("fixed-id")!;
    let redirected: string | undefined;
    await p.authorize(
      client,
      { codeChallenge: "c", redirectUri: "http://x/cb" },
      { redirect: (u: string) => { redirected = u; } } as never,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeTruthy();
    const auth = await p.verifyAccessToken(tokens.access_token);
    expect(auth.clientId).toBe("fixed-id");
  });

  it("getClient returns undefined for unregistered ids", async () => {
    const p = makeProvider();
    expect(await p.clientsStore.getClient("not-the-fixed-one")).toBeUndefined();
  });
});
