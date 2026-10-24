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
      .mockResolvedValueOnce(makeResponse(429, { message: "rate limited" }, { "Retry-After": "0" }))
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
      .mockResolvedValueOnce(makeResponse(429, { message: "rate limited" }, { "Retry-After": "0" }))
      .mockResolvedValueOnce(
        makeResponse(429, { message: "still rate limited" }, { "Retry-After": "0" }),
      );

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow(/Rate limit exceeded after one retry/);
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

  it("surfaces an absurdly large integer-seconds Retry-After at once: one fetch, no sleep", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": "9999" }));

    const { capsuleGet } = await import("../src/capsule/client.js");
    const startedAt = Date.now();
    // 9999 s is beyond Capsule's one-hour window: capped at 61 min.
    await expect(capsuleGet("/test")).rejects.toThrow(/resets in about 61 min.*Not retried/s);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("passes through non-429 errors without retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(500, { message: "server error" }));

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
          makeResponse(
            429,
            { error: "rate limit reached" },
            {
              "X-RateLimit-Limit": "4000",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(twoSecondsFromNow),
            },
          ),
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
          makeResponse(
            429,
            { error: "rate limit reached" },
            {
              "X-RateLimit-Reset": String(oneSecondFromNow),
              "Retry-After": "30",
            },
          ),
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

  it("surfaces a far-future X-RateLimit-Reset at once: one fetch, no sleep, no doomed retry", async () => {
    // Capsule's hour-bucket can mean a reset 50 minutes out. Earlier
    // versions clamped that to a 60 s sleep and then retried — pinning a
    // request slot for a minute to send a request guaranteed to 429.
    const fiftyMinFromNow = Math.floor((Date.now() + 50 * 60 * 1000) / 1000);
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(429, {}, { "X-RateLimit-Reset": String(fiftyMinFromNow) }),
    );

    const { capsuleGet, CapsuleApiError } = await import("../src/capsule/client.js");
    const startedAt = Date.now();
    const err = await capsuleGet("/test").catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(CapsuleApiError);
    expect((err as InstanceType<typeof CapsuleApiError>).status).toBe(429);
    expect((err as Error).message).toMatch(/resets in about 50 min/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("still waits and retries once when the reset is within 60 s (boundary)", async () => {
    vi.useFakeTimers();
    try {
      const in59s = Math.floor((Date.now() + 59_000) / 1000);
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(429, {}, { "X-RateLimit-Reset": String(in59s) }))
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");
      await vi.advanceTimersByTimeAsync(60_001);
      expect((await promise).data).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait when the reset is just over 60 s (boundary)", async () => {
    const in62s = Math.floor((Date.now() + 62_000) / 1000);
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(429, {}, { "X-RateLimit-Reset": String(in62s) }),
    );
    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/test")).rejects.toThrow(/resets in about 2 min\. Not retried/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("boundary is exclusive: Retry-After 60 waits and retries, 61 surfaces at once", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": "60" }))
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const { capsuleGet } = await import("../src/capsule/client.js");
      const promise = capsuleGet<{ ok: boolean }>("/test");
      await vi.advanceTimersByTimeAsync(60_001);
      expect((await promise).data).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": "61" }));
    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/test")).rejects.toThrow(/Not retried/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("surfaces a far-future Retry-After HTTP-date at once", async () => {
    const inTwentyMin = new Date(Date.now() + 20 * 60_000).toUTCString();
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": inTwentyMin }));
    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/test")).rejects.toThrow(/resets in about 20 min/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("caps an absurd reset header at Capsule's one-hour window (no 'Infinity')", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429, {}, { "X-RateLimit-Reset": "1e306" }));
    const { capsuleGet } = await import("../src/capsule/client.js");
    const err = (await capsuleGet("/test").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/resets in about 61 min/);
    expect(err.message).not.toMatch(/Infinity|NaN/);
  });

  it("in the window's last minute a call still fails fast — no hidden sleep a client could time out on", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const { openRateLimitWindow } = await import("../src/capsule/rate-limit-window.js");
      openRateLimitWindow(Date.now() + 30_000);
      const { capsulePut } = await import("../src/capsule/client.js");
      // Rejected at once: a write must never sit in a sleep and land
      // after the MCP client has given up on the call (and retried it).
      await expect(capsulePut("/parties/1", { party: {} })).rejects.toThrow(/about 1 min/);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-01-01T00:00:30.001Z"));
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, { ok: true }));
      expect(await capsulePut<{ ok: boolean }>("/parties/1", { party: {} })).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a short back-off does not retry once a concurrent call has learnt of a long window", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": "30" }));
      const { capsuleGet } = await import("../src/capsule/client.js");
      const { openRateLimitWindow } = await import("../src/capsule/rate-limit-window.js");
      const promise = capsuleGet("/parties").catch((e: unknown) => e as Error);
      await vi.advanceTimersByTimeAsync(10_000);
      openRateLimitWindow(Date.now() + 40 * 60_000); // learnt by another call meanwhile
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await promise;
      expect((err as Error).message).toMatch(/resets in about 40 min/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wall-clock step backwards cannot stretch the window past the one-hour cap", async () => {
    const { openRateLimitWindow, rateLimitWindowLeft } = await import(
      "../src/capsule/rate-limit-window.js"
    );
    const now = Date.now();
    openRateLimitWindow(now + 10 * 60_000);
    const stepped = now - 2 * 60 * 60_000; // clock jumps two hours back
    expect(rateLimitWindowLeft(stepped)).toBe(61 * 60_000);
    // The deadline itself was pulled in, so the window really ENDS 61 min
    // after the step — not two hours and ten minutes later.
    expect(rateLimitWindowLeft(stepped + 30 * 60_000)).toBe(31 * 60_000);
    expect(rateLimitWindowLeft(stepped + 61 * 60_000 + 1)).toBeLessThanOrEqual(0);
  });

  it("the window is shared by module copies loaded after vi.resetModules()", async () => {
    const first = await import("../src/capsule/rate-limit-window.js");
    first.openRateLimitWindow(Date.now() + 50 * 60_000);
    vi.resetModules();
    const second = await import("../src/capsule/rate-limit-window.js");
    expect(second.rateLimitWindowLeft()).toBeGreaterThan(49 * 60_000);
    second._resetRateLimitStateForTests();
    expect(first.rateLimitWindowLeft()).toBeLessThanOrEqual(0);
  });

  it("remembers the announced window: later calls fail fast WITHOUT a request until the reset", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const resetEpochSec = Math.floor((Date.now() + 30 * 60_000) / 1000);
      vi.mocked(fetch).mockResolvedValueOnce(
        makeResponse(429, {}, { "X-RateLimit-Reset": String(resetEpochSec) }),
      );
      const { capsuleGet, capsulePut } = await import("../src/capsule/client.js");
      await expect(capsuleGet("/parties")).rejects.toThrow(/about 30 min/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      // Inside the window: reads and writes alike are refused locally.
      await expect(capsuleGet("/opportunities")).rejects.toThrow(/about 30 min/);
      vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
      await expect(capsulePut("/parties/1", { party: {} })).rejects.toThrow(/about 10 min/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      // After the reset, requests flow again.
      vi.setSystemTime(new Date("2026-01-01T00:30:01.000Z"));
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, { ok: true }));
      expect((await capsuleGet<{ ok: boolean }>("/parties")).data).toEqual({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
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
        .mockResolvedValueOnce(makeResponse(429, {}, { "X-RateLimit-Reset": String(pastEpochSec) }))
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
    await expect(capsuleGet("/test")).rejects.toThrow(/Capsule API request timed out after 60s/);
  });

  it("converts mid-body-stream AbortError into a clean CapsuleApiError 504", async () => {
    // Regression: pre-1.0 the timeout AbortController was cleared in
    // a `finally` block of the fetch() call itself, so a Capsule
    // response that returned headers promptly but then stalled
    // mid-body (`res.json()` / `res.arrayBuffer()` / streaming read)
    // ran un-timed, pinning the request indefinitely. The fix keeps
    // the timer alive through body consumption and routes every
    // body-read site through mapAbort() so a streaming abort surfaces
    // as the same 504 a fetch-stage abort does.
    //
    // The mock here simulates exactly that: fetch() resolves with a
    // Response whose `json()` rejects with AbortError, mimicking the
    // controller firing after the headers arrived.
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
      statusText: "200",
    } as unknown as Awaited<ReturnType<typeof fetch>>);
    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/test")).rejects.toThrow(/Capsule API request timed out after 60s/);
  });

  it("does NOT retry on 401 (auth error surfaces immediately)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(401, { message: "Bad credentials" }));

    const { capsuleGet } = await import("../src/capsule/client.js");
    await expect(capsuleGet("/parties")).rejects.toThrow(/Capsule API returned 401/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
