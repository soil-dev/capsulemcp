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

describe("searchOpportunities", () => {
  it("routes to /opportunities/search when q is provided", async () => {
    mockFetch(200, { opportunities: [{ id: 1, name: "Big Deal" }] });

    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    await searchOpportunities({ q: "deal", page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/search");
    expect(url).toContain("q=deal");
  });

  it("routes to /opportunities when q is omitted", async () => {
    mockFetch(
      200,
      { opportunities: [] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/opportunities?page=2&perPage=25>; rel="next"',
      },
    );

    const { searchOpportunities } = await import("../src/tools/opportunities.js");
    const result = await searchOpportunities({ page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities?");
    expect(url).not.toContain("/search");
    expect(result.nextPage).toBe(2);
  });
});

describe("getOpportunity", () => {
  it("returns the opportunity", async () => {
    mockFetch(200, { opportunity: { id: 7, name: "Renewal" } });

    const { getOpportunity } = await import("../src/tools/opportunities.js");
    const result = await getOpportunity({ id: 7 });

    expect((result as { opportunity: { name: string } }).opportunity.name).toBe("Renewal");
  });
});

describe("createOpportunity", () => {
  it("posts with nested party and milestone objects", async () => {
    mockFetch(201, { opportunity: { id: 20, name: "New Deal" } });

    const { createOpportunity } = await import("../src/tools/opportunities.js");
    await createOpportunity({ name: "New Deal", partyId: 1, milestoneId: 3 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);

    expect(body.opportunity.party).toEqual({ id: 1 });
    expect(body.opportunity.milestone).toEqual({ id: 3 });
  });

  it("maps teamId → team:{id} in the request body", async () => {
    mockFetch(201, { opportunity: { id: 20, team: { id: 88, name: "Sales" } } });

    const { createOpportunity } = await import("../src/tools/opportunities.js");
    await createOpportunity({ name: "New Deal", partyId: 1, milestoneId: 3, teamId: 88 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.opportunity.team).toEqual({ id: 88 });
    // user-facing field name doesn't leak into the API body
    expect(body.opportunity.teamId).toBeUndefined();
  });

  it("sends both owner and team when ownerId+teamId supplied (USER+TEAM ownership shape)", async () => {
    // Production workflow: assign opportunity to a specific user AND
    // make it visible to a team. Capsule supports this shape natively
    // — owner must be a member of the team or returns 422, but the API
    // accepts both fields on create.
    mockFetch(201, { opportunity: { id: 20 } });

    const { createOpportunity } = await import("../src/tools/opportunities.js");
    await createOpportunity({
      name: "Joint Deal",
      partyId: 1,
      milestoneId: 3,
      ownerId: 7,
      teamId: 88,
    });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.opportunity.owner).toEqual({ id: 7 });
    expect(body.opportunity.team).toEqual({ id: 88 });
  });
});

describe("deleteOpportunity", () => {
  it("issues DELETE /opportunities/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteOpportunity } = await import("../src/tools/opportunities.js");
    const result = await deleteOpportunity({ id: 21, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/21");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 21 });
  });
});

describe("updateOpportunity", () => {
  it("puts only the provided fields", async () => {
    mockFetch(200, { opportunity: { id: 20, probability: 80 } });

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, probability: 80 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/opportunities/20");
    expect((options as RequestInit).method).toBe("PUT");
  });

  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}]", async () => {
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({
      id: 20,
      fields: [
        { definitionId: 5, value: "2025-11-28" },
        { definitionId: 6, value: null },
      ],
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.opportunity.fields).toEqual([
      { definition: { id: 5 }, value: "2025-11-28" },
      { definition: { id: 6 }, value: null },
    ]);
  });

  it("maps lostReasonId → lostReason:{id} for Lost closes", async () => {
    // Production bug report: lostReason couldn't be set at all via this
    // connector, so every connector-driven Lost-close left lostReason
    // null. Now plumbed as a top-level param mirroring ownerId.
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, milestoneId: 7, lostReasonId: 42 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.opportunity.milestone).toEqual({ id: 7 });
    expect(body.opportunity.lostReason).toEqual({ id: 42 });
    // user-facing field name doesn't leak into the API body
    expect(body.opportunity.lostReasonId).toBeUndefined();
  });

  it("maps teamId → team:{id} in the request body (no defensive read when teamId is explicit)", async () => {
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, teamId: 88 });

    // One call: PUT only. No GET because ownerId is undefined.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("/opportunities/20");
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.opportunity.team).toEqual({ id: 88 });
    expect(body.opportunity.teamId).toBeUndefined();
  });

  it("teamId: null clears the team", async () => {
    mockFetch(200, { opportunity: { id: 20 } });
    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, teamId: null });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.opportunity).toHaveProperty("team", null);
  });

  it("ownerId alone preserves the existing team via read-modify-write (regression for §27 asymmetric PUT)", async () => {
    // Capsule's PUT on /opportunities mirrors /kases: setting `owner`
    // alone clears `team` server-side. Reported as a production bug:
    // a bulk owner-reassignment stripped team affiliation across
    // multiple opportunities. The fix is the same defensive read
    // used by update_project: when ownerId is touched and teamId is
    // omitted, fetch the current team and carry it forward in the
    // PUT body.
    mockFetch(200, { opportunity: { id: 20, team: { id: 42, name: "Ops" } } }); // GET
    mockFetch(200, { opportunity: { id: 20 } }); // PUT

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, ownerId: 7 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [getUrl, getOptions] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(getUrl)).toMatch(/\/opportunities\/20($|\?)/);
    expect((getOptions as RequestInit).method ?? "GET").toBe("GET");

    const [putUrl, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(putUrl)).toContain("/opportunities/20");
    expect((putOptions as RequestInit).method).toBe("PUT");
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.opportunity.owner).toEqual({ id: 7 });
    // Team preserved from the GET — without this, Capsule would clear it.
    expect(body.opportunity.team).toEqual({ id: 42 });
  });

  it("ownerId alone with currentTeam=null: PUT body omits team (no spurious clear)", async () => {
    // When the opp has no team to begin with, the read still happens
    // but no team is carried forward — sending team: null would be a
    // redundant clear.
    mockFetch(200, { opportunity: { id: 20, team: null } }); // GET
    mockFetch(200, { opportunity: { id: 20 } }); // PUT

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, ownerId: 7 });

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.opportunity.owner).toEqual({ id: 7 });
    expect(body.opportunity).not.toHaveProperty("team");
  });

  it("ownerId + explicit teamId: explicit teamId wins, no defensive GET", async () => {
    // Both fields explicit → no need to fetch current state.
    mockFetch(200, { opportunity: { id: 20 } });

    const { updateOpportunity } = await import("../src/tools/opportunities.js");
    await updateOpportunity({ id: 20, ownerId: 7, teamId: 88 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.opportunity.owner).toEqual({ id: 7 });
    expect(body.opportunity.team).toEqual({ id: 88 });
  });
});

