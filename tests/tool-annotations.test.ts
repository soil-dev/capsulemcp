/**
 * Tests for MCP tool annotations inference.
 *
 * Annotations are name-inferred at registration time so all 86 tools
 * get accurate hints without per-call-site annotation declarations.
 * These tests pin three contracts:
 *
 *   1. `inferAnnotations` returns the right shape for each catalogue
 *      category (read, destructive, other write). Pure-function unit
 *      test on the helper.
 *
 *   2. The annotations actually round-trip through the SDK — when a
 *      client calls `tools/list`, the response carries
 *      `readOnlyHint: true` for read tools and
 *      `destructiveHint: true` for the 7 destructive tools (the
 *      same set the `confirm: true` schema gate covers).
 *
 *   3. Aggregate counts match the catalog: 49 read-only-hinted tools
 *      (matches README "49 in read-only mode"), 7 destructive-hinted,
 *      30 unhinted writes. Drift in any direction means a new tool
 *      is going to surprise users with an unexpected pre-call prompt
 *      (or, worse, an auto-approval for something destructive).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferAnnotations } from "../src/server/register-tool.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

describe("inferAnnotations (pure helper)", () => {
  it("marks read-prefixed tools as read-only", () => {
    for (const name of [
      "search_parties",
      "filter_opportunities",
      "get_party",
      "get_attachment",
      "list_users",
      "show_track",
      "run_saved_filter",
    ]) {
      expect(inferAnnotations(name)).toEqual({ readOnlyHint: true });
    }
  });

  it("marks the 7 destructive tools as destructive", () => {
    for (const name of [
      "delete_party",
      "delete_opportunity",
      "delete_project",
      "delete_task",
      "delete_entry",
      "remove_track",
      "remove_additional_party",
    ]) {
      expect(inferAnnotations(name)).toEqual({ destructiveHint: true });
    }
  });

  it("leaves non-destructive writes without a hint", () => {
    // Each is a real catalogue tool; clients should fall back to
    // their default (typically: prompt for confirmation).
    for (const name of [
      "create_party",
      "update_party",
      "add_note",
      "add_tag",
      "remove_tag_by_id",
      "remove_party_email_address_by_id",
      "complete_task",
      "apply_track",
      "upload_attachment",
      "batch_update_party",
      "batch_add_tag",
    ]) {
      expect(inferAnnotations(name)).toBeUndefined();
    }
  });

  it("doesn't false-positive on names that contain a read prefix mid-string", () => {
    // Belt-and-braces: the matcher uses startsWith, not includes.
    expect(inferAnnotations("xget_party")).toBeUndefined();
    expect(inferAnnotations("create_list")).toBeUndefined();
  });
});

describe("tools/list response carries inferred annotations", () => {
  beforeEach(() => {
    process.env["CAPSULE_API_TOKEN"] = "test-token";
    delete process.env["CAPSULE_MCP_READONLY"];
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env["CAPSULE_API_TOKEN"];
    delete process.env["CAPSULE_MCP_READONLY"];
  });

  it("populates readOnlyHint / destructiveHint per the catalog conventions", async () => {
    vi.resetModules();
    const { createCapsuleMcpServer } = await import("../src/server.js");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "annotations-test", version: "0.0.0" }, { capabilities: {} });
    const server = createCapsuleMcpServer();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.listTools();
    const byName = new Map(result.tools.map((t) => [t.name, t]));

    // A representative read tool from each prefix family.
    expect(byName.get("get_party")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("list_users")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("search_parties")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("filter_opportunities")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("show_track")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("run_saved_filter")?.annotations?.readOnlyHint).toBe(true);
    // get_attachment is wired with a manual annotation (raw server.tool)
    // — verify it matches the rest of the catalog.
    expect(byName.get("get_attachment")?.annotations?.readOnlyHint).toBe(true);

    // All 7 destructive tools.
    for (const dest of [
      "delete_party",
      "delete_opportunity",
      "delete_project",
      "delete_task",
      "delete_entry",
      "remove_track",
      "remove_additional_party",
    ]) {
      expect(byName.get(dest)?.annotations?.destructiveHint).toBe(true);
    }

    // Non-destructive writes have no annotations.
    for (const w of ["create_party", "update_party", "add_tag", "batch_add_tag"]) {
      expect(byName.get(w)?.annotations).toBeUndefined();
    }

    // Aggregate counts — the catalogue invariants we want CI to defend.
    let readOnly = 0;
    let destructive = 0;
    let unhinted = 0;
    for (const t of result.tools) {
      if (t.annotations?.readOnlyHint) readOnly++;
      else if (t.annotations?.destructiveHint) destructive++;
      else unhinted++;
    }
    expect(readOnly).toBe(49);
    expect(destructive).toBe(7);
    expect(unhinted).toBe(30);
    expect(readOnly + destructive + unhinted).toBe(result.tools.length);
    expect(result.tools.length).toBe(86);
  });
});
