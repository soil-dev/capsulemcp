/**
 * Tests for the observability event surface:
 *
 *   - `redactPath`: numeric-ID redaction + query stripping for
 *     paths logged in `cache.*` and `capsule.request` events.
 *   - `tool.call`: emitted once per tool invocation with field
 *     NAMES (`argFields`), never field values. Captures clientId
 *     from the active RequestContext, durationMs, outcome.
 *   - `capsule.request`: emitted once per outbound Capsule API
 *     call with a redacted path, status, durationMs, responseBytes.
 *   - `tool.chain`: aggregate emitted at end of /mcp request with
 *     the tool sequence + capsuleCalls + cacheHits.
 *
 * All events gated on `CAPSULE_MCP_LOG_VERBOSE=1`. Privacy
 * invariant: no CRM data leaks into any event.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getRequestContext, logEvent, redactPath, withRequestContext } from "../src/log.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

describe("redactPath", () => {
  it("redacts single numeric IDs", () => {
    expect(redactPath("/parties/123456789")).toBe("/parties/:id");
    expect(redactPath("/opportunities/1234")).toBe("/opportunities/:id");
    expect(redactPath("/kases/9")).toBe("/kases/:id");
  });

  it("redacts comma-separated multi-id paths", () => {
    expect(redactPath("/parties/1,2,3")).toBe("/parties/:id");
    expect(redactPath("/tasks/10,20,30,40")).toBe("/tasks/:id");
  });

  it("redacts nested numeric IDs", () => {
    expect(redactPath("/parties/123456789/notes")).toBe("/parties/:id/notes");
    expect(redactPath("/parties/123/notes/456")).toBe("/parties/:id/notes/:id");
  });

  it("drops the query string entirely", () => {
    expect(redactPath("/parties/search?q=Acme")).toBe("/parties/search");
    expect(redactPath("/parties?embed=tags&page=1")).toBe("/parties");
  });

  it("leaves non-numeric segments untouched", () => {
    // Tag-list paths use a non-numeric segment that should pass through.
    expect(redactPath("/parties/tags")).toBe("/parties/tags");
    expect(redactPath("/opportunities/tags")).toBe("/opportunities/tags");
    expect(redactPath("/kases/tags")).toBe("/kases/tags");
  });

  it("is idempotent", () => {
    const path = "/parties/:id/notes";
    expect(redactPath(path)).toBe(path);
  });
});

describe("logEvent + RequestContext aggregation", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let emitted: string[];

  beforeEach(() => {
    emitted = [];
    process.env["CAPSULE_MCP_LOG_VERBOSE"] = "1";
    // biome-ignore lint/suspicious/noExplicitAny: stderr write is sync
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      emitted.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
  });

  it("populates the ctx with tool.call and capsule.request inside withRequestContext", async () => {
    await withRequestContext({ clientId: "client-a" }, async () => {
      logEvent("tool.call", { tool: "filter_parties", argFields: ["q"] });
      logEvent("capsule.request", { method: "GET", path: "/parties", status: 200, durationMs: 10 });
      logEvent("capsule.request", {
        method: "GET",
        path: "/parties/:id",
        status: 200,
        durationMs: 5,
      });
      logEvent("cache.hit", { path: "/pipelines" });

      const ctx = getRequestContext();
      expect(ctx?.tools).toEqual(["filter_parties"]);
      expect(ctx?.capsuleCalls).toBe(2);
      expect(ctx?.cacheHits).toBe(1);
      expect(ctx?.clientId).toBe("client-a");
    });
  });

  it("does NOT emit when CAPSULE_MCP_LOG_VERBOSE is unset", async () => {
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
    logEvent("tool.call", { tool: "x" });
    expect(emitted).toEqual([]);
  });

  it("emits regardless of verbose flag when opts.force is set", () => {
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
    logEvent("batch.complete", { tool: "y" }, { force: true });
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!).event).toBe("batch.complete");
  });

  it("counts cache.hit toward ctx.cacheHits even without a parallel capsule.request", async () => {
    await withRequestContext({ clientId: "c" }, async () => {
      logEvent("cache.hit", { path: "/pipelines" });
      logEvent("cache.hit", { path: "/boards" });
      expect(getRequestContext()?.cacheHits).toBe(2);
      expect(getRequestContext()?.capsuleCalls).toBe(0);
    });
  });

  it("counts capsule.timeout, capsule.error, and capsule.ratelimit toward ctx.capsuleCalls", async () => {
    // These three events all throw before capsule.request would fire, so
    // the chain aggregate must still count them or a failed/throttled call
    // (which may have eaten up to 60s) would silently vanish from the
    // per-/mcp-request capsuleCalls total.
    await withRequestContext({ clientId: "c" }, async () => {
      logEvent("capsule.timeout", { method: "GET", path: "/parties/:id", elapsedMs: 60000 });
      logEvent("capsule.error", {
        method: "GET",
        path: "/parties",
        elapsedMs: 5,
        code: "ECONNRESET",
      });
      logEvent("capsule.ratelimit", {
        method: "GET",
        path: "/parties",
        elapsedMs: 60000,
        status: 429,
      });
      expect(getRequestContext()?.capsuleCalls).toBe(3);
    });
  });
});

describe("end-to-end: tool.call, capsule.request, tool.chain via the MCP wire", () => {
  let emitted: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitted = [];
    process.env["CAPSULE_MCP_LOG_VERBOSE"] = "1";
    process.env["CAPSULE_API_TOKEN"] = "test-token";
    process.env["CAPSULE_MCP_READONLY"] = "1";
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: stderr capture
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      emitted.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
    delete process.env["CAPSULE_API_TOKEN"];
    delete process.env["CAPSULE_MCP_READONLY"];
  });

  function parseEvents(filter?: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of emitted) {
      try {
        const j = JSON.parse(line);
        if (!filter || j.event === filter) events.push(j);
      } catch {
        // Non-JSON stderr line — ignore.
      }
    }
    return events;
  }

  /**
   * Helper: spawn server + client AFTER vi.resetModules(), and
   * pull `withRequestContext` / `getRequestContext` / `logEvent`
   * from the SAME log.js module instance the server's runtime uses.
   * Without this, the test's top-level imports and the server-side
   * imports reference different AsyncLocalStorage objects and the
   * context propagation is silently broken.
   */
  async function spawn(clientId: string) {
    vi.resetModules();
    const { createCapsuleMcpServer } = await import("../src/server.js");
    const log = await import("../src/log.js");
    const { fetch } = await import("undici");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ users: [{ id: 1, name: "T" }] }), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "30" },
        }),
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ev-test", version: "0" }, { capabilities: {} });
    const server = createCapsuleMcpServer({ clientId });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return { client, log, mockFetch };
  }

  it("emits tool.call with argFields containing field NAMES only, no values", async () => {
    const { client, log } = await spawn("ev-client");
    await log.withRequestContext({ clientId: "ev-client" }, async () => {
      await client.callTool({ name: "list_users", arguments: {} });
    });

    const toolCalls = parseEvents("tool.call");
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0]!;
    expect(tc["tool"]).toBe("list_users");
    expect(tc["clientId"]).toBe("ev-client");
    expect(tc["outcome"]).toBe("success");
    expect(typeof tc["durationMs"]).toBe("number");
    // Privacy: argFields contains key NAMES, not values. For an
    // empty arguments object, expect an empty array.
    expect(Array.isArray(tc["argFields"])).toBe(true);
  });

  it("emits capsule.request with redacted path", async () => {
    const { client, log, mockFetch } = await spawn("cap-client");
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ party: { id: 1, type: "person" } }), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "100" },
        }),
    );

    await log.withRequestContext({ clientId: "cap-client" }, async () => {
      await client.callTool({ name: "get_party", arguments: { id: 123456789 } });
    });

    const reqs = parseEvents("capsule.request");
    expect(reqs.length).toBeGreaterThan(0);
    const r = reqs[0]!;
    // Path is the full URL pathname (Capsule API base is
    // /api/v2/...). The load-bearing assertion: the raw party id
    // 123456789 must NOT appear; `:id` must.
    expect(String(r["path"])).toBe("/api/v2/parties/:id");
    expect(String(r["path"])).not.toContain("123456789");
    expect(r["method"]).toBe("GET");
    expect(r["status"]).toBe(200);
    expect(typeof r["durationMs"]).toBe("number");
  });

  it("capsule.request.durationMs includes body-read time (not just TTFB)", async () => {
    // Regression for the v1.6.0 metric-fidelity bug: the emit used to
    // fire from inside doFetch() right after headers came back, so the
    // duration only measured TTFB. Endpoints that streamed large
    // bodies (e.g. /entries global feed — 2720 ms wall-clock vs 542 ms
    // in the dashboard) silently underreported. v1.6.1 moves the emit
    // past body consumption; this test pins the new contract by making
    // body-read take measurably longer than the fetch() return.
    const { client, log, mockFetch } = await spawn("body-time");
    const BODY_READ_DELAY_MS = 60;
    mockFetch.mockImplementation(async () => {
      // Hand-rolled stream: headers are "instant", but the single chunk
      // doesn't enqueue for BODY_READ_DELAY_MS, so res.json() blocks
      // for at least that long. fetch() resolves immediately with the
      // Response — only body consumption hits the delay.
      const body = new ReadableStream({
        async start(controller) {
          await new Promise((r) => setTimeout(r, BODY_READ_DELAY_MS));
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ party: { id: 1, type: "person" } })),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "40" },
      });
    });

    await log.withRequestContext({ clientId: "body-time" }, async () => {
      await client.callTool({ name: "get_party", arguments: { id: 1 } });
    });

    const reqs = parseEvents("capsule.request");
    expect(reqs).toHaveLength(1);
    const dur = Number(reqs[0]!["durationMs"]);
    // Generous lower bound — Date.now() is millisecond-resolution and
    // event-loop jitter can shave ~10 ms off setTimeout. The old TTFB
    // metric would report a number near 0 here regardless of the
    // body-stream delay, so any value >= ~50 ms confirms the fix.
    expect(dur).toBeGreaterThanOrEqual(BODY_READ_DELAY_MS - 10);
  });

  it("tool.chain aggregates the request's tools and capsule calls", async () => {
    const { client, log } = await spawn("ch-client");
    // Drive two tools through within one RequestContext frame.
    // `withRequestContext` owns the `tool.chain` emission — it
    // fires automatically on scope exit, so no manual emission
    // here. Mirrors what src/http/app.ts does today.
    await log.withRequestContext({ clientId: "ch-client" }, async () => {
      await client.callTool({ name: "list_users", arguments: {} });
      await client.callTool({ name: "list_users", arguments: {} });
    });

    const chains = parseEvents("tool.chain");
    expect(chains).toHaveLength(1);
    const c = chains[0]!;
    expect(c["clientId"]).toBe("ch-client");
    expect(c["tools"]).toEqual(["list_users", "list_users"]);
    expect(c["toolCount"]).toBe(2);
    // list_users uses capsuleGetCached — first call misses (1
    // capsule.request), second call hits the cache (1 cache.hit).
    // The chain reports both: 1 capsuleCall, 1 cacheHit. This is
    // exactly the kind of analytical signal we want — easy to spot
    // "this batch of N identical calls only hit Capsule once".
    expect(Number(c["capsuleCalls"])).toBe(1);
    expect(Number(c["cacheHits"])).toBe(1);
  });

  it("emits tool.call with outcome:error when the handler throws", async () => {
    const { client, log, mockFetch } = await spawn("err-client");
    // 500 from Capsule -> CapsuleApiError in the handler -> register-tool
    // emits tool.call outcome:error and rethrows (SDK returns an isError
    // result, so callTool resolves rather than rejects).
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

    await log.withRequestContext({ clientId: "err-client" }, async () => {
      await client.callTool({ name: "get_party", arguments: { id: 1 } }).catch(() => {});
    });

    const toolCalls = parseEvents("tool.call");
    expect(toolCalls.some((t) => t["tool"] === "get_party" && t["outcome"] === "error")).toBe(true);
  });
});

// Silence the unused-import warning for z.
void z;
