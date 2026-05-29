/**
 * Tests for MCP tool annotations inference.
 *
 * Annotations are name-inferred at registration time so all 88 tools
 * get accurate hints without per-call-site annotation declarations.
 * These tests pin three contracts:
 *
 *   1. `inferAnnotations` returns the right shape for each catalogue
 *      category (read, destructive, other write). Pure-function unit
 *      test on the helper.
 *
 *   2. The annotations actually round-trip through the SDK — when a
 *      client calls `tools/list`, the response carries an EXPLICIT
 *      {readOnlyHint, destructiveHint} pair on every tool. Never
 *      undefined. Reasoning: MCP spec defaults `destructiveHint: true`,
 *      so any tool that omits it (or returns no annotations at all)
 *      resolves to destructive-by-default in spec-compliant clients.
 *      Real-world Claude clients have been observed honoring that
 *      implicit-true even when `readOnlyHint: true` is also set, so
 *      we make every hint explicit and never rely on spec defaults.
 *
 *   3. Aggregate counts match the catalog: 49 read-only-and-not-
 *      destructive, 8 not-read-and-destructive, 31 not-read-and-not-
 *      destructive (creates / updates / additive writes). Drift in
 *      any direction means a new tool is going to surprise users
 *      with an unexpected pre-call prompt (or, worse, an auto-
 *      approval for something destructive).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferAnnotations } from "../src/server/register-tool.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

describe("inferAnnotations (pure helper)", () => {
  it("marks read-prefixed tools as read-only AND non-destructive (explicit)", () => {
    for (const name of [
      "search_parties",
      "filter_opportunities",
      "get_party",
      "get_attachment",
      "list_users",
      "show_track",
      "run_saved_filter",
    ]) {
      // Explicit destructiveHint: false — see the helper's doc-comment
      // for why we don't rely on the spec default.
      expect(inferAnnotations(name)).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
  });

  it("marks the 8 destructive tools as not-read-only AND destructive (explicit)", () => {
    for (const name of [
      "delete_party",
      "delete_opportunity",
      "delete_project",
      "delete_task",
      "delete_entry",
      "delete_tag_definition",
      "remove_track",
      "remove_additional_party",
    ]) {
      expect(inferAnnotations(name)).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it("marks non-destructive writes as not-read-only AND not-destructive (explicit)", () => {
    // Previously these returned `undefined` and relied on MCP spec
    // defaults — but the spec defaults destructiveHint to `true`,
    // which meant clients treated routine writes like adding a note
    // or tagging a record with the same UI weight as `delete_party`.
    // Now every tool emits the full hint pair explicitly.
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
      expect(inferAnnotations(name)).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
      });
    }
  });

  it("doesn't false-positive on names that contain a read prefix mid-string", () => {
    // Belt-and-braces: the matcher uses startsWith, not includes.
    // Both names below fall into the non-read non-destructive bucket.
    expect(inferAnnotations("xget_party")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(inferAnnotations("create_list")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("auto-tags any future delete_* tool as destructive", () => {
    // Safety net: if someone adds a new delete_X tool, it
    // inherits destructiveHint without needing to update a list.
    // Without this, a forgotten Set entry would ship a delete tool
    // as a routine write (no client confirmation prompt).
    expect(inferAnnotations("delete_hypothetical_new_tool")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // The aggregate-counts test below would also catch a count
    // drift, but this is the more direct assertion.
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

  it("populates explicit readOnlyHint + destructiveHint on every tool", async () => {
    vi.resetModules();
    const { createCapsuleMcpServer } = await import("../src/server.js");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "annotations-test", version: "0.0.0" }, { capabilities: {} });
    const server = createCapsuleMcpServer();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.listTools();
    const byName = new Map(result.tools.map((t) => [t.name, t]));

    // A representative read tool from each prefix family — should
    // carry BOTH hints explicitly (readOnly: true, destructive: false).
    for (const r of [
      "get_party",
      "list_users",
      "search_parties",
      "filter_opportunities",
      "show_track",
      "run_saved_filter",
      "get_attachment", // manually wired via raw server.tool — must match.
    ]) {
      expect(byName.get(r)?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get(r)?.annotations?.destructiveHint).toBe(false);
    }

    // All 8 destructive tools.
    for (const dest of [
      "delete_party",
      "delete_opportunity",
      "delete_project",
      "delete_task",
      "delete_entry",
      "delete_tag_definition",
      "remove_track",
      "remove_additional_party",
    ]) {
      expect(byName.get(dest)?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get(dest)?.annotations?.destructiveHint).toBe(true);
    }

    // Non-destructive writes — must NOT carry implicit-destructive
    // semantics. This is the load-bearing assertion: pre-fix these
    // tools had `annotations === undefined`, which spec-defaulted
    // them to destructiveHint=true. After the fix they explicitly
    // say `{readOnlyHint: false, destructiveHint: false}` so clients
    // give them the routine-write UI treatment, not the delete UI.
    for (const w of [
      "create_party",
      "update_party",
      "add_tag",
      "add_note",
      "batch_add_tag",
      "batch_update_party",
      "complete_task",
    ]) {
      expect(byName.get(w)?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get(w)?.annotations?.destructiveHint).toBe(false);
    }

    // Sanity check: every tool in the catalog emits an annotations
    // object. None should be undefined post-fix.
    for (const t of result.tools) {
      expect(t.annotations).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint).toBe("boolean");
    }

    // Aggregate counts — the catalogue invariants we want CI to defend.
    // Three mutually-exclusive buckets:
    //   - readOnly+nondestructive (reads): 49
    //   - notRead+destructive (delete_*, remove_track, remove_additional_party): 8
    //   - notRead+notDestructive (creates/updates/additive writes): 31
    let readOnly = 0;
    let destructive = 0;
    let routineWrite = 0;
    for (const t of result.tools) {
      const ro = t.annotations?.readOnlyHint === true;
      const dh = t.annotations?.destructiveHint === true;
      if (ro && !dh) readOnly++;
      else if (!ro && dh) destructive++;
      else if (!ro && !dh) routineWrite++;
      // The fourth combo (readOnly + destructive) is nonsensical;
      // any tool landing there means inferAnnotations regressed.
    }
    expect(readOnly).toBe(49);
    expect(destructive).toBe(8);
    expect(routineWrite).toBe(31);
    expect(readOnly + destructive + routineWrite).toBe(result.tools.length);
    expect(result.tools.length).toBe(88);
  });
});
