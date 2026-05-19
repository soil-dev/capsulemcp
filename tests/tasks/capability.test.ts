/**
 * Capability-advertisement tests for the tasks subsystem.
 *
 * The contract: `createCapsuleMcpServer` advertises the `tasks`
 * capability and wires the SDK's auto-handlers if and only if BOTH:
 *
 *   - `MCP_TASKS_ENABLED=1` (operator opt-in), AND
 *   - a `clientId` is provided (HTTP transport always has one;
 *     stdio doesn't).
 *
 * If either is missing, the server behaves exactly as it did before
 * tasks landed — no `tasks` capability, no `tasks/*` handler. We
 * verify this by inspecting what the SDK sends back on
 * `initialize`, which is the wire-visible source of truth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { _resetTaskStoreForTests } from "../../src/tasks/store.js";

// undici is mocked across the test suite for tools that hit Capsule.
// We don't hit Capsule here (just initialize handshake) but the mock
// keeps the shape consistent with other integration tests.
vi.mock("undici", () => ({ fetch: vi.fn() }));

const ENV_KEYS = ["MCP_TASKS_ENABLED", "CAPSULE_API_TOKEN", "CAPSULE_MCP_READONLY"];

async function spawn(opts: { clientId?: string } = {}) {
  vi.resetModules();
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  process.env["CAPSULE_MCP_READONLY"] = "1";
  const { createCapsuleMcpServer } = await import("../../src/server.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "tasks-capability-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const server = createCapsuleMcpServer(opts);
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

describe("tasks capability advertisement", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetTaskStoreForTests();
  });

  it("does NOT advertise tasks when MCP_TASKS_ENABLED is unset", async () => {
    const { client } = await spawn({ clientId: "client-a" });
    const caps = client.getServerCapabilities();
    expect(caps?.tasks).toBeUndefined();
  });

  it("does NOT advertise tasks when clientId is absent (stdio path)", async () => {
    process.env["MCP_TASKS_ENABLED"] = "1";
    const { client } = await spawn({});
    const caps = client.getServerCapabilities();
    expect(caps?.tasks).toBeUndefined();
  });

  it("DOES advertise tasks when enabled AND clientId is present", async () => {
    process.env["MCP_TASKS_ENABLED"] = "1";
    const { client } = await spawn({ clientId: "client-a" });
    const caps = client.getServerCapabilities();
    expect(caps?.tasks).toBeDefined();
    // SDK marker shape: empty-object presence markers, not booleans.
    expect(caps?.tasks?.list).toEqual({});
    expect(caps?.tasks?.cancel).toEqual({});
    expect(caps?.tasks?.requests?.tools?.call).toEqual({});
  });

  // P2: explicit assertion that calling `createCapsuleMcpServer()` with
  // NO opts at all (the stdio entrypoint shape — see `src/index.ts`)
  // never advertises tasks, regardless of env. The earlier test passes
  // `{}` to spawn; this one omits the argument entirely so a refactor
  // that defaults `opts = {}` differently is still caught.
  it("stdio shape (no opts arg) NEVER advertises tasks, even with env set", async () => {
    process.env["MCP_TASKS_ENABLED"] = "1";
    vi.resetModules();
    process.env["CAPSULE_API_TOKEN"] = "test-token";
    process.env["CAPSULE_MCP_READONLY"] = "1";
    const { createCapsuleMcpServer } = await import("../../src/server.js");

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-shape-test", version: "0.0.0" }, { capabilities: {} });
    // Note: NO opts argument at all — not even `{}`. Mirrors src/index.ts.
    const server = createCapsuleMcpServer();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    expect(client.getServerCapabilities()?.tasks).toBeUndefined();
  });
});
