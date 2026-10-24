import { describe, it, expect } from "vitest";
import {
  selectMode,
  resolveBaseConfig,
  resolveListenHost,
  isLoopbackAddress,
  type Mode,
  DEFAULT_ANTHROPIC_REDIRECT_URIS,
  DEFAULT_MCP_CLIENT_ORIGINS,
} from "../src/http/config.js";

// ── selectMode ──────────────────────────────────────────────────────────────

describe("selectMode", () => {
  it("returns static-client mode when both client id and secret are set", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "supersecretsupersecret",
    });
    expect(result).toEqual({
      ok: {
        kind: "static-client",
        clientId: "abc",
        clientSecret: "supersecretsupersecret",
        redirectUris: DEFAULT_ANTHROPIC_REDIRECT_URIS,
      },
    });
  });

  it("uses MCP_OAUTH_REDIRECT_URIS when provided (comma-separated)", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "secret",
      MCP_OAUTH_REDIRECT_URIS: "https://one.example/cb,https://two.example/cb",
    });
    expect("ok" in result).toBe(true);
    if ("ok" in result && result.ok.kind === "static-client") {
      expect(result.ok.redirectUris).toEqual(["https://one.example/cb", "https://two.example/cb"]);
    }
  });

  it("trims whitespace and drops empty entries from MCP_OAUTH_REDIRECT_URIS", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "secret",
      MCP_OAUTH_REDIRECT_URIS: "  https://one.example/cb , , https://two.example/cb  ",
    });
    expect("ok" in result).toBe(true);
    if ("ok" in result && result.ok.kind === "static-client") {
      expect(result.ok.redirectUris).toEqual(["https://one.example/cb", "https://two.example/cb"]);
    }
  });

  it("errors when MCP_OAUTH_REDIRECT_URIS is set but yields no usable values", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "secret",
      MCP_OAUTH_REDIRECT_URIS: " , , ",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("no usable URIs");
    }
  });

  it("errors when MCP_OAUTH_REDIRECT_URIS contains a malformed URL", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "secret",
      MCP_OAUTH_REDIRECT_URIS: "https://ok.example/cb,not-a-url",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("malformed URL");
      expect(result.error).toContain("not-a-url");
    }
  });

  it("errors when only client id is set (not secret)", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("must both be set");
    }
  });

  it("errors when only client secret is set (not id)", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_SECRET: "secret",
    });
    expect("error" in result).toBe(true);
  });

  it("returns insecure-auto-approve when MCP_OAUTH_INSECURE_AUTO_APPROVE=1 and PUBLIC_BASE_URL is localhost", () => {
    const result = selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "1" }, "http://localhost:3000");
    expect(result).toEqual({ ok: { kind: "insecure-auto-approve" } });
  });

  it("accepts 'true' (any case) for MCP_OAUTH_INSECURE_AUTO_APPROVE on localhost", () => {
    expect(
      selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "true" }, "http://localhost:3000"),
    ).toEqual({ ok: { kind: "insecure-auto-approve" } });
    expect(
      selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "TRUE" }, "http://127.0.0.1:3000"),
    ).toEqual({ ok: { kind: "insecure-auto-approve" } });
  });

  it("REFUSES insecure-auto-approve when PUBLIC_BASE_URL is not localhost", () => {
    const result = selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "1" }, "https://example.run.app");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not a localhost address");
      expect(result.error).toContain("MCP_OAUTH_I_KNOW_WHAT_IM_DOING");
    }
  });

  it("permits insecure-auto-approve on a public host when MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes", () => {
    const result = selectMode(
      {
        MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
        MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "yes",
      },
      "https://example.run.app",
    );
    expect(result).toEqual({ ok: { kind: "insecure-auto-approve" } });
  });

  it("REFUSES insecure-auto-approve when no PUBLIC_BASE_URL is provided (defaults to non-local)", () => {
    // Calling without publicBaseUrl is the conservative path — without
    // proof the URL is local, refuse unless explicitly acknowledged.
    const result = selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "1" });
    expect("error" in result).toBe(true);
  });

  it("does NOT accept random truthy strings for MCP_OAUTH_INSECURE_AUTO_APPROVE", () => {
    const result = selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "yes" });
    expect("error" in result).toBe(true);
  });

  it("errors when no OAuth mode is configured at all", () => {
    const result = selectMode({});
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No OAuth mode configured");
    }
  });

  it("static-client takes precedence over INSECURE_AUTO_APPROVE if both are set", () => {
    const result = selectMode({
      MCP_OAUTH_CLIENT_ID: "abc",
      MCP_OAUTH_CLIENT_SECRET: "secret",
      MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
    });
    expect("ok" in result).toBe(true);
    if ("ok" in result) {
      expect(result.ok.kind).toBe("static-client");
    }
  });
});

