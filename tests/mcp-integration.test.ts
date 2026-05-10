/**
 * MCP-protocol integration tests.
 *
 * Drives a real `McpServer` (built by `createCapsuleMcpServer`)
 * through the wire protocol via the SDK's in-memory transport pair,
 * with `undici.fetch` mocked at the bottom so no Capsule API calls
 * happen.
 *
 * These tests close the gap between unit-level "tool function works"
 * and live-trace "wire format matches Capsule": they verify that the
 * MCP layer (tools/list, tools/call, response content shaping)
 * correctly dispatches client requests to the right handler and
 * shapes the response per MCP's content-type spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

function mockBinary(
  status: number,
  buffer: Buffer,
  contentType = "application/octet-stream",
) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    // Real Capsule responses carry Content-Length; the client uses it
    // for its pre-buffer size cap (defence-in-depth against an
    // upstream sending 5 GB into a 5 MB cap).
    headers: new Headers({
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
    }),
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    text: async () => buffer.toString("utf8"),
    json: async () => {
      throw new Error("not JSON");
    },
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

async function spawn(opts: { readOnly?: boolean } = {}) {
  if (opts.readOnly) process.env["CAPSULE_MCP_READONLY"] = "1";
  else delete process.env["CAPSULE_MCP_READONLY"];

  // Re-import after env change so createCapsuleMcpServer picks it up.
  vi.resetModules();
  const { createCapsuleMcpServer } = await import("../src/server.js");

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "mcp-integration-test",
    version: "1.0.0",
  });
  const server = createCapsuleMcpServer();

  await Promise.all([client.connect(clientT), server.connect(serverT)]);

  return { client, server };
}

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_READONLY"];
});

// ── tools/list ──────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("returns the full tool catalogue when not in read-only mode", async () => {
    const { client } = await spawn({ readOnly: false });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Spot-check shape
    expect(tools.length).toBeGreaterThan(40);

    // Reads we always expect
    for (const r of [
      "search_parties",
      "filter_parties",
      "get_party",
      "get_parties",
      "list_employees",
      "list_entries",
      "get_attachment",
      "list_users",
      "get_site",
    ]) {
      expect(names).toContain(r);
    }

    // Writes that should be present in non-readonly
    for (const w of [
      "create_party",
      "update_party",
      "delete_party",
      "create_opportunity",
      "delete_opportunity",
      "add_note",
      "update_entry",
      "delete_entry",
      "upload_attachment",
      "apply_track",
      "remove_track",
      "add_additional_party",
      "remove_additional_party",
    ]) {
      expect(names).toContain(w);
    }
  });

  it("hides every write-side tool in read-only mode", async () => {
    const { client } = await spawn({ readOnly: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // No write tools should appear
    const writePrefixes = ["create_", "update_", "delete_", "complete_"];
    const writeSpecific = [
      "add_note",
      "add_additional_party",
      "remove_additional_party",
      "apply_track",
      "remove_track",
      "upload_attachment",
    ];
    for (const name of names) {
      for (const prefix of writePrefixes) {
        expect(name.startsWith(prefix)).toBe(false);
      }
      expect(writeSpecific).not.toContain(name);
    }
  });

  it("keeps read-side tools in read-only mode (key sample)", async () => {
    const { client } = await spawn({ readOnly: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const r of [
      "search_parties",
      "filter_parties",
      "get_attachment",
      "list_track_definitions",
      "list_saved_filters",
      "run_saved_filter",
      "get_site",
      "list_deleted_parties",
    ]) {
      expect(names).toContain(r);
    }
  });

  it("attaches a non-empty description to every tool", async () => {
    const { client } = await spawn();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.description!.length).toBeGreaterThan(10);
    }
  });
});

// ── tools/call — read-side ──────────────────────────────────────────────────

describe("tools/call (read tools)", () => {
  it("dispatches search_parties to the right handler and shapes the response as text content", async () => {
    const { client } = await spawn();
    mockFetch(200, { parties: [{ id: 1, type: "person", firstName: "Ada" }] });

    const result = await client.callTool({
      name: "search_parties",
      arguments: {},
    });

    expect(Array.isArray(result.content)).toBe(true);
    const c = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(c.type).toBe("text");
    const parsed = JSON.parse(c.text);
    expect(parsed.parties).toHaveLength(1);
    expect(parsed.parties[0].firstName).toBe("Ada");
  });

  it("propagates schema-level validation errors back to the client", async () => {
    const { client } = await spawn();
    // get_party requires `id` (positive int). Sending no id should fail
    // — MCP returns errors as {isError: true, content: [...]} rather
    // than throwing.
    const result = (await client.callTool({
      name: "get_party",
      arguments: {} as unknown as Record<string, unknown>,
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
  });

  it("returns an error response for an unregistered tool name", async () => {
    const { client } = await spawn();
    const result = (await client.callTool({
      name: "tool_that_does_not_exist",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not found/);
  });
});

// ── tools/call — write-side ─────────────────────────────────────────────────

describe("tools/call (write tools)", () => {
  it("create_party is reachable in read-write mode", async () => {
    const { client } = await spawn({ readOnly: false });
    mockFetch(200, { party: { id: 99, name: "Acme" } });

    const result = await client.callTool({
      name: "create_party",
      arguments: { type: "organisation", name: "Acme" },
    });

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).party.id).toBe(99);
  });

  it("create_party is NOT reachable in read-only mode", async () => {
    const { client } = await spawn({ readOnly: true });
    const result = (await client.callTool({
      name: "create_party",
      arguments: { type: "organisation", name: "Acme" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not found/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── get_attachment content-type routing (server.ts handler logic) ───────────

describe("get_attachment content-type routing", () => {
  it("returns MCP image content for image/* types", async () => {
    const { client } = await spawn();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockBinary(200, png, "image/png; charset=UTF-8");

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 1 },
    });

    const c = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)[0]!;
    expect(c.type).toBe("image");
    expect(c.mimeType).toBe("image/png; charset=UTF-8");
    expect(c.data).toBe(png.toString("base64"));
  });

  it("returns decoded text for text/* even with charset parameter (v1.0.0 fix)", async () => {
    const { client } = await spawn();
    const txt = Buffer.from("hello, mcp!");
    mockBinary(200, txt, "text/plain; charset=UTF-8");

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 1 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    // First content item: metadata JSON; second: decoded text body
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe("text");
    const meta = JSON.parse(content[0]!.text);
    expect(meta.contentType).toBe("text/plain; charset=UTF-8");
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toBe("hello, mcp!");
  });

  it("returns metadata + base64 for non-image binary types (e.g. PDF)", async () => {
    const { client } = await spawn();
    const pdf = Buffer.from("%PDF-1.4 fake");
    mockBinary(200, pdf, "application/pdf");

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 1 },
    });

    const c = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(c.type).toBe("text");
    const parsed = JSON.parse(c.text);
    expect(parsed.contentType).toBe("application/pdf");
    expect(parsed.base64).toBe(pdf.toString("base64"));
    expect(parsed.sizeBytes).toBe(pdf.length);
  });

  it("returns metadata-only with truncated:true for files exceeding maxSizeBytes", async () => {
    const { client } = await spawn();
    const big = Buffer.alloc(100);
    mockBinary(200, big, "application/pdf");

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 1, maxSizeBytes: 50 },
    });

    const c = (result.content as Array<{ text: string }>)[0]!;
    const parsed = JSON.parse(c.text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.sizeBytes).toBe(100);
    expect(parsed.base64).toBeUndefined();
  });

  it("recognises application/json with charset (v1.0.0 fix A)", async () => {
    const { client } = await spawn();
    const json = Buffer.from('{"k":"v"}');
    mockBinary(200, json, "application/json; charset=UTF-8");

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 1 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    // Goes to the text branch (metadata + decoded), not the binary branch
    expect(content).toHaveLength(2);
    expect(content[1]!.text).toBe('{"k":"v"}');
  });
});
