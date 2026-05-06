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

describe("listTags", () => {
  it.each([
    ["parties", "/parties/tags"],
    ["opportunities", "/opportunities/tags"],
    ["kases", "/kases/tags"],
  ] as const)("calls the correct endpoint for %s", async (entity, expectedPath) => {
    mockFetch(200, { tags: [{ id: 1, name: "VIP" }] });

    const { listTags } = await import("../src/tools/tags.js");
    await listTags({ entity });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain(expectedPath);
  });
});
