import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

function mockFetch(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

beforeEach(() => { process.env["CAPSULE_API_TOKEN"] = "test-token"; });
afterEach(() => { vi.clearAllMocks(); delete process.env["CAPSULE_API_TOKEN"]; });

describe("listTags", () => {
  it.each([
    ["parties", "/parties/tags"],
    ["opportunities", "/opportunities/tags"],
    ["kases", "/kases/tags"],
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
    ["kases", "kase", "/kases/5828000"],
  ] as const)(
    "PUTs to /%s/{id} with the correct wrapper key and {name}-only tag item",
    async (entity, wrapper, expectedPath) => {
      mockFetch(200, { [wrapper]: { id: 1 } });
      const { addTag } = await import("../src/tools/tags.js");

      const entityId = Number(expectedPath.split("/").pop());
      await addTag({ entity, entityId, tagName: "Zendesk" });

      const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toContain(expectedPath);
      expect((opts as RequestInit).method).toBe("PUT");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body[wrapper].tags).toEqual([{ name: "Zendesk" }]);
      // No id, no _delete on an add
      expect(body[wrapper].tags[0].id).toBeUndefined();
      expect(body[wrapper].tags[0]._delete).toBeUndefined();
    },
  );

  it("rejects empty tagName at the schema layer", async () => {
    const { addTagSchema } = await import("../src/tools/tags.js");
    expect(
      addTagSchema.safeParse({ entity: "parties", entityId: 1, tagName: "" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown entity at the schema layer", async () => {
    const { addTagSchema } = await import("../src/tools/tags.js");
    expect(
      addTagSchema.safeParse({
        entity: "projects" as never, // we say 'kases', not 'projects'
        entityId: 1,
        tagName: "X",
      }).success,
    ).toBe(false);
  });
});

describe("removeTagById — atomic detach by per-entity link id", () => {
  it.each([
    ["parties", "party", "/parties/284083000"],
    ["opportunities", "opportunity", "/opportunities/19897000"],
    ["kases", "kase", "/kases/5828000"],
  ] as const)(
    "PUTs {id, _delete:true} on /%s/{id}",
    async (entity, wrapper, expectedPath) => {
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
    },
  );
});
