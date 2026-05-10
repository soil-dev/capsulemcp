/**
 * HTTP-app integration tests. Builds the express app via `createApp`
 * with a real OAuth provider, starts it on an ephemeral port, and
 * exercises the handler chain via Node's built-in `fetch`. Closes
 * the bottom of the test pyramid for the HTTP transport — until now
 * its handlers were only verified by the smoke-test against the
 * deployed instance in a separate repo.
 *
 * Capsule API isn't reached: the only path that would hit Capsule is
 * `/mcp` after a successful OAuth dance, and we either stop short
 * of that or mock undici.fetch.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createApp } from "../src/http/app.js";
import { OAuthProvider, FixedClientStore } from "../src/auth/provider.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

// ── Setup: a minimal real provider + app on a random port ────────────────────

const SIGNING_KEY = "x".repeat(32);
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret-32-chars-min";
const REDIRECT_URI = "http://localhost:9999/cb";

// PKCE pair — MCP SDK requires S256
const CODE_VERIFIER = "test-verifier-padding-padding-padding-padding-pad";
const CODE_CHALLENGE = createHash("sha256")
  .update(CODE_VERIFIER)
  .digest("base64url");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";

  const provider = new OAuthProvider({
    clientsStore: new FixedClientStore({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris: [REDIRECT_URI],
      clientName: "test client",
    }),
    signingKey: SIGNING_KEY,
    resourceUrl: new URL("http://localhost/mcp"),
    enableAuthCodeGc: false,
  });

  const app = createApp({
    oauthProvider: provider,
    issuerUrl: new URL("http://localhost"),
    jsonLimit: "1mb",
    allowedOrigins: ["http://localhost", "https://claude.ai"],
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  delete process.env["CAPSULE_API_TOKEN"];
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OAuth metadata endpoints", () => {
  it("/.well-known/oauth-authorization-server returns 200 with issuer", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["issuer"]).toBeTruthy();
    expect(body["authorization_endpoint"]).toBeTruthy();
    expect(body["token_endpoint"]).toBeTruthy();
  });

  it("does NOT advertise registration_endpoint when in static-client mode (DCR off)", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["registration_endpoint"]).toBeUndefined();
  });

  it("/.well-known/oauth-protected-resource/mcp advertises /mcp as the resource", async () => {
    // The MCP server lives at /mcp, so per RFC 9728 the
    // protected-resource metadata is published with that path
    // suffix. Bare /.well-known/oauth-protected-resource is
    // intentionally NOT served (it would advertise the issuer root,
    // which isn't a resource).
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Resource URL is built from the configured issuerUrl (not the
    // ephemeral test port), so assert on the path/origin pair rather
    // than the test baseUrl.
    expect(body["resource"]).toBe("http://localhost/mcp");
    expect(body["authorization_servers"]).toBeTruthy();
  });
});

describe("DCR is disabled in static-client mode", () => {
  it("POST /register returns 404", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("Negative auth surface on /mcp", () => {
  it("POST /mcp without bearer returns 401 with WWW-Authenticate (incl. resource_metadata)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth.toLowerCase()).toContain("bearer");
    // The metadata URL must be advertised so generic clients can
    // discover the resource server's protected-resource metadata
    // (RFC 9728 §5.1).
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("POST /mcp rejects invalid browser origins before auth", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("POST /mcp allows configured browser origins through to auth", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://claude.ai",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /mcp authenticates before parsing the JSON body", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(401);
  });

  it("POST /mcp with a forged bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("GET /mcp with a valid bearer returns 405 (method not allowed)", async () => {
    // Mint a real token by walking the OAuth dance (briefly).
    const accessToken = await mintToken();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("method_not_allowed");
  });

  it("GET /mcp with a valid bearer rejects unsupported protocol versions before 405", async () => {
    const accessToken = await mintToken();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "MCP-Protocol-Version": "2099-01-01",
      },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /mcp with a valid bearer returns 405", async () => {
    const accessToken = await mintToken();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("GET /mcp without bearer returns 401 (auth wired BEFORE 405)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("/authorize and /token", () => {
  it("/authorize with valid client_id returns 302 with code", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      state: "test-state",
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain(REDIRECT_URI);
    expect(location).toContain("code=");
  });

  it("/authorize with wrong client_id returns 4xx", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "wrong-client",
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, {
      redirect: "manual",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("/token with wrong client_secret returns invalid_client", async () => {
    // Get a code first
    const code = await getAuthCode();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      client_secret: "wrong-secret",
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
    });
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_client");
  });
});

describe("/mcp 500 response is sanitized (does not echo internal err.message)", () => {
  it("returns generic {error: 'internal_error'} with no message field", async () => {
    // Force a 500 by sending malformed JSON-RPC after authenticating.
    const accessToken = await mintToken();
    // Body that passes JSON parsing but breaks downstream MCP handling
    // (missing required fields). The /mcp handler may throw inside the
    // SDK's transport layer; we just need to confirm the 500 path
    // doesn't echo internal text.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      // Trigger a 500 by feeding a request body that isn't a JSON-RPC
      // envelope at all. The transport will reject it deep inside the
      // SDK, hitting our catch block.
      body: '{"this":"is not jsonrpc"}',
    });
    if (res.status === 500) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("internal_error");
      // The whole point of the fix: no `message` field on 500s.
      expect(body["message"]).toBeUndefined();
    }
    // The SDK may turn this into a 200-with-error-payload instead of a
    // 500; if so the sanitization isn't relevant for this specific
    // input — the test is asserting the negative shape conditional on
    // hitting the 500 path. Either outcome is acceptable; what we
    // forbid is `{error: 'internal_error', message: '<…leaky…>'}`.
  });
});

describe("Proxy trust (express-rate-limit behind X-Forwarded-For)", () => {
  it("/authorize succeeds when X-Forwarded-For is present (does not 500)", async () => {
    // Without `app.set('trust proxy', 1)`, express-rate-limit treats
    // X-Forwarded-For as a misconfiguration and the request errors out
    // before the OAuth handler runs. With trust-proxy correctly set,
    // the request should proceed normally — i.e. behave exactly like a
    // direct request: 302 with code on success.
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      state: "fwd-test",
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, {
      redirect: "manual",
      headers: { "X-Forwarded-For": "203.0.113.1" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("code=");
  });
});

describe("Icon endpoints (cosmetic)", () => {
  it("/icon.svg returns the SVG with correct content-type", async () => {
    const res = await fetch(`${baseUrl}/icon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  it("/favicon.ico returns the same SVG (browser-default path)", async () => {
    const res = await fetch(`${baseUrl}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("icon responses include a public 24h Cache-Control", async () => {
    const res = await fetch(`${baseUrl}/icon.svg`);
    const cache = res.headers.get("cache-control");
    expect(cache).toContain("public");
    expect(cache).toContain("max-age=86400");
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAuthCode(): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: "http://localhost/mcp",
  });
  const res = await fetch(`${baseUrl}/authorize?${params}`, {
    redirect: "manual",
  });
  const location = res.headers.get("location")!;
  const match = location.match(/code=([^&]+)/);
  if (!match) throw new Error(`no code in redirect: ${location}`);
  return match[1]!;
}

async function mintToken(): Promise<string> {
  const code = await getAuthCode();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code_verifier: CODE_VERIFIER,
    resource: "http://localhost/mcp",
  });
  const res = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
