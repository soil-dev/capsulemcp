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

describe("listTags", () => {
  it.each([
    ["parties", "/parties/tags"],
    ["opportunities", "/opportunities/tags"],
    ["projects", "/kases/tags"],
  ] as const)("calls the correct endpoint for %s", async (entity, expectedPath) => {
    mockFetch(200, { tags: [{ id: 1, name: "VIP" }] });

    const { listTags } = await import("../src/tools/tags.js");
    await listTags({ entity });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain(expectedPath);
  });
});

describe("addTag — atomic attach by name", () => {
  // Capsule resolves by name: existing tag is matched, otherwise
  // created. Body shape is `{<wrapper>: {tags: [{name}]}}` per
  // Capsule's verified PUT contract.
  it.each([
    ["parties", "party", "/parties/284083000"],
    ["opportunities", "opportunity", "/opportunities/19897000"],
    ["projects", "kase", "/kases/5828000"],
  ] as const)(
    "PUTs to /%s/{id} with the correct wrapper key and {name}-only tag item",
    async (entity, wrapper, expectedPath) => {
      mockFetch(200, { [wrapper]: { id: 1 } });
      const { addTag } = await import("../src/tools/tags.js");

      const entityId = Number(expectedPath.split("/").pop());
      await addTag({ entity, entityId, tagName: "VIP" });

      const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toContain(expectedPath);
      expect((opts as RequestInit).method).toBe("PUT");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body[wrapper].tags).toEqual([{ name: "VIP" }]);
      // No id, no _delete on an add
      expect(body[wrapper].tags[0].id).toBeUndefined();
      expect(body[wrapper].tags[0]._delete).toBeUndefined();
    },
  );

  it("rejects empty tagName at the schema layer", async () => {
    const { addTagSchema } = await import("../src/tools/tags.js");
    expect(addTagSchema.safeParse({ entity: "parties", entityId: 1, tagName: "" }).success).toBe(
      false,
    );
  });

  it("rejects Capsule's legacy 'kases' entity value at the schema layer (v2: say 'projects')", async () => {
    const { addTagSchema } = await import("../src/tools/tags.js");
    expect(
      addTagSchema.safeParse({
        entity: "kases" as never, // v2 surface says 'projects'; 'kases' is wire-internal
        entityId: 1,
        tagName: "X",
      }).success,
    ).toBe(false);
    expect(addTagSchema.safeParse({ entity: "projects", entityId: 1, tagName: "X" }).success).toBe(
      true,
    );
  });
});

describe("removeTagById — idempotency on already-detached", () => {
  it("converts Capsule's 422 'tag not found to delete' into alreadyRemoved: true", async () => {
    mockFetch(422, {
      errors: [{ resource: "party.tags", message: "tag not found to delete" }],
    });
    const { removeTagById } = await import("../src/tools/tags.js");
    const result = await removeTagById({
      entity: "parties",
      entityId: 99,
      tagId: 42,
    });
    expect(result.removed).toBe(true);
    expect(result.alreadyRemoved).toBe(true);
    expect(result.tagId).toBe(42);
  });

  it("propagates other 422s (e.g. validation failure unrelated to existing links)", async () => {
    mockFetch(422, { message: "some other validation failed" });
    const { removeTagById } = await import("../src/tools/tags.js");
    await expect(removeTagById({ entity: "parties", entityId: 99, tagId: 42 })).rejects.toThrow(
      /some other validation failed/,
    );
  });
});

describe("removeTagById — atomic detach by per-entity link id", () => {
  it.each([
    ["parties", "party", "/parties/284083000"],
    ["opportunities", "opportunity", "/opportunities/19897000"],
    ["projects", "kase", "/kases/5828000"],
  ] as const)("PUTs {id, _delete:true} on /%s/{id}", async (entity, wrapper, expectedPath) => {
    mockFetch(200, { [wrapper]: { id: 1 } });
    const { removeTagById } = await import("../src/tools/tags.js");

    const entityId = Number(expectedPath.split("/").pop());
    await removeTagById({ entity, entityId, tagId: 42 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain(expectedPath);
    expect((opts as RequestInit).method).toBe("PUT");
    const body = JSON.parse((opts as RequestInit).body as string);
    // The id here is the PER-ENTITY link id, NOT a global tag id —
    // documented on the schema.
    expect(body[wrapper].tags).toEqual([{ id: 42, _delete: true }]);
  });
});

describe("deleteTagDefinition — tenant-wide definition delete (DESTRUCTIVE)", () => {
  it.each([
    ["parties", "/parties/tags/42"],
    ["opportunities", "/opportunities/tags/42"],
    ["projects", "/kases/tags/42"],
  ] as const)("DELETEs /%s/tags/{id} when confirm=true", async (entity, expectedPath) => {
    mockFetch(204, {});
    const { deleteTagDefinition } = await import("../src/tools/tags.js");

    const result = await deleteTagDefinition({ entity, tagId: 42, confirm: true });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain(expectedPath);
    expect((opts as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, entity, tagId: 42 });
  });

  it("is idempotent: Capsule 404 → alreadyDeleted: true", async () => {
    // A re-issued delete (definition already gone) 404s; the connector
    // converts that to a success-shaped alreadyDeleted result so
    // reconciliation / retry loops are safe.
    mockFetch(404, { message: "Could not find resource" });
    const { deleteTagDefinition } = await import("../src/tools/tags.js");

    const result = await deleteTagDefinition({ entity: "parties", tagId: 42, confirm: true });
    expect(result).toEqual({ deleted: true, alreadyDeleted: true, entity: "parties", tagId: 42 });
  });

  it("rejects confirm=false / missing confirm at the schema layer", async () => {
    const { deleteTagDefinitionSchema } = await import("../src/tools/tags.js");
    expect(
      deleteTagDefinitionSchema.safeParse({ entity: "parties", tagId: 42, confirm: false }).success,
    ).toBe(false);
    expect(deleteTagDefinitionSchema.safeParse({ entity: "parties", tagId: 42 }).success).toBe(
      false,
    );
    expect(
      deleteTagDefinitionSchema.safeParse({ entity: "parties", tagId: 42, confirm: true }).success,
    ).toBe(true);
  });

  it("rejects unknown entity at the schema layer", async () => {
    const { deleteTagDefinitionSchema } = await import("../src/tools/tags.js");
    expect(
      deleteTagDefinitionSchema.safeParse({ entity: "widgets", tagId: 42, confirm: true }).success,
    ).toBe(false);
  });

  it("handler guards confirm even when called directly (bypassing schema)", async () => {
    // Tests + internal callers invoke the handler function directly,
    // skipping the MCP-layer Zod validation. The handler's own guard
    // must still reject a non-true confirm so the destructive op can't
    // fire from a type-violating direct call.
    const { deleteTagDefinition } = await import("../src/tools/tags.js");
    await expect(
      // @ts-expect-error — deliberately violating the `confirm: true` type
      deleteTagDefinition({ entity: "parties", tagId: 42, confirm: false }),
    ).rejects.toThrow(/requires confirm: true/);
    // No HTTP call should have been attempted.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });
});
