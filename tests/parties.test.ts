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

  it("websites field is named `address` (NOT `url`) — Capsule API contract", async () => {
    // Regression for the production write-mode bug (2026-05-10): the
    // schema previously called this field `url`, which Capsule rejects
    // with "website.address: address is required". The schema now uses
    // `address`; this test locks that name.
    const { createPartySchema } = await import("../src/tools/parties.js");

    // url-shaped input must be REJECTED.
    const wrongShape = createPartySchema.safeParse({
      type: "person",
      firstName: "X",
      websites: [{ url: "https://example.test/", service: "URL" }],
    });
    expect(wrongShape.success).toBe(false);

    // address-shaped input must be ACCEPTED.
    const rightShape = createPartySchema.safeParse({
      type: "person",
      firstName: "X",
      websites: [{ address: "https://example.test/", service: "URL" }],
    });
    expect(rightShape.success).toBe(true);
  });

  it("forwards `address` verbatim to Capsule (no key rewriting)", async () => {
    mockFetch(201, { party: { id: 1, type: "person" } });
    const { createParty } = await import("../src/tools/parties.js");
    await createParty({
      type: "person",
      firstName: "X",
      websites: [{ address: "@anton", service: "TWITTER" }],
    });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.party.websites).toEqual([{ address: "@anton", service: "TWITTER" }]);
  });
});

describe("deleteParty", () => {
  it("rejects confirm=false at the schema level", async () => {
    const { deletePartySchema } = await import("../src/tools/parties.js");
    expect(deletePartySchema.safeParse({ id: 1, confirm: false }).success).toBe(false);
    expect(deletePartySchema.safeParse({ id: 1 }).success).toBe(false);
    expect(deletePartySchema.safeParse({ id: 1, confirm: true }).success).toBe(true);
  });

  it("issues DELETE /parties/:id when confirm=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
      statusText: "No Content",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteParty } = await import("../src/tools/parties.js");
    const result = await deleteParty({ id: 7, confirm: true });

    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/7");
    expect((options as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, id: 7 });
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

describe("error body parsing", () => {
  it("formats Capsule's validation { errors: [...] } shape", async () => {
    mockFetch(400, {
      errors: [
        { resource: "Party", field: "name", message: "can't be blank" },
        { resource: "Party", field: "type", message: "must be person or organisation" },
      ],
    });

    const { createParty } = await import("../src/tools/parties.js");
    await expect(
      createParty({ type: "person" }),
    ).rejects.toThrow(/Party\.name: can't be blank.*Party\.type: must be person/);
  });

  it("falls back to flat { message } shape", async () => {
    mockFetch(500, { message: "Internal server error" });

    const { getParty } = await import("../src/tools/parties.js");
    await expect(getParty({ id: 1 })).rejects.toThrow(/Internal server error/);
  });
});

describe("auth errors", () => {
  it("throws CapsuleAuthError on 401 and includes the body message", async () => {
    mockFetch(401, { message: "Token expired" });

    const { getParty } = await import("../src/tools/parties.js");
    await expect(getParty({ id: 1 })).rejects.toThrow(/401.*Token expired/);
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

describe("getParties (batch)", () => {
  it("GETs /parties/{ids} with comma-joined ids", async () => {
    mockFetch(200, { parties: [{ id: 1 }, { id: 2 }] });
    const { getParties } = await import("../src/tools/parties.js");
    await getParties({ ids: [1, 2] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/parties\/1,2($|\?)/);
  });

  it("propagates embed", async () => {
    mockFetch(200, { parties: [] });
    const { getParties } = await import("../src/tools/parties.js");
    await getParties({ ids: [1], embed: "tags,fields" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("embed=tags%2Cfields");
  });

  it("rejects empty or oversize id arrays at the schema layer", async () => {
    const { getPartiesSchema } = await import("../src/tools/parties.js");
    expect(() => getPartiesSchema.parse({ ids: [] })).toThrow();
    expect(() =>
      getPartiesSchema.parse({ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
    ).toThrow();
  });
});
