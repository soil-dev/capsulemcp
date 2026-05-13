import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("listEmployees", () => {
  it("GETs /parties/{id}/people and returns parties array", async () => {
    mockFetch(200, { parties: [{ id: 1, type: "person", firstName: "A" }] });
    const { listEmployees } = await import("../src/tools/audit.js");
    const result = await listEmployees({ partyId: 254022688, page: 1, perPage: 25 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/254022688/people");
    expect(result.parties).toHaveLength(1);
  });

  it("propagates pagination and embed", async () => {
    mockFetch(200, { parties: [] });
    const { listEmployees } = await import("../src/tools/audit.js");
    await listEmployees({
      partyId: 1,
      page: 2,
      perPage: 50,
      embed: "tags,fields",
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("page=2");
    expect(url).toContain("perPage=50");
    expect(url).toContain("embed=tags%2Cfields");
  });
});

describe("listDeletedParties", () => {
  it("GETs /parties/deleted with required since parameter", async () => {
    mockFetch(200, { parties: [{ id: 1 }], restrictedParties: [] });
    const { listDeletedParties } = await import("../src/tools/audit.js");
    await listDeletedParties({
      since: "2026-01-01T00:00:00Z",
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/deleted");
    expect(url).toContain("since=2026-01-01T00%3A00%3A00Z");
  });

  it("preserves the restrictedParties sibling key", async () => {
    mockFetch(200, {
      parties: [{ id: 1 }],
      restrictedParties: [{ id: 999, deletedAt: "..." }],
    });
    const { listDeletedParties } = await import("../src/tools/audit.js");
    const result = await listDeletedParties({
      since: "2026-01-01T00:00:00Z",
      page: 1,
      perPage: 25,
    });
    expect(result.restrictedParties).toHaveLength(1);
  });
});

describe("listDeletedOpportunities", () => {
  it("GETs /opportunities/deleted", async () => {
    mockFetch(200, { opportunities: [], restrictedOpportunities: [] });
    const { listDeletedOpportunities } = await import("../src/tools/audit.js");
    await listDeletedOpportunities({
      since: "2026-01-01T00:00:00Z",
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/deleted");
  });
});

describe("listDeletedProjects", () => {
  it("GETs /kases/deleted (Capsule's legacy projects path)", async () => {
    mockFetch(200, { kases: [], restrictedKases: [] });
    const { listDeletedProjects } = await import("../src/tools/audit.js");
    await listDeletedProjects({
      since: "2026-01-01T00:00:00Z",
      page: 1,
      perPage: 25,
    });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/deleted");
    expect(url).not.toContain("/projects/");
  });
});
