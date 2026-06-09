/**
 * Coverage for the fetch-stage failure events: `capsule.timeout` and
 * `capsule.error`.
 *
 * These cover the one outbound-call path `capsule.request` cannot — a
 * request that aborts (timeout) or whose connection fails before any
 * response body arrives throws inside `fetchWithTimeout`, before
 * `consumeBody` runs. They are FORCED (emitted regardless of
 * `CAPSULE_MCP_LOG_VERBOSE`) so an operator chasing intermittent hangs
 * sees an endpoint + elapsed fingerprint with zero configuration.
 *
 * Privacy invariants under test: the redacted path carries `:id`, never
 * the raw numeric record id; a network error logs only a stable `code`,
 * never the raw error message.
 */

import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({ fetch: vi.fn() }));

describe("fetch-stage failure events (forced, verbose-independent)", () => {
  let emitted: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitted = [];
    process.env["CAPSULE_API_TOKEN"] = "test-token";
    // Deliberately leave CAPSULE_MCP_LOG_VERBOSE UNSET — these events
    // must fire on the force path regardless of the verbose gate.
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
    // biome-ignore lint/suspicious/noExplicitAny: stderr write is sync
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      emitted.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.resetAllMocks();
    delete process.env["CAPSULE_API_TOKEN"];
  });

  function events(name: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const line of emitted) {
      try {
        const j = JSON.parse(line);
        if (j.event === name) out.push(j);
      } catch {
        // Non-JSON stderr line — ignore.
      }
    }
    return out;
  }

  it("emits capsule.timeout on a fetch-stage AbortError, even with verbose off", async () => {
    vi.mocked(fetch).mockImplementationOnce(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties/123456789")).rejects.toThrow(
      /Capsule API request timed out after 60s/,
    );

    const timeouts = events("capsule.timeout");
    expect(timeouts).toHaveLength(1);
    const t = timeouts[0]!;
    expect(t["method"]).toBe("GET");
    // Privacy: redacted path, raw id absent anywhere in the log stream.
    expect(String(t["path"])).toBe("/api/v2/parties/:id");
    expect(emitted.join("")).not.toContain("123456789");
    expect(t["timeoutMs"]).toBe(60000);
    expect(typeof t["elapsedMs"]).toBe("number");
    // No success/error rows for the same call.
    expect(events("capsule.request")).toHaveLength(0);
    expect(events("capsule.error")).toHaveLength(0);
  });

  it("emits capsule.error with a low-cardinality code on a connection failure", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      ),
    );

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow();

    const errs = events("capsule.error");
    expect(errs).toHaveLength(1);
    const e = errs[0]!;
    expect(e["method"]).toBe("GET");
    expect(e["path"]).toBe("/api/v2/parties");
    expect(e["code"]).toBe("ECONNRESET");
    // Privacy: the raw undici message must not be logged.
    expect(emitted.join("")).not.toContain("fetch failed");
    expect(events("capsule.timeout")).toHaveLength(0);
  });

  it("does not emit a failure event on a successful request", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": "20" }),
      json: async () => ({ parties: [] }),
      text: async () => "",
      statusText: "200",
    } as Awaited<ReturnType<typeof fetch>>);

    const { capsuleGet } = await import("../src/capsule/client.js");
    await capsuleGet("/parties");

    expect(events("capsule.timeout")).toHaveLength(0);
    expect(events("capsule.error")).toHaveLength(0);
  });
});
