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

  it("add_party_website rejects non-URL address when service is 'URL' or omitted", async () => {
    // Capsule stores user-supplied strings verbatim — a bare handle
    // mistakenly tagged service='URL' (or service omitted, which
    // defaults to URL) would land in Capsule as-is and surface to
    // any downstream UI that renders party websites. Schema-level
    // rejection avoids that.
    const { addPartyWebsiteSchema } = await import("../src/tools/parties.js");
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "@acmeco",
        service: "URL",
      }).success,
    ).toBe(false);
    // service omitted → Capsule defaults to URL → also rejected.
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "not a url",
      }).success,
    ).toBe(false);
    // Bare hostname (no scheme) is also not a URL per WHATWG.
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "example.com",
        service: "URL",
      }).success,
    ).toBe(false);
    // https / http are accepted.
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "https://example.com",
        service: "URL",
      }).success,
    ).toBe(true);
    expect(
      addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: "http://example.com",
      }).success,
    ).toBe(true);
  });

  it("add_party_website rejects non-http(s) URL protocols", async () => {
    // Defence-in-depth against the connector being used to plant
    // a harmful link via a write tool — Capsule's API stores these
    // verbatim, and downstream UIs may render stored websites as
    // clickable links.
    const { addPartyWebsiteSchema } = await import("../src/tools/parties.js");
    for (const dangerous of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com",
      "mailto:admin@example.com",
    ]) {
      const result = addPartyWebsiteSchema.safeParse({
        partyId: 1,
        address: dangerous,
        service: "URL",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/protocol .* is not allowed/);
      }
    }
  });

  it("add_party_website leaves non-URL services unvalidated (handles are OK)", async () => {
    // The URL validator only fires when service === 'URL' (or is
    // omitted). For TWITTER/BLUESKY/etc., '@handle' or any other
    // service-specific string is accepted as-is.
    const { addPartyWebsiteSchema } = await import("../src/tools/parties.js");
    for (const service of ["TWITTER", "BLUESKY", "GITHUB", "SKYPE"]) {
      expect(
        addPartyWebsiteSchema.safeParse({
          partyId: 1,
          address: "@acmeco",
          service,
        }).success,
      ).toBe(true);
    }
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

  // ── v1.6.5: fields[] on create_party ───────────────────────────────
  it("maps fields:[{definitionId,value}] → fields:[{definition:{id},value}] on create (v1.6.5)", async () => {
    // Verified empirically in v1.6.5 wire-trace probe C-party: Capsule's
    // POST /parties accepts the same fields[] shape as PUT, eliminating
    // the create-then-update ritual for custom-field writes.
    mockFetch(201, { party: { id: 1, type: "person" } });

    const { createParty } = await import("../src/tools/parties.js");
    await createParty({
      type: "person",
      firstName: "X",
      fields: [{ definitionId: 99, value: "v165 sample" }],
    });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.party.fields).toEqual([{ definition: { id: 99 }, value: "v165 sample" }]);
    expect(body.party.fields[0].definitionId).toBeUndefined();
  });

  it("omits the fields key when no custom fields are supplied (v1.6.5)", async () => {
    mockFetch(201, { party: { id: 1, type: "person" } });

    const { createParty } = await import("../src/tools/parties.js");
    await createParty({ type: "person", firstName: "X" });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.party).not.toHaveProperty("fields");
  });

  it("rejects null owner/team on create while update still allows clears", async () => {
    const { createPartySchema, updatePartySchema } = await import("../src/tools/parties.js");

    expect(
      createPartySchema.safeParse({ type: "person", firstName: "X", ownerId: null }).success,
    ).toBe(false);
    expect(
      createPartySchema.safeParse({ type: "person", firstName: "X", teamId: null }).success,
    ).toBe(false);
    expect(updatePartySchema.safeParse({ id: 1, ownerId: null }).success).toBe(true);
    expect(updatePartySchema.safeParse({ id: 1, teamId: null }).success).toBe(true);
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

  it("maps organisationId → organisation:{id} to link a person to an org (v1.6.3)", async () => {
    // Production bug report: persons created without an org link could
    // not be attached to an organisation later — the schema dropped
    // organisationId silently. v1.6.3 adds it; wire-trace confirmed
    // the PUT body shape and that Capsule sets the link.
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, organisationId: 99 });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party.organisation).toEqual({ id: 99 });
    expect(body.party.organisationId).toBeUndefined();
  });

  it("maps organisationId: null → organisation:null to orphan a person (v1.6.3)", async () => {
    // Wire-trace confirmed Capsule accepts {organisation: null} on a
    // person and returns the party with organisation: null in the
    // response. Used to dissolve a person→org link without deleting
    // either record.
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, organisationId: null });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party).toHaveProperty("organisation", null);
  });

  it("maps teamId → team:{id} (v1.6.4)", async () => {
    // Reporter scenario: transfer 16 organisation parties to team
    // ownership. Pre-v1.6.4 the schema didn't expose teamId so the
    // field was silently dropped. v1.6.4 plumbs it through with
    // wire-trace-confirmed PUT body shape. teamId-only update does
    // NOT fire the defensive RMW (only ownerId-touched does) — one
    // fetch, no GET.
    mockFetch(200, { party: { id: 5 } });

    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, teamId: 88 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party.team).toEqual({ id: 88 });
    expect(body.party.teamId).toBeUndefined();
  });

  it("teamId: null clears the team (v1.6.4)", async () => {
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, teamId: null });

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party).toHaveProperty("team", null);
  });

  it("ownerId: null clears the owner (v1.6.4)", async () => {
    // Wire-trace probe E/F confirmed: PUT /parties/:id { owner: null }
    // succeeds on both person and organisation, clearing the field.
    // Pre-v1.6.4 ownerId was non-nullable; this is the new behavior.
    mockFetch(200, { party: { id: 5, team: null } }); // GET (RMW reads since ownerId touched + teamId omitted)
    mockFetch(200, { party: { id: 5 } }); // PUT

    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, ownerId: null });

    // 2 fetches: defensive GET + PUT
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const body = JSON.parse((putOptions as RequestInit).body as string);
    expect(body.party).toHaveProperty("owner", null);
  });

  it("ownerId: null + teamId: <id> in one call — the reporter's transfer-to-team-ownership scenario (v1.6.4)", async () => {
    // Wire-trace probe G: PUT { owner: null, team: { id: T } } on an
    // org lands as { owner: null, team: { id: T } }. The owner∈team
    // membership rule doesn't fire when owner is null. No defensive
    // GET because both fields are explicit.
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, ownerId: null, teamId: 88 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party).toHaveProperty("owner", null);
    expect(body.party.team).toEqual({ id: 88 });
  });

  it("ownerId touched + teamId omitted: defensive RMW carries current team forward (v1.6.4 §27 mitigation)", async () => {
    // Mirrors the update_project / update_opportunity pattern: when
    // ownerId is being touched and teamId is omitted, fetch the
    // party's current team and include it in the PUT body so the §27
    // asymmetric clear (owner-in-body clears team) doesn't fire.
    mockFetch(200, { party: { id: 5, team: { id: 42, name: "Ops" } } }); // GET
    mockFetch(200, { party: { id: 5 } }); // PUT

    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, ownerId: 7 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [getUrl, getOptions] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(getUrl)).toMatch(/\/parties\/5($|\?)/);
    expect((getOptions as RequestInit).method ?? "GET").toBe("GET");

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const putBody = JSON.parse((putOptions as RequestInit).body as string);
    expect(putBody.party.owner).toEqual({ id: 7 });
    // Team preserved from the GET — without this, Capsule would clear it.
    expect(putBody.party.team).toEqual({ id: 42 });
  });

  it("ownerId touched + currentTeam=null: PUT body omits team (no spurious clear)", async () => {
    // When the party has no team to begin with, the RMW still fires
    // (ownerId touched, teamId omitted) but no team is carried
    // forward — sending team: null would be a redundant clear.
    mockFetch(200, { party: { id: 5, team: null } }); // GET
    mockFetch(200, { party: { id: 5 } }); // PUT

    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, ownerId: 7 });

    const [, putOptions] = vi.mocked(fetch).mock.calls[1]!;
    const putBody = JSON.parse((putOptions as RequestInit).body as string);
    expect(putBody.party.owner).toEqual({ id: 7 });
    expect(putBody.party).not.toHaveProperty("team");
  });

  it("ownerId + explicit teamId: no defensive GET (both fields explicit)", async () => {
    mockFetch(200, { party: { id: 5 } });
    const { updateParty } = await import("../src/tools/parties.js");
    await updateParty({ id: 5, ownerId: 7, teamId: 88 });

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.party.owner).toEqual({ id: 7 });
    expect(body.party.team).toEqual({ id: 88 });
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
    // Cap is now 50 (was 10 before fan-out support landed). 51 ids
    // should still trip the .max(50) guard.
    const oversize = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(() => getPartiesSchema.parse({ ids: oversize })).toThrow();
  });

  it("splits >10 ids into parallel 10-id chunks and merges results", async () => {
    // 25 ids should result in 3 Capsule calls: 1-10, 11-20, 21-25.
    // Each chunk returns its slice of parties; the tool flattens.
    mockFetch(200, { parties: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })) });
    mockFetch(200, { parties: Array.from({ length: 10 }, (_, i) => ({ id: i + 11 })) });
    mockFetch(200, { parties: Array.from({ length: 5 }, (_, i) => ({ id: i + 21 })) });

    const { getParties } = await import("../src/tools/parties.js");
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const result = (await getParties({ ids })) as { parties: Array<{ id: number }> };

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/parties/1,2,3,4,5,6,7,8,9,10");
    expect(urls[1]).toContain("/parties/11,12,13,14,15,16,17,18,19,20");
    expect(urls[2]).toContain("/parties/21,22,23,24,25");
    // Result shape unchanged: { parties: [...] } with all 25 records.
    expect(result.parties).toHaveLength(25);
    expect(result.parties.map((p) => p.id)).toEqual(ids);
  });

  it("rejects the whole call if any chunk fails (Promise.all is all-or-nothing)", async () => {
    // 25 ids -> 3 chunks; the middle chunk 500s. Pin the contract: one
    // failed chunk rejects the entire getParties call (no partial result).
    mockFetch(200, { parties: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })) });
    mockFetch(500, { message: "server error" });
    mockFetch(200, { parties: Array.from({ length: 5 }, (_, i) => ({ id: i + 21 })) });

    const { getParties } = await import("../src/tools/parties.js");
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    await expect(getParties({ ids })).rejects.toThrow(/Capsule API error 500/);
  });

  it("preserves non-array sibling keys on the multi-chunk path (shape-symmetric with single-chunk)", async () => {
    // Capsule's multi-id GET returns only { parties: [...] } today, but the
    // single-chunk path returns the body verbatim — so the fan-out path
    // must carry any sibling keys too (from the first chunk) rather than
    // projecting down to just the array. 13 ids -> 2 chunks (10 + 3).
    mockFetch(200, {
      parties: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })),
      meta: "x",
    });
    mockFetch(200, {
      parties: Array.from({ length: 3 }, (_, i) => ({ id: i + 11 })),
      meta: "y",
    });

    const { getParties } = await import("../src/tools/parties.js");
    const ids = Array.from({ length: 13 }, (_, i) => i + 1);
    const result = (await getParties({ ids })) as {
      parties: Array<{ id: number }>;
      meta?: string;
    };
    expect(result.parties).toHaveLength(13);
    expect(result.meta).toBe("x"); // sibling preserved, from the first chunk
  });

  it("uses a single Capsule call for 1-10 ids (no fan-out overhead)", async () => {
    mockFetch(200, { parties: [{ id: 1 }, { id: 2 }] });
    const { getParties } = await import("../src/tools/parties.js");
    await getParties({ ids: [1, 2] });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
