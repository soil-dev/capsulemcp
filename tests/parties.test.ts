import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const responseHeaders = new Headers(headers);
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("searchParties", () => {
  it("routes to /parties/search when q is provided", async () => {
    mockFetch(200, { parties: [{ id: 1, type: "person" }] }, {
      Link: '<https://api.capsulecrm.com/api/v2/parties/search?page=2&perPage=25>; rel="next"',
    });

    const { searchParties } = await import("../src/tools/parties.js");
    const result = await searchParties({ q: "alice", page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/search");
    expect(url).toContain("q=alice");
    expect(result.parties).toHaveLength(1);
    expect(result.nextPage).toBe(2);
  });

  it("routes to /parties (no /search) when q is omitted", async () => {
    mockFetch(200, { parties: [] });

    const { searchParties } = await import("../src/tools/parties.js");
    await searchParties({ page: 1, perPage: 25 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties?");
    expect(url).not.toContain("/search");
  });

  it("returns undefined nextPage when no Link header", async () => {
    mockFetch(200, { parties: [] });

    const { searchParties } = await import("../src/tools/parties.js");
    const result = await searchParties({ page: 1, perPage: 25 });

    expect(result.nextPage).toBeUndefined();
  });
});

describe("getParty", () => {
  it("returns the party object", async () => {
    mockFetch(200, { party: { id: 42, type: "organisation", name: "Acme" } });

    const { getParty } = await import("../src/tools/parties.js");
    const result = await getParty({ id: 42 });

    expect((result as { party: { name: string } }).party.name).toBe("Acme");
  });
});

describe("createParty", () => {
  it("posts to /parties and returns the created party", async () => {
    const created = { party: { id: 99, type: "person", firstName: "Bob" } };
    mockFetch(201, created, { Location: "https://api.capsulecrm.com/api/v2/parties/99" });

    const { createParty } = await import("../src/tools/parties.js");
    const result = await createParty({ type: "person", firstName: "Bob", lastName: "Smith" });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/parties"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual(created);
  });
});

describe("updateParty", () => {
  it("puts to /parties/:id with only provided fields", async () => {
    const updated = { party: { id: 5, type: "person", jobTitle: "CTO" } };
    mockFetch(200, updated);

    const { updateParty } = await import("../src/tools/parties.js");
    const result = await updateParty({ id: 5, jobTitle: "CTO" });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/parties/5"),
      expect.objectContaining({ method: "PUT" }),
    );
    expect(result).toEqual(updated);
  });
});

describe("auth errors", () => {
  it("throws CapsuleAuthError on 401", async () => {
    mockFetch(401, { message: "Unauthorized" });

    const { getParty } = await import("../src/tools/parties.js");
    await expect(getParty({ id: 1 })).rejects.toThrow("401");
  });

  it("throws if CAPSULE_API_TOKEN is missing", async () => {
    delete process.env["CAPSULE_API_TOKEN"];

    const { getParty } = await import("../src/tools/parties.js");
    await expect(getParty({ id: 1 })).rejects.toThrow("CAPSULE_API_TOKEN");
  });
});

describe("429 retry", () => {
  it("falls back to a default delay when Retry-After is an HTTP-date (no NaN setTimeout)", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          status: 429,
          ok: false,
          // HTTP-date in the past — must not produce a NaN delay.
          headers: new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
          json: async () => ({}),
          statusText: "Too Many Requests",
        } as Awaited<ReturnType<typeof fetch>>)
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          headers: new Headers(),
          json: async () => ({ parties: [] }),
          statusText: "OK",
        } as Awaited<ReturnType<typeof fetch>>);

      const { searchParties } = await import("../src/tools/parties.js");
      const promise = searchParties({ page: 1, perPage: 25 });

      // If parseRetryAfter returned NaN, setTimeout would resolve immediately
      // and the second fetch would be issued before we advance timers. By
      // advancing exactly the default delay we prove the wait is finite.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.parties).toEqual([]);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once on 429 and returns result on second attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        status: 429,
        ok: false,
        headers: new Headers({ "Retry-After": "0.01" }),
        json: async () => ({}),
        statusText: "Too Many Requests",
      } as Awaited<ReturnType<typeof fetch>>)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({ parties: [] }),
        statusText: "OK",
      } as Awaited<ReturnType<typeof fetch>>);

    const { searchParties } = await import("../src/tools/parties.js");
    const result = await searchParties({ page: 1, perPage: 25 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.parties).toEqual([]);
  });
});
