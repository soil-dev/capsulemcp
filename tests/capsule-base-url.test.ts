/**
 * Validates that CAPSULE_API_BASE_URL is sanity-checked before any
 * request goes out. Without this gate, a typo'd or hostile env value
 * (`http://evil.example/`) would silently exfiltrate the bearer token
 * to that origin in the Authorization header.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_API_BASE_URL"];
});

async function listUsersExpectingError(): Promise<unknown> {
  const { listUsers } = await import("../src/tools/users.js");
  try {
    await listUsers({});
    throw new Error("expected listUsers to throw");
  } catch (err) {
    return err;
  }
}

describe("CAPSULE_API_BASE_URL validation", () => {
  it("rejects a non-URL value with a clear error and never calls fetch", async () => {
    process.env["CAPSULE_API_BASE_URL"] = "not a url";
    const err = await listUsersExpectingError();
    expect((err as Error).message).toContain("not a valid URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects http:// for non-localhost hosts (would exfiltrate token)", async () => {
    process.env["CAPSULE_API_BASE_URL"] = "http://evil.example/";
    const err = await listUsersExpectingError();
    expect((err as Error).message).toContain("https://");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects ftp:// even on localhost", async () => {
    process.env["CAPSULE_API_BASE_URL"] = "ftp://localhost/";
    const err = await listUsersExpectingError();
    expect(fetch).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts https:// to any host", async () => {
    process.env["CAPSULE_API_BASE_URL"] = "https://api-staging.capsulecrm.com/api/v2";
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({ users: [] }),
      statusText: "200",
    } as Awaited<ReturnType<typeof fetch>>);
    const { listUsers } = await import("../src/tools/users.js");
    await listUsers({});
    expect(fetch).toHaveBeenCalledOnce();
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("api-staging.capsulecrm.com");
  });

  it("accepts http:// for localhost (development / mock server)", async () => {
    process.env["CAPSULE_API_BASE_URL"] = "http://localhost:8080/v2";
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({ users: [] }),
      statusText: "200",
    } as Awaited<ReturnType<typeof fetch>>);
    const { listUsers } = await import("../src/tools/users.js");
    await listUsers({});
    expect(fetch).toHaveBeenCalledOnce();
  });
});
