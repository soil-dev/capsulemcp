import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

function mockFetch(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

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
