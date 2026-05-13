import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    mockFetch(
      200,
      { parties: [{ id: 1, type: "person" }] },
      {
        Link: '<https://api.capsulecrm.com/api/v2/parties/search?page=2&perPage=25>; rel="next"',
      },
    );

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

describe("atomic child-array operations", () => {
  // Each tool must do EXACTLY one PUT to /parties/{id} with a single
  // item in the relevant array. No GET-then-PUT diff, no value-matching
  // heuristics. The body shape mirrors Capsule's documented "merge"
  // contract: an entry without `_delete` is added, an entry
  // `{id, _delete: true}` is removed. (The field is `_delete`, NOT
  // the Rails-style `_destroy` — Capsule silently ignores the latter.
  // See NOTES-ON-CAPSULE-API.md §18.)

  it("add_party_email_address PUTs one item with no id, no _delete", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { addPartyEmailAddress } = await import("../src/tools/parties.js");
    await addPartyEmailAddress({ partyId: 99, address: "a@x.test", type: "Work" });
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/99");
    expect((opts as RequestInit).method).toBe("PUT");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.party.emailAddresses).toEqual([{ address: "a@x.test", type: "Work" }]);
    expect(body.party.emailAddresses[0].id).toBeUndefined();
    expect(body.party.emailAddresses[0]._delete).toBeUndefined();
  });

  it("remove_party_email_address_by_id PUTs {id, _delete:true} only", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { removePartyEmailAddressById } = await import("../src/tools/parties.js");
    await removePartyEmailAddressById({ partyId: 99, emailAddressId: 555 });
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/parties/99");
    expect((opts as RequestInit).method).toBe("PUT");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.party.emailAddresses).toEqual([{ id: 555, _delete: true }]);
  });

  it("add_party_phone_number PUTs one phone item with type", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { addPartyPhoneNumber } = await import("../src/tools/parties.js");
    await addPartyPhoneNumber({ partyId: 99, number: "+1-555", type: "Mobile" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.party.phoneNumbers).toEqual([{ number: "+1-555", type: "Mobile" }]);
  });

  it("add_party_phone_number rejects empty number at schema layer", async () => {
    const { addPartyPhoneNumberSchema } = await import("../src/tools/parties.js");
    expect(addPartyPhoneNumberSchema.safeParse({ partyId: 1, number: "" }).success).toBe(false);
  });

  it("remove_party_phone_number_by_id PUTs the destroy entry", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { removePartyPhoneNumberById } = await import("../src/tools/parties.js");
    await removePartyPhoneNumberById({ partyId: 99, phoneNumberId: 12 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.party.phoneNumbers).toEqual([{ id: 12, _delete: true }]);
  });

  it("add_party_address forwards only the provided sub-fields", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { addPartyAddress } = await import("../src/tools/parties.js");
    await addPartyAddress({ partyId: 99, city: "Brno", country: "USA" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    // Capsule will normalise 'USA' → 'United States' on its own.
    expect(body.party.addresses).toEqual([{ city: "Brno", country: "USA" }]);
  });

  it("remove_party_address_by_id PUTs the destroy entry", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { removePartyAddressById } = await import("../src/tools/parties.js");
    await removePartyAddressById({ partyId: 99, addressId: 7 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.party.addresses).toEqual([{ id: 7, _delete: true }]);
  });

  it("add_party_website rejects unknown service values at schema layer", async () => {
    const { addPartyWebsiteSchema } = await import("../src/tools/parties.js");
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "https://x.test",
        service: "PIGEON_POST",
      }).success,
    ).toBe(false);
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "@acmeco",
        service: "BLUESKY",
      }).success,
    ).toBe(true);
  });

  it("add_party_website PUTs one website with the documented shape", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { addPartyWebsite } = await import("../src/tools/parties.js");
    await addPartyWebsite({
      partyId: 99,
      address: "@acmeco",
      service: "TWITTER",
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.party.websites).toEqual([{ address: "@acmeco", service: "TWITTER" }]);
  });

  it("remove_party_website_by_id PUTs the destroy entry", async () => {
    mockFetch(200, { party: { id: 99 } });
    const { removePartyWebsiteById } = await import("../src/tools/parties.js");
    await removePartyWebsiteById({ partyId: 99, websiteId: 4 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.party.websites).toEqual([{ id: 4, _delete: true }]);
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

  it("rejects unknown websites.service values at the schema layer", async () => {
    // Production write-mode test caught: schema previously accepted any
    // string and let Capsule 422 with the full enum list. Now locked
    // to Capsule's documented set so typos surface pre-call.
    const { createPartySchema } = await import("../src/tools/parties.js");
    const bad = createPartySchema.safeParse({
      type: "person",
      firstName: "X",
      websites: [{ address: "https://x.test/", service: "PIGEON_POST" }],
    });
    expect(bad.success).toBe(false);

    const ok = createPartySchema.safeParse({
      type: "person",
      firstName: "X",
      websites: [{ address: "@acmeco", service: "BLUESKY" }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty phoneNumbers[].number at the schema layer", async () => {
    // Production write-mode test caught: empty string went to Capsule
    // and got 422. Schema now matches EmailAddressSchema's behaviour.
    const { createPartySchema } = await import("../src/tools/parties.js");
    const bad = createPartySchema.safeParse({
      type: "person",
      firstName: "X",
      phoneNumbers: [{ number: "", type: "Work" }],
    });
    expect(bad.success).toBe(false);
  });

  it("forwards `address` verbatim to Capsule (no key rewriting)", async () => {
    mockFetch(201, { party: { id: 1, type: "person" } });
    const { createParty } = await import("../src/tools/parties.js");
    await createParty({
      type: "person",
      firstName: "X",
      websites: [{ address: "@acmeco", service: "TWITTER" }],
    });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.party.websites).toEqual([{ address: "@acmeco", service: "TWITTER" }]);
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
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: 7 });
  });

  it("returns {alreadyDeleted: true} on 404 (idempotent destructive op)", async () => {
    // §11-12 verification observed deletion-shape ops leaking
    // Capsule's "doesn't exist" 404 to callers, breaking retry
    // loops. Now caught and converted to a success shape.
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 404,
      ok: false,
      headers: new Headers(),
      json: async () => ({ message: "party not found" }),
      statusText: "Not Found",
    } as Awaited<ReturnType<typeof fetch>>);

    const { deleteParty } = await import("../src/tools/parties.js");
    const result = await deleteParty({ id: 7, confirm: true });
    expect(result).toEqual({ deleted: true, alreadyDeleted: true, id: 7 });
  });
});

