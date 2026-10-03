/**
 * GET /health (src/http/health.ts).
 *
 * Three layers: the pure projection + status mapping (so the body
 * contract is pinned precisely), the real Express mount on an
 * ephemeral port hit with Node's built-in fetch (which is NOT the
 * mocked `undici` module) to prove the route, headers and rate limiter
 * are wired, and the fully assembled `createApp` to prove the page
 * survives its neighbours (the OAuth router's unscoped `app.use`, the
 * bearer-guarded /mcp) and is reachable without any credential.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as upstreamFetch } from "undici";
import { FixedClientStore, OAuthProvider } from "../src/auth/provider.js";
import { createApp } from "../src/http/app.js";
import {
  DEFAULT_HEALTH_PATH,
  healthBody,
  healthStatusCode,
  mountHealth,
  resolveHealthPath,
} from "../src/http/health.js";
import { type CapsuleHealth, resetHealthForTests } from "../src/capsule/health.js";
import { VERSION } from "../src/version.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const TOKEN = "route-test-token-never-in-a-response";

function mockUpstream(status: number) {
  vi.mocked(upstreamFetch).mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: { cancel: async () => undefined },
    json: async () => ({}),
    text: async () => "",
    statusText: String(status),
  } as unknown as Awaited<ReturnType<typeof upstreamFetch>>);
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

// Silence the probe's forced `capsule.auth` events; tests/capsule-health
// asserts on them, this file only needs them quiet.
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = TOKEN;
  resetHealthForTests();
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
});
afterEach(() => {
  stderrSpy?.mockRestore();
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_HEALTH_PATH"];
  delete process.env["MCP_HTTP_RATE_LIMIT_MAX"];
});

describe("healthBody / healthStatusCode", () => {
  const at = "2026-10-03T10:00:00.000Z";

  it("valid → 200 ok, exactly the four public fields", () => {
    const health: CapsuleHealth = { token_status: "valid", checked_at: at };
    expect(healthStatusCode(health)).toBe(200);
    expect(healthBody(health)).toEqual({
      status: "ok",
      connector_version: VERSION,
      token_status: "valid",
      checked_at: at,
    });
  });

  it("rejected and unreachable → 503 degraded; reason and detail never leak", () => {
    for (const token_status of ["rejected", "unreachable"] as const) {
      const health: CapsuleHealth = {
        token_status,
        checked_at: at,
        reason: "unauthorized",
        detail: `secret-ish upstream text ${TOKEN}`,
      };
      expect(healthStatusCode(health)).toBe(503);
      const body = healthBody(health);
      expect(body.status).toBe("degraded");
      expect(Object.keys(body).sort()).toEqual([
        "checked_at",
        "connector_version",
        "status",
        "token_status",
      ]);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });
});

describe("resolveHealthPath", () => {
  it("defaults to /health and honours a well-formed override", () => {
    expect(resolveHealthPath()).toBe(DEFAULT_HEALTH_PATH);
    process.env["CAPSULE_MCP_HEALTH_PATH"] = "/-/health";
    expect(resolveHealthPath()).toBe("/-/health");
  });

  it("refuses relative paths, query strings, trailing slashes and protocol-relative URLs", () => {
    for (const bad of ["health", "/health?x=1", "/health/", "//evil.example/x", "/he alth"]) {
      process.env["CAPSULE_MCP_HEALTH_PATH"] = bad;
      expect(() => resolveHealthPath(), bad).toThrow(/CAPSULE_MCP_HEALTH_PATH/);
    }
  });

  it("refuses paths that would shadow the OAuth or MCP surface", () => {
    for (const bad of [
      "/mcp",
      "/MCP",
      "/token",
      "/authorize/x",
      "/.well-known/oauth-authorization-server",
      "/icon.svg",
    ]) {
      process.env["CAPSULE_MCP_HEALTH_PATH"] = bad;
      expect(() => resolveHealthPath(), bad).toThrow(/reserved/);
    }
    // A sibling of a reserved prefix is fine — only the exact path or its subtree is blocked.
    process.env["CAPSULE_MCP_HEALTH_PATH"] = "/mcp-health";
    expect(resolveHealthPath()).toBe("/mcp-health");
  });
});

describe("mounted on a bare Express app", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it("200 with the compact JSON an uptime checker matches on, Cache-Control: no-store", async () => {
    mockUpstream(200);
    const app = express();
    mountHealth(app);
    ({ server } = await listen(app));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    // The exact substring the deployment's uptime check is configured with.
    expect(text).toContain('"token_status":"valid"');
    expect(text).toContain(`"connector_version":"${VERSION}"`);
    expect(text).not.toContain(TOKEN);
  });

  it("503 with token_status rejected when Capsule answers 401", async () => {
    mockUpstream(401);
    const app = express();
    mountHealth(app);
    ({ server } = await listen(app));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", token_status: "rejected" });
    expect(body["detail"]).toBeUndefined();
    expect(body["reason"]).toBeUndefined();
  });

  it("serves the page at CAPSULE_MCP_HEALTH_PATH when overridden", async () => {
    mockUpstream(200);
    process.env["CAPSULE_MCP_HEALTH_PATH"] = "/-/health";
    const app = express();
    mountHealth(app);
    ({ server } = await listen(app));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/-/health`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });

  it("is rate-limited per source IP in its own bucket", async () => {
    mockUpstream(200);
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "2";
    const app = express();
    mountHealth(app);
    ({ server } = await listen(app));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const third = await fetch(`${base}/health`);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "too_many_requests" });
  });
});

describe("inside the full createApp", () => {
  let server: Server | undefined;
  let provider: OAuthProvider | undefined;
  afterEach(async () => {
    provider?.shutdown();
    await close(server);
    server = undefined;
  });

  it("is reachable without any credential and survives the OAuth router", async () => {
    mockUpstream(200);
    provider = new OAuthProvider({
      clientsStore: new FixedClientStore({
        clientId: "health-test-client",
        clientSecret: "health-test-secret-at-least-32-chars",
        redirectUris: ["http://localhost/cb"],
      }),
      signingKey: "health-test-signing-key-32-chars-long",
      resourceUrl: new URL("http://localhost/mcp"),
      enableAuthCodeGc: false,
    });
    const app = createApp({
      oauthProvider: provider,
      issuerUrl: new URL("http://localhost"),
      jsonLimit: "1mb",
      allowedOrigins: [],
      trustProxy: false,
    });
    ({ server } = await listen(app));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"token_status":"valid"');
    // The neighbouring protected endpoint still demands a bearer token.
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
  });
});
