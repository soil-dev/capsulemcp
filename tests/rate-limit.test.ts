/**
 * Rate-limit retry path coverage. The capsule client retries 429
 * responses once after honouring Retry-After, and gives up if the
 * second attempt also 429s. Critical to test because:
 *
 * - A regression that loops forever would thrash Capsule.
 * - A regression that fails fast would crash on every transient
 *   rate-limit hit.
 * - Retry-After accepts both integer-seconds and HTTP-date formats;
 *   only the integer path was exercised by other tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Awaited<ReturnType<typeof fetch>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => "",
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>;
}

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
  // Speed up tests — the retry waits parseRetryAfter ms; default is
  // 5s but we want sub-second test runs. Mock setTimeout via vitest's
  // fake timers? Simpler: just tolerate the wait when tests pass a
  // small Retry-After value.
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("doFetch retry-on-429", () => {
  it("retries once after honouring an integer-seconds Retry-After", async () => {
    // First call: 429 with Retry-After: 0 (no real wait)
    // Second call: 200 with payload
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeResponse(429, { message: "rate limited" }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(makeResponse(200, { parties: [{ id: 1 }] }));

    const { capsuleGet } = await import("../src/capsule/client.js");
    const result = await capsuleGet<{ parties: unknown[] }>("/parties");

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ parties: [{ id: 1 }] });
  });

  it("respects HTTP-date Retry-After (not just integer-seconds)", async () => {
    // HTTP-date: 1 second from now. parseRetryAfter computes the
    // delta and waits at most that long.
    const oneSecond = new Date(Date.now() + 1000).toUTCString();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeResponse(429, { message: "slow down" }, { "Retry-After": oneSecond }),
      )
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const { capsuleGet } = await import("../src/capsule/client.js");
    const start = Date.now();
    const result = await capsuleGet<{ ok: boolean }>("/test");
    const elapsed = Date.now() - start;

    // Retry should fire after roughly 1 second (allow some slop).
    // Critical: it should NOT use the 5-second default.
    expect(elapsed).toBeLessThan(2000);
    expect(result.data).toEqual({ ok: true });
  });

  it("throws when both attempts return 429 (no infinite loop)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        makeResponse(429, { message: "rate limited" }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        makeResponse(429, { message: "still rate limited" }, { "Retry-After": "0" }),
      );

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow(
      /Rate limit exceeded after one retry/,
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("falls back to a 5-second default when Retry-After header is missing", async () => {
    // Verify the path; we don't actually wait the full 5s in tests —
    // we just confirm the second call happens with a sane delay
    // when Retry-After is absent. To keep the test fast we fake the
    // timer.
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(429, { message: "rate limited" }))
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");

      // Advance just past the 5s default delay
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await promise;

      expect(result.data).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps absurdly large integer-seconds Retry-After to 60s", async () => {
    // capsuleGet's parseRetryAfter clamps to 60s max.
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, {}, { "Retry-After": "9999" }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");

      // Advance just past 60s — retry should have fired by now.
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await promise;

      expect(result.data).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes through non-429 errors without retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(500, { message: "server error" }),
    );

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow(/Capsule API error 500/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // No retry
  });

  it("does NOT retry on 401 (auth error surfaces immediately)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(401, { message: "Bad credentials" }),
    );

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow(
      /Capsule API returned 401/,
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