describe("OpportunityValueSchema custom error", () => {
  it("emits an operator-readable message when currency is missing (amount supplied)", async () => {
    const { createOpportunitySchema } = await import("../src/tools/opportunities.js");
    const r = createOpportunitySchema.safeParse({
      name: "X",
      partyId: 1,
      milestoneId: 1,
      value: { amount: 100 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "value.currency");
      expect(issue?.message).toBe(
        "currency is required when amount is set (3-letter ISO 4217 code, e.g. 'USD', 'EUR', 'GBP')",
      );
    }
  });

  it("falls through to the default Zod message on length violation", async () => {
    const { createOpportunitySchema } = await import("../src/tools/opportunities.js");
    const r = createOpportunitySchema.safeParse({
      name: "X",
      partyId: 1,
      milestoneId: 1,
      value: { amount: 100, currency: "GB" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "value.currency");
      // The custom error is scoped to missing-field; length/type errors
      // still get Zod defaults so callers see exactly which constraint failed.
      expect(issue?.message).not.toMatch(/required when amount is set/);
      expect(issue?.message).toMatch(/Too small/);
    }
  });
});

describe("getOpportunities (batch)", () => {
  it("GETs /opportunities/{ids}", async () => {
    mockFetch(200, { opportunities: [{ id: 1 }] });
    const { getOpportunities } = await import("../src/tools/opportunities.js");
    await getOpportunities({ ids: [1, 2, 3] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/opportunities\/1,2,3($|\?)/);
  });
});
