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

describe("listProjects", () => {
  it("returns projects and nextPage (Capsule kases key normalized)", async () => {
    mockFetch(
      200,
      { kases: [{ id: 1, name: "Website Rebuild" }] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/kases?page=2&perPage=25>; rel="next"',
      },
    );

    const { listProjects } = await import("../src/tools/projects.js");
    const result = await listProjects({ page: 1, perPage: 25 });

    expect(result.projects).toHaveLength(1);
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

    expect((result as { project: { name: string } }).project.name).toBe("Onboarding");
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

  it("maps partyId → party:{id} for re-parenting a project (v1.6.3)", async () => {
    // Production bug report shape (same class as the v1.6.3
    // update_opportunity.partyId gap): the partyId field was silently
    // dropped by Zod because it wasn't on the update schema. Wire-trace
    // confirmed Capsule accepts {party: {id}} on PUT /kases/:id and
    // rejects {party: null} with 422 "party is required".
    mockFetch(200, { kase: { id: 10 } });
    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, partyId: 99 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("/kases/10");
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.party).toEqual({ id: 99 });
    expect(body.kase.partyId).toBeUndefined();
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
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
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

  // ── v1.6.5: nullable stageId on update_project ────────────────────────
  it("sends stage:null when stageId=null (remove project from all stages)", async () => {
    // Verified empirically in v1.6.5 wire-trace probe B1: Capsule accepts
    // stage: null on PUT /kases/:id and the project drops off all boards.
    // No RMW needed because the caller's intent is explicit.
    mockFetch(200, { kase: { id: 10 } });

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, stageId: null });

    // No RMW — only stageId is being changed, no ownerId touch.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    expect((options as RequestInit).method).toBe("PUT");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase).toHaveProperty("stage", null);
  });

  it("explicit stageId: null + ownerId touch: null wins over RMW carry-forward", async () => {
    // Subtle interaction: ownerId-touched fires the defensive RMW which
    // would normally carry the *current* stage into the body. But when
    // stageId is explicitly null, the caller's intent (clear stage)
    // must dominate over the RMW carry.
    mockFetch(200, { kase: { id: 10, stage: { id: 99 } } }); // GET
    mockFetch(200, { kase: { id: 10 } }); // PUT

    const { updateProject } = await import("../src/tools/projects.js");
    await updateProject({ id: 10, ownerId: 7, stageId: null });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.kase.owner).toEqual({ id: 7 });
    // The current stage (99) is in the GET response but does NOT
    // leak into the PUT body — explicit null wins.
    expect(body.kase).toHaveProperty("stage", null);
  });
});

// ── v1.6.5: fields[] on create_project ──────────────────────────────────
describe("createProject fields[] support (v1.6.5)", () => {
  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}] on create", async () => {
    // Verified empirically in v1.6.5 wire-trace probe C-kase: Capsule's
    // POST /kases accepts the same fields[] shape as PUT, eliminating
    // the create-then-update ritual for custom-field writes.
    mockFetch(201, { kase: { id: 10, name: "Project" } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({
      name: "Project",
      partyId: 1,
      fields: [{ definitionId: 99, value: "v165 sample" }],
    });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase.fields).toEqual([{ definition: { id: 99 }, value: "v165 sample" }]);
    expect(body.kase.fields[0].definitionId).toBeUndefined();
  });

  it("omits the fields key when no custom fields are supplied", async () => {
    mockFetch(201, { kase: { id: 10 } });

    const { createProject } = await import("../src/tools/projects.js");
    await createProject({ name: "Project", partyId: 1 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.kase).not.toHaveProperty("fields");
  });
});

// ── v1.6.5: batch_update_project ────────────────────────────────────────
describe("batchUpdateProject (v1.6.5)", () => {
  it("fans out one updateProject PUT per item, returning aggregated results", async () => {
    // Mirrors batch_update_party and batch_update_opportunity — same
    // defineBatch shape, same { results, summary } response envelope.
    mockFetch(200, { kase: { id: 1, name: "Alpha" } });
    mockFetch(200, { kase: { id: 2, name: "Beta" } });

    const { batchUpdateProject } = await import("../src/tools/projects.js");
    const result = await batchUpdateProject({
      items: [
        { id: 1, name: "Alpha" },
        { id: 2, name: "Beta" },
      ],
    });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/kases/1"))).toBe(true);
    expect(urls.some((u) => u.includes("/kases/2"))).toBe(true);
    expect(result.summary).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
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

  it("splits >10 ids into chunks, propagates embed, and merges projects", async () => {
    mockFetch(200, { kases: Array.from({ length: 10 }, (_v, i) => ({ id: i + 1 })) });
    mockFetch(200, { kases: [{ id: 11 }] });

    const { getProjects } = await import("../src/tools/projects.js");
    const ids = Array.from({ length: 11 }, (_v, i) => i + 1);
    const result = (await getProjects({ ids, embed: "tags,fields" })) as {
      projects: Array<{ id: number }>;
    };

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/kases/1,2,3,4,5,6,7,8,9,10");
    expect(urls[1]).toContain("/kases/11");
    expect(urls.every((u) => u.includes("embed=tags%2Cfields"))).toBe(true);
    expect(result.projects.map((p) => p.id)).toEqual(ids);
  });
});
