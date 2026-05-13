import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
afterEach(() => { vi.clearAllMocks(); delete process.env["CAPSULE_API_TOKEN"]; });

describe("listUsers", () => {
  it("returns users array", async () => {
    mockFetch(200, { users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] });

    const { listUsers } = await import("../src/tools/users.js");
    const result = await listUsers({});

    expect((result as { users: unknown[] }).users).toHaveLength(2);
  });

  it("calls GET /users", async () => {
    mockFetch(200, { users: [] });

    const { listUsers } = await import("../src/tools/users.js");
    await listUsers({});

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/users");
    expect(vi.mocked(fetch).mock.calls[0]![1]).not.toHaveProperty("method");
  });
});

describe("getCurrentUser", () => {
  it("hits /users/current (NOT /users/me — see NOTES-ON-CAPSULE-API.md §5)", async () => {
    mockFetch(200, { user: { id: 643698, username: "anton" } });

    const { getCurrentUser } = await import("../src/tools/users.js");
    const result = await getCurrentUser({});

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/users/current");
    expect(url).not.toContain("/users/me");
    expect((result as { user: { username: string } }).user.username).toBe(
      "anton",
    );
  });
});