// ── resolveBaseConfig ───────────────────────────────────────────────────────

const VALID_KEY = "a".repeat(32);

describe("resolveBaseConfig", () => {
  it("returns parsed values when all required env is present", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect(result).toEqual({
      ok: {
        publicBaseUrl: "https://example.run.app",
        signingKey: VALID_KEY,
        port: 8080,
        jsonLimit: "35mb",
        allowedOrigins: ["https://example.run.app", ...DEFAULT_MCP_CLIENT_ORIGINS],
        trustProxy: 1,
      },
    });
  });

  it("uses MCP_HTTP_TRUST_PROXY env when set", () => {
    // Multi-hop ingress (e.g. Cloudflare in front of Cloud Run)
    // needs `2`. Single-frontend deployments stay on the default.
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_HTTP_TRUST_PROXY: "2",
    });
    if ("ok" in result) expect(result.ok.trustProxy).toBe(2);
    else throw new Error(`unexpected error: ${result.error}`);
  });

  it("accepts MCP_HTTP_TRUST_PROXY=0 for bare-IP deployments", () => {
    // Without any proxy in front, trusting X-Forwarded-For at all
    // lets a client spoof their bucket. `0` disables the trust.
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_HTTP_TRUST_PROXY: "0",
    });
    if ("ok" in result) expect(result.ok.trustProxy).toBe(0);
    else throw new Error(`unexpected error: ${result.error}`);
  });

  it("rejects malformed MCP_HTTP_TRUST_PROXY (negative / huge / non-integer)", () => {
    // Each of these is almost certainly a typo. Surface clearly at
    // startup rather than silently mis-key the rate limiter.
    for (const bad of ["-1", "11", "1.5", "yes", "true"]) {
      const result = resolveBaseConfig({
        PUBLIC_BASE_URL: "https://example.run.app",
        MCP_OAUTH_SIGNING_KEY: VALID_KEY,
        MCP_HTTP_TRUST_PROXY: bad,
      });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toMatch(/MCP_HTTP_TRUST_PROXY must be an integer/);
      }
    }
  });

  it("uses PORT env when set", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      PORT: "9090",
    });
    if ("ok" in result) expect(result.ok.port).toBe(9090);
  });

  it("uses MCP_HTTP_JSON_LIMIT env when set", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_HTTP_JSON_LIMIT: "100mb",
    });
    if ("ok" in result) expect(result.ok.jsonLimit).toBe("100mb");
  });

  it("uses MCP_ALLOWED_ORIGINS when set", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_ALLOWED_ORIGINS: "https://app.example, https://other.example/path",
    });
    if ("ok" in result) {
      expect(result.ok.allowedOrigins).toEqual([
        "https://example.run.app",
        ...DEFAULT_MCP_CLIENT_ORIGINS,
        "https://app.example",
        "https://other.example",
      ]);
    }
  });

  it("errors when MCP_ALLOWED_ORIGINS contains a malformed URL", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_ALLOWED_ORIGINS: "https://ok.example,not a url",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("MCP_ALLOWED_ORIGINS");
    }
  });

  it("errors when MCP_ALLOWED_ORIGINS contains a non-web origin", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      MCP_ALLOWED_ORIGINS: "ftp://app.example",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("https:// origins");
    }
  });

  it("errors when PUBLIC_BASE_URL is missing", () => {
    const result = resolveBaseConfig({
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("PUBLIC_BASE_URL is not set");
    }
  });

  it("errors when signing key is missing entirely", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("at least 16 chars long");
    }
  });

  it("errors when signing key is shorter than 16 chars", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: "tooshort",
    });
    expect("error" in result).toBe(true);
  });

  it("errors when PUBLIC_BASE_URL is not a valid URL", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "not a url",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not a valid URL");
    }
  });

  it("rejects http:// PUBLIC_BASE_URL for non-localhost hosts", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "http://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("https://");
    }
  });

  it("accepts http:// PUBLIC_BASE_URL for localhost (development)", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "http://localhost:3000",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("ok" in result).toBe(true);
  });

  it("rejects ftp:// PUBLIC_BASE_URL even on localhost", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "ftp://localhost:3000",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
  });

  it("rejects ws:// PUBLIC_BASE_URL even on localhost", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "ws://localhost:3000",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
  });

  it("rejects schemeless 'localhost:3000' (parses as protocol=localhost:)", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "localhost:3000",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("error" in result).toBe(true);
  });

  it("accepts http:// PUBLIC_BASE_URL for 127.0.0.1 (development)", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
    });
    expect("ok" in result).toBe(true);
  });

  it("errors when PORT is not numeric", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      PORT: "abc",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("PORT must be an integer");
    }
  });

  it("errors when PORT is 0 (out of range)", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      PORT: "0",
    });
    expect("error" in result).toBe(true);
  });

  it("errors when PORT is above 65535", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      PORT: "70000",
    });
    expect("error" in result).toBe(true);
  });

  it("errors when PORT is a non-integer like 80.5", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "https://example.run.app",
      MCP_OAUTH_SIGNING_KEY: VALID_KEY,
      PORT: "80.5",
    });
    expect("error" in result).toBe(true);
  });
});

