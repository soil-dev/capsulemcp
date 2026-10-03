/**
 * Token-health probe (src/capsule/health.ts).
 *
 * The probe is the connector's only defence against the silent-failure
 * mode where the Capsule token is revoked and every call 401s while
 * the process looks healthy. These tests pin: the three verdicts and
 * what produces each; that the probe never retries a 429 (one fetch
 * per probe); the 60 s cache, its `force` bypass and in-flight sharing;
 * the deadline wiring (a hung Capsule becomes `unreachable` at the
 * probe's own deadline, exercised with a real clock); and the forced
 * `capsule.auth` event — emitted on change only, carrying `reason`
 * and never the token or `detail`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import {
  HEALTH_CACHE_TTL_MS,
  HEALTH_PROBE_PATH,
  HEALTH_PROBE_TIMEOUT_MS,
  checkCapsuleHealth,
  getCachedHealth,
  resetHealthForTests,
} from "../src/capsule/health.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const TOKEN = "test-token-that-must-never-appear-in-output";

function respond(status: number) {
  vi.mocked(fetch).mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: { cancel: async () => undefined },
    json: async () => ({}),
    text: async () => "",
    statusText: String(status),
  } as unknown as Awaited<ReturnType<typeof fetch>>);
}

// The probe emits FORCED events (they bypass the verbose gate by
// design), so capture stderr instead of letting JSON hit the runner.
let stderrLines: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrEvents(): Array<Record<string, unknown>> {
  return stderrLines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = TOKEN;
  resetHealthForTests();
  stderrLines = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  vi.clearAllMocks();
  vi.useRealTimers();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("verdicts", () => {
  it("200 on GET /users/current → valid, with the bearer token on the wire", async () => {
    respond(200);
    const health = await checkCapsuleHealth({ force: true });
    expect(health.token_status).toBe("valid");
    expect(health.reason).toBeUndefined();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain(HEALTH_PROBE_PATH);
    expect((init as { headers: Record<string, string> }).headers["Authorization"]).toBe(
      `Bearer ${TOKEN}`,
    );
    expect((init as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("401 → rejected / unauthorized", async () => {
    respond(401);
    const health = await checkCapsuleHealth({ force: true });
    expect(health.token_status).toBe("rejected");
    expect(health.reason).toBe("unauthorized");
    expect(health.detail).toMatch(/401/);
  });

  it("403 → rejected / forbidden", async () => {
    respond(403);
    const health = await checkCapsuleHealth({ force: true });
    expect(health).toMatchObject({ token_status: "rejected", reason: "forbidden" });
  });

  it("5xx → unreachable / http_<status>, and 429 is NOT retried", async () => {
    respond(503);
    expect(await checkCapsuleHealth({ force: true })).toMatchObject({
      token_status: "unreachable",
      reason: "http_503",
    });
    respond(429);
    expect(await checkCapsuleHealth({ force: true })).toMatchObject({
      token_status: "unreachable",
      reason: "http_429",
    });
    // One fetch per probe: the probe must never sit in rate-limit back-off.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
  });

  it("transport error → unreachable / network_error", async () => {
    vi.mocked(fetch).mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    const health = await checkCapsuleHealth({ force: true });
    expect(health).toMatchObject({ token_status: "unreachable", reason: "network_error" });
  });

  it("missing CAPSULE_API_TOKEN → unreachable / config_error, no request made", async () => {
    delete process.env["CAPSULE_API_TOKEN"];
    const health = await checkCapsuleHealth({ force: true });
    expect(health).toMatchObject({ token_status: "unreachable", reason: "config_error" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a hung Capsule becomes unreachable / timeout at the probe's own deadline", async () => {
    // The mock honours the AbortSignal the probe passes, exactly as undici
    // does: it rejects with a TimeoutError when the signal fires.
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal }).signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
          );
        }),
    );
    const startedAt = Date.now();
    const health = await checkCapsuleHealth({ force: true, timeoutMs: 50 });
    expect(Date.now() - startedAt).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS);
    expect(health).toMatchObject({ token_status: "unreachable", reason: "timeout" });
  });

  it("the production deadline is 8 s — well under an uptime checker's ~10 s", () => {
    expect(HEALTH_PROBE_TIMEOUT_MS).toBe(8_000);
  });
});

describe("cache", () => {
  it("serves the cached verdict within the TTL and re-probes after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    respond(200);
    await checkCapsuleHealth();
    await checkCapsuleHealth();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + HEALTH_CACHE_TTL_MS + 1);
    await checkCapsuleHealth();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the cache; concurrent callers share one in-flight probe", async () => {
    respond(200);
    await checkCapsuleHealth();
    await checkCapsuleHealth({ force: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    resetHealthForTests();
    const [a, b, c] = await Promise.all([
      checkCapsuleHealth(),
      checkCapsuleHealth(),
      checkCapsuleHealth(),
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(getCachedHealth()).toBe(a);
  });
});

describe("forced capsule.auth event", () => {
  it("fires on the first verdict and on every change — not on a repeat", async () => {
    respond(200);
    await checkCapsuleHealth({ force: true });
    await checkCapsuleHealth({ force: true });
    respond(401);
    await checkCapsuleHealth({ force: true });
    await checkCapsuleHealth({ force: true });

    const events = stderrEvents().filter((e) => e["event"] === "capsule.auth");
    expect(events.map((e) => e["token_status"])).toEqual(["valid", "rejected"]);
    expect(events[1]!["reason"]).toBe("unauthorized");
  });

  it("is emitted with verbose logging OFF, and never carries the token or detail", async () => {
    delete process.env["CAPSULE_MCP_LOG_VERBOSE"];
    respond(401);
    await checkCapsuleHealth({ force: true });
    const [event] = stderrEvents().filter((e) => e["event"] === "capsule.auth");
    expect(event).toBeDefined();
    expect(event!["detail"]).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(Object.keys(event!).sort()).toEqual(["event", "reason", "timestamp", "token_status"]);
  });
});
