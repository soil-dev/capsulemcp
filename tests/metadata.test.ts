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

describe("listTeams", () => {
  it("GETs /teams and returns the response body", async () => {
    mockFetch(200, { teams: [{ id: 1, name: "Sales" }] });
    const { listTeams } = await import("../src/tools/metadata.js");
    const result = await listTeams({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/teams");
    expect(result.teams).toHaveLength(1);
  });
});

describe("listLostReasons", () => {
  it("GETs /lostreasons and surfaces the lostReasons key (camelCase)", async () => {
    mockFetch(200, { lostReasons: [{ id: 1, name: "Price" }] });
    const { listLostReasons } = await import("../src/tools/metadata.js");
    const result = await listLostReasons({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/lostreasons");
    expect(result.lostReasons).toHaveLength(1);
  });
});

describe("listActivityTypes", () => {
  it("GETs /activitytypes and surfaces the activityTypes key (camelCase)", async () => {
    mockFetch(200, { activityTypes: [{ id: 1, name: "Call" }] });
    const { listActivityTypes } = await import("../src/tools/metadata.js");
    const result = await listActivityTypes({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/activitytypes");
    expect(result.activityTypes).toHaveLength(1);
  });
});

describe("getSite", () => {
  it("GETs /site and returns the site object", async () => {
    mockFetch(200, { site: { name: "Acme", subdomain: "acme" } });
    const { getSite } = await import("../src/tools/metadata.js");
    const result = await getSite({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/site");
    expect((result as { site: { subdomain: string } }).site.subdomain).toBe("acme");
  });
});

describe("listTrackDefinitions", () => {
  it("GETs /trackdefinitions and surfaces the trackDefinitions key (camelCase)", async () => {
    mockFetch(200, {
      trackDefinitions: [{ id: 1, description: "Onboard", taskDefinitions: [] }],
    });
    const { listTrackDefinitions } = await import("../src/tools/metadata.js");
    const result = await listTrackDefinitions({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/trackdefinitions");
    expect(result.trackDefinitions).toHaveLength(1);
  });
});

describe("listCategories", () => {
  it("GETs /categories", async () => {
    mockFetch(200, { categories: [{ id: 1, name: "Call", colour: "#EF4444" }] });
    const { listCategories } = await import("../src/tools/metadata.js");
    const result = await listCategories({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/categories");
    expect(result.categories).toHaveLength(1);
  });
});

describe("listGoals", () => {
  it("GETs /goals (returns empty list when none configured)", async () => {
    mockFetch(200, { goals: [] });
    const { listGoals } = await import("../src/tools/metadata.js");
    const result = await listGoals({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/goals");
    expect(result.goals).toEqual([]);
  });
});

describe("metadata pagination", () => {
  it("listTeams defaults perPage=100 to maximise single-page coverage", async () => {
    mockFetch(200, { teams: [] });
    const { listTeams } = await import("../src/tools/metadata.js");
    await listTeams({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("perPage=100");
    expect(url).toContain("page=1");
  });

  it("listTeams surfaces nextPage when Capsule returns Link header", async () => {
    mockFetch(
      200,
      { teams: [{ id: 1 }] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/teams?page=2&perPage=100>; rel="next"',
      },
    );
    const { listTeams } = await import("../src/tools/metadata.js");
    const result = await listTeams({});
    expect(result.nextPage).toBe(2);
  });

  it("listCategories accepts explicit page/perPage overrides", async () => {
    mockFetch(200, { categories: [] });
    const { listCategories } = await import("../src/tools/metadata.js");
    await listCategories({ page: 2, perPage: 25 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("page=2");
    expect(url).toContain("perPage=25");
  });
});
