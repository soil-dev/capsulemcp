import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => "",
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
  delete process.env["CAPSULE_MCP_READONLY"];
});

describe("listAdditionalParties", () => {
  it("GETs /opportunities/{id}/parties", async () => {
    mockFetch(200, { parties: [{ id: 1 }] });
    const { listAdditionalParties } = await import(
      "../src/tools/relationships.js"
    );
    await listAdditionalParties({
      entity: "opportunities",
      entityId: 99,
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/99/parties");
  });

  it("uses /kases for projects", async () => {
    mockFetch(200, { parties: [] });
    const { listAdditionalParties } = await import(
      "../src/tools/relationships.js"
    );
    await listAdditionalParties({
      entity: "kases",
      entityId: 7,
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/7/parties");
    expect(url).not.toContain("/projects/");
  });
});

describe("addAdditionalParty", () => {
  it("POSTs to /<entity>/{id}/parties/{partyId}", async () => {
    mockFetch(200, { opportunity: { id: 99 } });
    const { addAdditionalParty } = await import(
      "../src/tools/relationships.js"
    );
    await addAdditionalParty({
      entity: "opportunities",
      entityId: 99,
      partyId: 42,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/99/parties/42");
    expect((init as { method: string }).method).toBe("POST");
  });
});

describe("removeAdditionalParty", () => {
  it("DELETEs to /<entity>/{id}/parties/{partyId} when confirm=true", async () => {
    mockFetch(204, {});
    const { removeAdditionalParty } = await import(
      "../src/tools/relationships.js"
    );
    const result = await removeAdditionalParty({
      entity: "kases",
      entityId: 7,
      partyId: 42,
      confirm: true,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/7/parties/42");
    expect((init as { method: string }).method).toBe("DELETE");
    expect(result.removed).toBe(true);
  });
});

describe("listAssociatedProjects", () => {
  it("GETs /opportunities/{id}/kases (legacy projects path)", async () => {
    mockFetch(200, { kases: [{ id: 5 }] });
    const { listAssociatedProjects } = await import(
      "../src/tools/relationships.js"
    );
    await listAssociatedProjects({
      opportunityId: 99,
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/99/kases");
    expect(url).not.toContain("/projects");
  });
});