describe("updateParty custom fields", () => {
  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}]", async () => {
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({
      id: 5,
      fields: [
        { definitionId: 18, value: "Account Manager" },
        { definitionId: 22, value: 42 },
        { definitionId: 23, value: true },
        { definitionId: 24, value: null },
      ],
    });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party.fields).toEqual([
      { definition: { id: 18 }, value: "Account Manager" },
      { definition: { id: 22 }, value: 42 },
      { definition: { id: 23 }, value: true },
      { definition: { id: 24 }, value: null },
    ]);
    // The user-facing definitionId doesn't leak into the API body.
    expect(body.party.fields[0].definitionId).toBeUndefined();
  });

  it("schema rejects fields with unsupported value types", async () => {
    const { updatePartySchema } = await import("../src/tools/parties.js");
    // Arrays and objects are not in the union (string/number/boolean/null)
    expect(
      updatePartySchema.safeParse({
        id: 5,
        fields: [{ definitionId: 1, value: { nested: true } }],
      }).success,
    ).toBe(false);
    expect(
      updatePartySchema.safeParse({
        id: 5,
        fields: [{ definitionId: 1, value: [1, 2] }],
      }).success,
    ).toBe(false);
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
    await expect(createParty({ type: "person" })).rejects.toThrow(
      /Party\.name: can't be blank.*Party\.type: must be person/,
    );
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
    expect(() => getPartiesSchema.parse({ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).toThrow();
  });
});