// ── resolveListenHost ───────────────────────────────────────────────────────
//
// The loopback check in selectMode only inspects the PUBLIC_BASE_URL
// string; the security review reproduced insecure-auto-approve mode with
// a localhost URL still accepting POST /register on the machine's LAN
// address. These pin that the SOCKET now matches the URL's intent.

describe("resolveListenHost", () => {
  const insecure: Mode = { kind: "insecure-auto-approve" };
  const staticClient: Mode = {
    kind: "static-client",
    clientId: "id",
    clientSecret: "secret-of-at-least-sixteen",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  };

  it("insecure mode + localhost URL binds IPv4 loopback, not every interface", () => {
    expect(resolveListenHost({}, insecure, "http://localhost:8080")).toEqual({ ok: "127.0.0.1" });
    expect(resolveListenHost({}, insecure, "http://127.0.0.1:8080")).toEqual({ ok: "127.0.0.1" });
  });

  it("insecure mode acknowledged for a non-loopback URL keeps binding every interface", () => {
    const env = { MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "yes" };
    expect(resolveListenHost(env, insecure, "https://mcp.internal.example")).toEqual({
      ok: undefined,
    });
  });

  it("static-client mode binds every interface (container platforms need it)", () => {
    expect(resolveListenHost({}, staticClient, "https://mcp.example.com")).toEqual({
      ok: undefined,
    });
  });

  it("MCP_HTTP_HOST is honoured in static-client mode", () => {
    expect(
      resolveListenHost({ MCP_HTTP_HOST: "127.0.0.1" }, staticClient, "https://x.example"),
    ).toEqual({
      ok: "127.0.0.1",
    });
    expect(resolveListenHost({ MCP_HTTP_HOST: " :: " }, staticClient, "https://x.example")).toEqual(
      {
        ok: "::",
      },
    );
  });

  it("refuses a non-loopback MCP_HTTP_HOST in insecure mode without the acknowledgement", () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.10"]) {
      const result = resolveListenHost({ MCP_HTTP_HOST: host }, insecure, "http://localhost:8080");
      expect("error" in result, host).toBe(true);
      if ("error" in result) expect(result.error).toMatch(/MCP_OAUTH_I_KNOW_WHAT_IM_DOING/);
    }
  });

  it("allows a non-loopback MCP_HTTP_HOST in insecure mode once acknowledged (e.g. a published container port)", () => {
    const env = { MCP_HTTP_HOST: "0.0.0.0", MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "YES" };
    expect(resolveListenHost(env, insecure, "http://localhost:8080")).toEqual({ ok: "0.0.0.0" });
  });

  it("allows an explicit loopback MCP_HTTP_HOST in insecure mode without acknowledgement", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1"]) {
      expect(resolveListenHost({ MCP_HTTP_HOST: host }, insecure, "http://localhost:8080")).toEqual(
        {
          ok: host,
        },
      );
    }
  });

  it("rejects a MCP_HTTP_HOST that is neither an IP literal nor localhost", () => {
    for (const host of [
      "localhost",
      "example.com",
      "localhost.evil.example",
      "0.0.0.0:80",
      "[::1]",
      "127.1",
    ]) {
      const result = resolveListenHost({ MCP_HTTP_HOST: host }, staticClient, "https://x.example");
      expect("error" in result, host).toBe(true);
    }
    // An empty / whitespace-only value counts as unset.
    expect(resolveListenHost({ MCP_HTTP_HOST: "  " }, insecure, "http://localhost:1")).toEqual({
      ok: "127.0.0.1",
    });
  });
});

