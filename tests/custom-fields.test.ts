import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

function mockFetch(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("listCustomFields", () => {
  it("GETs /<entity>/fields/definitions per entity type", async () => {
    mockFetch(200, { definitions: [{ id: 1, name: "Member State", type: "list" }] });
    const { listCustomFields } = await import("../src/tools/custom-fields.js");
    const result = await listCustomFields({ entity: "parties" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/fields/definitions");
    expect(result.definitions).toHaveLength(1);
  });

  it("uses /kases for projects", async () => {
    mockFetch(200, { definitions: [] });
    const { listCustomFields } = await import("../src/tools/custom-fields.js");
    await listCustomFields({ entity: "kases" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/fields/definitions");
  });
});

describe("getCustomField", () => {
  it("GETs /<entity>/fields/definitions/{id}", async () => {
    mockFetch(200, { definition: { id: 910997, name: "Member State" } });
    const { getCustomField } = await import("../src/tools/custom-fields.js");
    const result = await getCustomField({
      entity: "parties",
      fieldId: 910997,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/fields/definitions/910997");
    expect((result as { definition: { id: number } }).definition.id).toBe(910997);
  });
});
