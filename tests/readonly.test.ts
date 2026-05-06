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

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_READONLY"];
});

describe("isReadOnly", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["YES", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["", false],
    [undefined, false],
  ])("CAPSULE_MCP_READONLY=%j → %s", async (value, expected) => {
    if (value === undefined) {
      delete process.env["CAPSULE_MCP_READONLY"];
    } else {
      process.env["CAPSULE_MCP_READONLY"] = value;
    }
    const { isReadOnly } = await import("../src/capsule/client.js");
    expect(isReadOnly()).toBe(expected);
  });
});

describe("read-only client guard", () => {
  beforeEach(() => {
    process.env["CAPSULE_MCP_READONLY"] = "1";
  });

  it("blocks POST without making any HTTP call", async () => {
    const { createParty } = await import("../src/tools/parties.js");
    await expect(createParty({ type: "person", firstName: "X" })).rejects.toThrow(
      /read-only mode/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks PUT without making any HTTP call", async () => {
    const { updateParty } = await import("../src/tools/parties.js");
    await expect(updateParty({ id: 1, jobTitle: "X" })).rejects.toThrow(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks DELETE without making any HTTP call", async () => {
    const { deleteParty } = await import("../src/tools/parties.js");
    await expect(deleteParty({ id: 1, confirm: true })).rejects.toThrow(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("still allows GET", async () => {
    mockFetch(200, { party: { id: 1 } });
    const { getParty } = await import("../src/tools/parties.js");
    const result = await getParty({ id: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });
});