describe("isLoopbackAddress", () => {
  it("accepts localhost, ::1 and the whole 127/8 block; rejects everything else", () => {
    for (const ok of ["localhost", "::1", "127.0.0.1", "127.255.0.9"])
      expect(isLoopbackAddress(ok), ok).toBe(true);
    for (const no of [
      "0.0.0.0",
      "::",
      "203.0.113.1",
      "::ffff:127.0.0.1",
      "127.example.com",
      "localhost.",
    ]) {
      expect(isLoopbackAddress(no), no).toBe(false);
    }
  });
});

describe("resolveBaseConfig — http://[::1]", () => {
  it("refuses http://[::1] with a clear message (the SDK would crash on it)", () => {
    const result = resolveBaseConfig({
      PUBLIC_BASE_URL: "http://[::1]:8080",
      MCP_OAUTH_SIGNING_KEY: "x".repeat(32),
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/http:\/\/localhost/);
  });
});

describe("resolveBaseConfig — issuer shape", () => {
  it("refuses a PUBLIC_BASE_URL with a query string or fragment (the OAuth layer would crash)", () => {
    for (const url of [
      "https://mcp.example.com/?a=1",
      "https://mcp.example.com/#frag",
      // Empty query/fragment: `search`/`hash` parse to "" but the raw
      // character would still be glued into every derived URL.
      "https://mcp.example.com/?",
      "https://mcp.example.com#",
    ]) {
      const result = resolveBaseConfig({
        PUBLIC_BASE_URL: url,
        MCP_OAUTH_SIGNING_KEY: "x".repeat(32),
      });
      expect("error" in result, url).toBe(true);
    }
  });
});

describe("resolveListenHost — https loopback URLs", () => {
  it("binds 127.0.0.1 for every loopback issuer; a proxy upstream on [::1] opts in via MCP_HTTP_HOST", () => {
    for (const url of ["https://[::1]:8443", "https://localhost:8443", "https://127.0.0.1:8443"]) {
      expect(resolveListenHost({}, { kind: "insecure-auto-approve" }, url), url).toEqual({
        ok: "127.0.0.1",
      });
    }
    expect(
      resolveListenHost(
        { MCP_HTTP_HOST: "::1" },
        { kind: "insecure-auto-approve" },
        "https://[::1]:8443",
      ),
    ).toEqual({ ok: "::1" });
  });
});
