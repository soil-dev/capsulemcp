/**
 * Tests for the two tools/list payload reducers:
 *
 *   1. CAPSULE_MCP_TIER=core — registers only the curated core set
 *      (src/server/tier.ts). Default (unset) keeps the full catalog.
 *   2. Batch schema description-stripping (define-batch.ts +
 *      strip-descriptions.ts) — the batch_* tools' embedded item
 *      schemas no longer duplicate the single tools' nested
 *      .describe() text on the wire, while validating identically.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const ENV = ["CAPSULE_MCP_TIER", "CAPSULE_API_TOKEN", "CAPSULE_MCP_READONLY"];

async function listTools(env: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { CAPSULE_API_TOKEN: "test-token" }, env);
  vi.resetModules();
  const { createCapsuleMcpServer } = await import("../src/server.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tier-test", version: "0" }, { capabilities: {} });
  const server = createCapsuleMcpServer();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("CAPSULE_MCP_TIER", () => {
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  it("default (unset) registers the full catalog", async () => {
    const tools = await listTools({});
    expect(tools.length).toBe(89);
  });

  it("core tier registers only the curated core set", async () => {
    const tools = await listTools({ CAPSULE_MCP_TIER: "core" });
    const names = tools.map((t) => t.name);
    // The 26-tool core (write mode).
    expect(tools.length).toBe(26);
    for (const core of ["search_parties", "create_party", "list_tasks", "add_note", "add_tag"]) {
      expect(names).toContain(core);
    }
    // Long-tail tools are excluded.
    for (const tail of ["list_boards", "get_attachment", "batch_update_party", "apply_track"]) {
      expect(names).not.toContain(tail);
    }
  });

  it("core tier composes with read-only mode (filters within the read set)", async () => {
    const tools = await listTools({ CAPSULE_MCP_TIER: "core", CAPSULE_MCP_READONLY: "1" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_parties");
    expect(names).not.toContain("create_party"); // readonly wins
    expect(names).not.toContain("list_boards"); // tier wins
    // Core ∩ read-only = the 15 read tools in the core set (search/
    // filter/get/list across the four resources + list_tags +
    // get_current_user + list_party_entries).
    expect(tools.length).toBe(15);
  });

  it("an unknown tier value falls back to the full catalog", async () => {
    const tools = await listTools({ CAPSULE_MCP_TIER: "everything" });
    expect(tools.length).toBe(89);
  });
});

describe("batch schema description-stripping", () => {
  it("strips nested descriptions from the batch items schema but keeps the canonical ones on the single tool", async () => {
    const { batchUpdatePartySchema, updatePartySchema } = await import("../src/tools/parties.js");
    const batchJson = z.toJSONSchema(batchUpdatePartySchema, { io: "input" });
    const singleJson = z.toJSONSchema(updatePartySchema, { io: "input" });

    // The single tool keeps its descriptions (the canonical copy).
    expect(JSON.stringify(singleJson)).toContain('"description"');

    // Inside the batch items element, no descriptions survive.
    const items = (batchJson as unknown as { properties: { items: { items: unknown } } }).properties
      .items;
    expect(JSON.stringify((items as { items: unknown }).items)).not.toContain('"description"');

    // The items array itself keeps its pointer description.
    expect(JSON.stringify(items)).toContain("update_party");
  });

  it("stripped schema validates identically (checks and refinements preserved)", async () => {
    const { batchUpdatePartySchema } = await import("../src/tools/parties.js");
    // Valid item passes.
    expect(batchUpdatePartySchema.safeParse({ items: [{ id: 1, firstName: "A" }] }).success).toBe(
      true,
    );
    // positiveId coercion still applies inside the stripped clone.
    expect(batchUpdatePartySchema.safeParse({ items: [{ id: "7" }] }).success).toBe(true);
    // Invalid id still rejected.
    expect(batchUpdatePartySchema.safeParse({ items: [{ id: -1 }] }).success).toBe(false);
    // The nested WebsiteSchema superRefine survives the strip: a
    // websites entry with service URL and a non-URL address must fail.
    expect(
      batchUpdatePartySchema.safeParse({
        items: [{ id: 1, websites: [{ address: "not a url", service: "URL" }] }],
      }).success,
    ).toBe(false);
  });

  it("size pin: each batch tool's serialized schema stays small", async () => {
    const tools = await import("../src/tools/parties.js");
    const opps = await import("../src/tools/opportunities.js");
    const projects = await import("../src/tools/projects.js");
    const tags = await import("../src/tools/tags.js");
    for (const [name, schema] of [
      ["batch_update_party", tools.batchUpdatePartySchema],
      ["batch_update_opportunity", opps.batchUpdateOpportunitySchema],
      ["batch_update_project", projects.batchUpdateProjectSchema],
      ["batch_add_tag", tags.batchAddTagSchema],
      ["batch_remove_tag_by_id", tags.batchRemoveTagByIdSchema],
    ] as const) {
      const bytes = JSON.stringify(z.toJSONSchema(schema, { io: "input" })).length;
      // Pre-strip, batch_update_party serialized to ~7.5 KB. The pin
      // catches a regression that reintroduces nested descriptions.
      expect(bytes, `${name} serialized to ${bytes}B`).toBeLessThan(3500);
    }
  });
});
