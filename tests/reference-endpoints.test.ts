/**
 * Issue #112 P2: list_activities / list_countries / list_currencies.
 * Endpoint shapes verified live 2026-08-16 (probe + through-tool runs).
 */

import { fetch } from "undici";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("list_countries / list_currencies (cached dictionaries)", () => {
  it("list_countries hits /countries and returns the dictionary", async () => {
    mockFetch(200, { countries: [{ name: "Czechia", alpha2Code: "CZ" }] });
    const { listCountries } = await import("../src/tools/metadata.js");
    const r = (await listCountries()) as { countries: Array<{ name: string }> };
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("/countries");
    expect(r.countries[0]!.name).toBe("Czechia");
  });

  it("list_currencies hits /currencies", async () => {
    mockFetch(200, { currencies: [{ code: "USD", symbol: "$" }] });
    const { listCurrencies } = await import("../src/tools/metadata.js");
    const r = (await listCurrencies()) as { currencies: Array<{ code: string }> };
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("/currencies");
    expect(r.currencies[0]!.code).toBe("USD");
  });
});

describe("list_activities", () => {
  it("forwards since + pagination; normalizes kase refs to project", async () => {
    mockFetch(200, {
      activities: [{ id: 1, activityType: { id: -1, name: "Note" }, kase: { id: 7 }, party: null }],
    });
    const { listActivities } = await import("../src/tools/activities.js");
    const r = (await listActivities({
      since: "2026-08-01T00:00:00Z",
      page: 1,
      perPage: 25,
    })) as { activities: Array<{ project?: { id: number }; kase?: unknown }> };
    const url = String(vi.mocked(fetch).mock.calls[0]![0]);
    expect(url).toContain("/activities");
    expect(url).toContain("since=2026-08-01");
    // Boundary normalization: Capsule's kase ref surfaces as project.
    expect(r.activities[0]!.project).toEqual({ id: 7 });
    expect(r.activities[0]!.kase).toBeUndefined();
  });
});
