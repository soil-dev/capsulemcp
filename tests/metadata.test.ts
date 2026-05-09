import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
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

describe("listTeams", () => {
  it("GETs /teams and returns the response body", async () => {
    mockFetch(200, { teams: [{ id: 1, name: "MarCom" }] });
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
