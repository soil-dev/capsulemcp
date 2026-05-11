/**
 * Rate-limit retry path coverage. The capsule client retries 429
 * responses once after honouring Capsule's X-RateLimit-Reset
 * (preferred) or Retry-After (defensive fallback), and gives up if
 * the second attempt also 429s. Critical to test because:
 *
 * - A regression that loops forever would thrash Capsule.
 * - A regression that fails fast would crash on every transient
 *   rate-limit hit.
 * - Capsule's actual signal is X-RateLimit-Reset (UTC epoch seconds),
 *   not Retry-After. Honouring the wrong header means we'd retry on
 *   a default 5s loop instead of waiting for the hourly window to
 *   roll over, getting 429s for many minutes.
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
  // Defensive: ensure each test starts with real timers. Earlier
  // tests in the file use vi.useFakeTimers(); if any of them ever
  // forget the matching useRealTimers() in a finally block, a
  // real-timer-dependent test that follows would hang forever
  // because its setTimeout would never fire.
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // resetAllMocks (not clearAllMocks) — clearAllMocks keeps queued
  // mockResolvedValueOnce values, which can leak between tests if a
  // test queues more mocks than it consumes. resetAllMocks fully
  // drains the queue and removes implementations.
  vi.resetAllMocks();
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
    // Fake timers + pinned system time make the HTTP-date math
    // deterministic. toUTCString() has whole-second precision, so without
    // a pinned now, `Date.now() + 1000` can format to the same second as
    // "now" once parsed back — parseRetryAfter then gets a ≤0 delta and
    // falls back to the 5s default, racing the test timeout (#15).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Build the header 2 seconds out so the whole-second toUTCString
      // round-trip lands at least 1 second after "now" deterministically.
      const twoSeconds = new Date(Date.now() + 2000).toUTCString();

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, { message: "slow down" }, { "Retry-After": twoSeconds }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");

      // Advance just past the 2s window; retry must fire before the 5s
      // default would. If the retry hadn't fired by 2.5s, fetch.callCount
      // would still be 1 — the post-advance assertions catch that.
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(result.data).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
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

  it("honours Capsule's X-RateLimit-Reset (epoch seconds) over Retry-After", async () => {
    // Same flake-class as the HTTP-date test (#15): epoch-second
    // rounding plus real timers makes the computed delta race with the
    // 5s default. Pin time + fake timers to make it deterministic.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const twoSecondsFromNow = Math.floor((Date.now() + 2000) / 1000);

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, { error: "rate limit reached" }, {
            "X-RateLimit-Limit": "4000",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(twoSecondsFromNow),
          }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");

      // Advance past the 2s window; the retry must fire well before the
      // 5s default would.
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(result.data).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("X-RateLimit-Reset takes precedence over Retry-After", async () => {
    // If Capsule ever sends both, the Capsule-specific header wins.
    // Reset = 1s out, Retry-After = 30s — wait should be 1s, not 30s.
    // Fake timers so we don't sleep 1s of wall clock.
    vi.useFakeTimers();
    try {
      const oneSecondFromNow = Math.floor((Date.now() + 1000) / 1000);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, { error: "rate limit reached" }, {
            "X-RateLimit-Reset": String(oneSecondFromNow),
            "Retry-After": "30",
          }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");

      // Advance 1.5s — past the X-RateLimit-Reset's 1s, well short of
      // the 30s Retry-After. Retry should have fired.
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await promise;

      expect(result.data).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a far-future X-RateLimit-Reset to 60s (Cloud Run timeout safety)", async () => {
    // Capsule's hour-bucket can mean a reset 50 minutes out. We can't
    // block a Cloud Run request that long; clamp at 60s and let the
    // 429 propagate after one retry.
    const fiftyMinFromNow = Math.floor((Date.now() + 50 * 60 * 1000) / 1000);
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, {}, { "X-RateLimit-Reset": String(fiftyMinFromNow) }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");
      // Advance 60s + 1ms — the clamped wait should fire by now.
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await promise;
      expect(result.data).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back gracefully when X-RateLimit-Reset is in the past", async () => {
    // Clock skew or a window that rolled over between Capsule's
    // response and our parse. Don't sleep negative time; retry quickly.
    const pastEpochSec = Math.floor((Date.now() - 60_000) / 1000);
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(429, {}, { "X-RateLimit-Reset": String(pastEpochSec) }),
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");
      // Should retry within the 5s default fallback.
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await promise;
      expect(result.data).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts AbortError (request timeout) into a clean CapsuleApiError 504", async () => {
    // doFetch imposes a 60-second AbortController-based timeout on
    // outbound Capsule HTTP calls (defense in depth — see src/capsule/
    // client.ts's REQUEST_TIMEOUT_MS comment for the backstory on why
    // the alpha.10 / alpha.11 hang reports that prompted this work
    // were almost certainly tool-approval timeouts, not Capsule
    // slowness). When the abort fires, we want a recognisable 504
    // with actionable retry guidance, not a cryptic 'fetch failed'.
    vi.mocked(fetch).mockImplementationOnce(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/test")).rejects.toThrow(
      /Capsule API request timed out after 60s/,
    );
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
