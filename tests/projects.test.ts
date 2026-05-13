import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
afterEach(() => { vi.clearAllMocks(); delete process.env["CAPSULE_API_TOKEN"]; });

describe("listProjects", () => {
  it("returns kases and nextPage", async () => {
    mockFetch(200, { kases: [{ id: 1, name: "Website Rebuild" }] }, {
      Link: '<https://api.capsulecrm.com/api/v2/kases?page=2&perPage=25>; rel="next"',
    });

    const { listProjects } = await import("../src/tools/projects.js");
    const result = await listProjects({ page: 1, perPage: 25 });

    expect(result.kases).toHaveLength(1);
    expect(result.nextPage).toBe(2);
  });

  it("passes status filter to query params", async () => {
    mockFetch(200, { kases: [] });

    const { listProjects } = await import("../src/tools/projects.js");
    await listProjects({ status: "OPEN", page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("status=OPEN");
  });
});

describe("getProject", () => {
  it("returns the project", async () => {
    mockFetch(200, { kase: { id: 3, name: "Onboarding" } });

    const { getProject } = await import("../src/tools/projects.js");
    const result = await getProject({ id: 3 });

    expect((result as { kase: { name: string } }).kase.name).toBe("Onboarding");
  });
});

describe("createProject", () => {
  it("posts to /kases with nested party", async () => {
    mockFetch(201, { kase: { id: 10, name: "Migration" } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Migration", partyId: 5 });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.party).toEqual({ id: 5 });
    // No stage when stageId is omitted — Capsule will leave the project
    // unassigned to any board.
    expect(body.kase.stage).toBeUndefined();
  });

  it("maps stageId → stage:<integer> in the request body", async () => {
    mockFetch(201, { kase: { id: 10, stage: { id: 42, name: "Discovery" } } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Onboarding", partyId: 5, stageId: 42 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    // Capsule's create-case body uses bare integer per docs example.
    expect(body.kase.stage).toBe(42);
    // The user-facing stageId field doesn't leak into the API body.
    expect(body.kase.stageId).toBeUndefined();
  });

  it("maps teamId → team:{id} in the request body", async () => {
    mockFetch(201, { kase: { id: 10, team: { id: 88, name: "Ops" } } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Onboarding", partyId: 5, teamId: 88 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.team).toEqual({ id: 88 });
    expect(body.kase.teamId).toBeUndefined();
  });

  it("accepts ownerId + stageId together — Capsule's API allows it; any owner-clearing is tenant board automation, not the API", async () => {
    // Earlier alpha.{17,18,19} releases rejected this combo based on
    // observations from a tenant whose board automation cleared `owner`
    // on project creation. The alpha.19R re-verification (with the
    // automation disabled) confirmed Capsule's API itself preserves
    // ownerId across the call. We no longer reject; we serialize and
    // let the tenant's actual behaviour surface in the response.
    mockFetch(201, { kase: { id: 10, owner: { id: 7 }, stage: { id: 42 } } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({
      name: "Onboarding",
      partyId: 5,
      ownerId: 7,
      stageId: 42,
    });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.stage).toBe(42);
  });

  it("sends both owner and team when ownerId+teamId supplied (USER+TEAM ownership shape)", async () => {
    mockFetch(201, { kase: { id: 10 } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({
      name: "Onboarding",
      partyId: 5,
      ownerId: 7,
      teamId: 88,
    });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.team).toEqual({ id: 88 });
  });
});

describe("deleteProject", () => {
  it("issues DELETE /kases/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteProject } = await import("../src/tools/projects.js");
    const result = await deleteProject({ id: 11, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/11");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 11 });
  });
});

describe("updateProject", () => {
  it("puts only the provided fields to /kases/:id", async () => {
    mockFetch(200, { kase: { id: 10, status: "CLOSED" } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, status: "CLOSED" });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/10");
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase).toEqual({ status: "CLOSED" });
  });

  it("maps ownerId to nested owner object, preserving current team AND stage via read-modify-write", async () => {
    // RMW: ownerId-touched + teamId-undefined → fetch current, carry
    // both team AND stage forward (alpha.20 verification flagged that
    // stage may be silently cleared the same way team is, since both
    // are absent-in-body fields on Capsule's PUT).
    mockFetch(200, {
      kase: { id: 10, team: { id: 42, name: "Ops" }, stage: { id: 99, name: "Live" } },
    }); // GET
    mockFetch(200, { kase: { id: 10 } }); // PUT

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [getUrl, getOptions] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(getUrl)).toMatch(/\/kases\/10($|\?)/);
    expect((getOptions as RequestInit).method ?? "GET").toBe("GET");

    const [putUrl, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(putUrl)).toContain("/kases/10");
    expect((putOptions as RequestInit).method).toBe("PUT");
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    // Team and stage both preserved from the GET.
    expect(body.kase.team).toEqual({ id: 42 });
    expect(body.kase.stage).toBe(99);
    expect(body.kase.ownerId).toBeUndefined();
    expect(body.kase.stageId).toBeUndefined();
  });

  it("ownerId-only with currentTeam=null AND currentStage=null: PUT body omits both (no spurious clears)", async () => {
    mockFetch(200, { kase: { id: 10, team: null, stage: null } }); // GET
    mockFetch(200, { kase: { id: 10 } }); // PUT

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7 });

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase).not.toHaveProperty("team");
    expect(body.kase).not.toHaveProperty("stage");
  });

  it("ownerId + explicit stageId: explicit stageId wins, no current-stage carry from RMW", async () => {
    // ownerId touched, teamId undefined → RMW fires for team. stageId
    // is explicitly supplied, so the RMW shouldn't override it with the
    // current value.
    mockFetch(200, { kase: { id: 10, team: { id: 42 }, stage: { id: 99 } } });
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7, stageId: 123 });

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.team).toEqual({ id: 42 });
    expect(body.kase.stage).toBe(123); // explicit, not the carried 99
  });

  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}]", async () => {
    mockFetch(200, { kase: { id: 10 } });
    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({
      id: 10,
      fields: [
        { definitionId: 2, value: "Premium" },
        { definitionId: 3, value: 365 },
      ],
    });
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.kase.fields).toEqual([
      { definition: { id: 2 }, value: "Premium" },
      { definition: { id: 3 }, value: 365 },
    ]);
  });

  it("maps stageId → stage:<integer> for moving a project across stages", async () => {
    mockFetch(200, { kase: { id: 10, stage: { id: 99, name: "Live" } } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, stageId: 99 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.stage).toBe(99);
    expect(body.kase.stageId).toBeUndefined();
  });

  it("maps teamId → team:{id} on update (no RMW — Capsule preserves owner server-side)", async () => {
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, teamId: 88 });

    // teamId alone: single PUT, no preceding GET (Rule A's team-in-body
    // path preserves owner without help).
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.team).toEqual({ id: 88 });
    expect(body.kase.teamId).toBeUndefined();
  });

  it("ownerId + teamId + stageId together: no RMW (caller has expressed all intents)", async () => {
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7, teamId: 88, stageId: 99 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.team).toEqual({ id: 88 });
    expect(body.kase.stage).toBe(99);
  });

  it("ownerId + teamId together still carries current stage when stageId is omitted", async () => {
    mockFetch(200, { kase: { id: 10, stage: { id: 99 } } });
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7, teamId: 88 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase.team).toEqual({ id: 88 });
    expect(body.kase.stage).toBe(99);
  });

  it("ownerId + teamId:null carries current stage while clearing team", async () => {
    mockFetch(200, { kase: { id: 10, stage: { id: 99 } } });
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7, teamId: null });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [, options] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    expect(body.kase).toHaveProperty("team", null);
    expect(body.kase.stage).toBe(99);
  });

  it("sends owner:null + carries current team when ownerId=null (Unassign owner, keep team)", async () => {
    mockFetch(200, { kase: { id: 10, team: { id: 42, name: "Ops" } } }); // GET
    mockFetch(200, { kase: { id: 10 } }); // PUT

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: null });

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase).toHaveProperty("owner", null);
    // Team carried through so the project doesn't end up with both null
    // (which Capsule rejects with 422 'owner or team is required').
    expect(body.kase.team).toEqual({ id: 42 });
  });

  it("sends team:null when teamId=null (unassign)", async () => {
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, teamId: null });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase).toHaveProperty("team", null);
  });
});

describe("getProjects (batch)", () => {
  it("GETs /kases/{ids} (legacy projects path)", async () => {
    mockFetch(200, { kases: [{ id: 1 }] });
    const { getProjects } = await import("../src/tools/projects.js");
    await getProjects({ ids: [1, 2] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/kases\/1,2($|\?)/);
    expect(url).not.toContain("/projects/");
  });
});
