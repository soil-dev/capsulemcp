/**
 * Wire-trace probes for the v1.6.6 candidate:
 * `list_party_entries.includeLinkedPersons` (org-timeline-includes-people).
 *
 * Question the workflow wants answered: when a user asks "what's the
 * latest with $ORG?", they mean every entry attached to the
 * relationship — including ones filed against the org's linked people.
 * Capsule's `GET /parties/{orgId}/entries` only returns entries on the
 * org row itself; entries on linked persons are invisible at the org
 * level. Today an LLM has to chain get_party → list_party_entries(org)
 * → list_employees(org) → list_party_entries(personN) to surface them.
 *
 * Before plumbing a new parameter, verify the assumptions empirically.
 * Five probes:
 *
 *   1. Confirm the gap: a note filed against a linked person does NOT
 *      appear on the org's entries endpoint.
 *   2. Cross-direction: a note filed against the ORG does NOT appear
 *      on the linked person's entries endpoint either (i.e. Capsule's
 *      entries endpoint is strictly per-party-row, no upward
 *      traversal).
 *   3. Endpoint sanity: `GET /parties/{orgId}/people` returns the
 *      shape we already use in `list_employees` — confirms the
 *      enumeration step the new tool will rely on.
 *   4. Dedup on cross-party participants: does Capsule double-file an
 *      entry that mentions both the org and a linked person? Affects
 *      whether connector-side dedup is "nice-to-have" or
 *      "correctness-required."
 *   5. Person partyId no-op: `GET /parties/{personId}/people` —
 *      person parties have no linked-people relationship in the data
 *      model. Confirms how the API responds.
 *
 * Pattern mirrors scripts/wire-trace-v164.ts and -v165.ts: ZZZ-V166-*
 * labelled test records, full cleanup on exit, no tenant-specific
 * strings or IDs committed (everything discovered at runtime). Run
 * with:
 *
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace-v166.ts
 */

import { fetch } from "undici";

const TOKEN = process.env["CAPSULE_API_TOKEN"];
if (!TOKEN) {
  console.error("CAPSULE_API_TOKEN env var required (write-scoped)");
  process.exit(1);
}

const BASE = "https://api.capsulecrm.com/api/v2";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

interface ApiResult {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = await res.text().catch(() => null);
  }
  return { status: res.status, body: parsed };
}

function entriesOf(result: ApiResult): Array<{ id: number; type?: string; content?: string }> {
  const body = result.body as { entries?: Array<{ id: number; type?: string; content?: string }> };
  return body?.entries ?? [];
}

function partiesOf(result: ApiResult): Array<{ id: number; type?: string }> {
  const body = result.body as { parties?: Array<{ id: number; type?: string }> };
  return body?.parties ?? [];
}

async function main() {
  const tag = `ZZZ-V166-${Date.now()}`;
  const createdParties: number[] = [];
  const createdEntries: number[] = [];

  try {
    console.log("=== Setup: create org + linked person ===");

    const org = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-ORG` },
    });
    if (org.status !== 201) {
      console.error("Failed to create org:", org);
      process.exit(1);
    }
    const orgId = (org.body as { party: { id: number } }).party.id;
    createdParties.push(orgId);
    console.log(`  org id ${orgId}`);

    const person = await call("POST", "/parties", {
      party: {
        type: "person",
        firstName: tag,
        lastName: "PERSON",
        organisation: { id: orgId },
      },
    });
    if (person.status !== 201) {
      console.error("Failed to create linked person:", person);
      process.exit(1);
    }
    const personId = (person.body as { party: { id: number } }).party.id;
    createdParties.push(personId);
    console.log(`  person id ${personId} (linked to org)`);

    // ── Probe 1: gap exists — person entry invisible at org level ────
    console.log("\n=========================================");
    console.log("PROBE 1: note on PERSON; org's /entries should NOT include it");
    console.log("=========================================");

    const personNote = await call("POST", "/entries", {
      entry: {
        party: { id: personId },
        type: "note",
        content: `${tag} note filed against PERSON`,
      },
    });
    const personNoteId = (personNote.body as { entry: { id: number } })?.entry?.id;
    if (personNoteId) createdEntries.push(personNoteId);
    console.log(`  created note ${personNoteId} on person ${personId}`);

    const orgEntries1 = await call("GET", `/parties/${orgId}/entries`);
    const orgList1 = entriesOf(orgEntries1);
    const orgSeesPersonNote = orgList1.some((e) => e.id === personNoteId);
    console.log(`  GET /parties/${orgId}/entries → ${orgList1.length} entries`);
    console.log(
      `  org sees person's note? ${orgSeesPersonNote ? "YES (gap REFUTED)" : "NO (gap CONFIRMED)"}`,
    );

    // ── Probe 2: cross-direction — org entry invisible at person level ─
    console.log("\n=========================================");
    console.log("PROBE 2: note on ORG; person's /entries should NOT include it");
    console.log("=========================================");

    const orgNote = await call("POST", "/entries", {
      entry: {
        party: { id: orgId },
        type: "note",
        content: `${tag} note filed against ORG`,
      },
    });
    const orgNoteId = (orgNote.body as { entry: { id: number } })?.entry?.id;
    if (orgNoteId) createdEntries.push(orgNoteId);
    console.log(`  created note ${orgNoteId} on org ${orgId}`);

    const personEntries1 = await call("GET", `/parties/${personId}/entries`);
    const personList1 = entriesOf(personEntries1);
    const personSeesOrgNote = personList1.some((e) => e.id === orgNoteId);
    console.log(`  GET /parties/${personId}/entries → ${personList1.length} entries`);
    console.log(
      `  person sees org's note? ${personSeesOrgNote ? "YES (upward traversal exists)" : "NO (strictly per-row)"}`,
    );

    // ── Probe 3: endpoint sanity for linked people ───────────────────
    console.log("\n=========================================");
    console.log("PROBE 3: GET /parties/{orgId}/people — shape + content");
    console.log("=========================================");

    const peopleRes = await call("GET", `/parties/${orgId}/people`);
    const people = partiesOf(peopleRes);
    console.log(
      `  GET /parties/${orgId}/people → status ${peopleRes.status}, ${people.length} parties`,
    );
    console.log(
      `  includes our test person (${personId})? ${people.some((p) => p.id === personId)}`,
    );
    console.log(`  shape sample:`, JSON.stringify(people[0])?.slice(0, 300));

    // ── Probe 4: dedup on cross-party participants ───────────────────
    console.log("\n=========================================");
    console.log("PROBE 4: note created with `parties: [{id: orgId}, {id: personId}]`");
    console.log("         → does Capsule file once (under participants array) or twice?");
    console.log("=========================================");

    // Capsule allows entries to have multiple participants via the
    // `parties` array on POST /entries. Probe whether such an entry
    // surfaces in both per-party endpoint lists and whether the id
    // is the same (single entry, multiple references) or different
    // (one filing per participant).
    const sharedNote = await call("POST", "/entries", {
      entry: {
        parties: [{ id: orgId }, { id: personId }],
        type: "note",
        content: `${tag} note filed with BOTH org and person`,
      },
    });
    const sharedNoteId = (sharedNote.body as { entry?: { id: number } })?.entry?.id;
    if (sharedNoteId) {
      createdEntries.push(sharedNoteId);
      console.log(`  created shared note ${sharedNoteId}`);

      const orgEntries2 = await call("GET", `/parties/${orgId}/entries`);
      const personEntries2 = await call("GET", `/parties/${personId}/entries`);
      const orgList2 = entriesOf(orgEntries2);
      const personList2 = entriesOf(personEntries2);

      const orgHits = orgList2.filter((e) => e.id === sharedNoteId).length;
      const personHits = personList2.filter((e) => e.id === sharedNoteId).length;
      console.log(`  org list contains sharedNote? hits=${orgHits}`);
      console.log(`  person list contains sharedNote? hits=${personHits}`);
      console.log(
        `  → if both = 1 then naive merge yields a duplicate; dedup on entry.id required`,
      );
      console.log(
        `  → if only one = 1 then Capsule files against the FIRST party in the array only`,
      );
    } else {
      console.log(`  shared note creation failed:`, JSON.stringify(sharedNote.body)?.slice(0, 400));
      console.log(`  may indicate Capsule rejects multi-party POST /entries; check API docs`);
    }

    // ── Probe 5: person partyId no-op ─────────────────────────────────
    console.log("\n=========================================");
    console.log("PROBE 5: GET /parties/{personId}/people — person has no linked-people");
    console.log("=========================================");

    const personPeopleRes = await call("GET", `/parties/${personId}/people`);
    const personPeople = partiesOf(personPeopleRes);
    console.log(
      `  GET /parties/${personId}/people → status ${personPeopleRes.status}, ${personPeople.length} parties`,
    );
    if (personPeopleRes.status === 404) {
      console.log(`  → 404 (expected — confirms no person-level linked-people endpoint)`);
    } else if (personPeople.length === 0) {
      console.log(
        `  → 200 with empty array (Capsule responds politely; safe to ignore client-side)`,
      );
    } else {
      console.log(
        `  → 200 with ${personPeople.length} unexpected parties; investigate:`,
        JSON.stringify(personPeople)?.slice(0, 400),
      );
    }

    console.log("\nAll probes complete.");
  } catch (err) {
    console.error("\n!!! probe run crashed:", err);
  } finally {
    console.log("\n=========================================");
    console.log(
      `Cleanup: deleting ${createdEntries.length} entries + ${createdParties.length} parties...`,
    );
    console.log("=========================================");

    // Delete entries first, then parties in reverse-create order
    // (linked person before its organisation, so the FK-ish parent
    // is gone last and we don't accidentally cascade-orphan the
    // person from a delete that succeeds in reverse).
    for (const eid of createdEntries) {
      const r = await call("DELETE", `/entries/${eid}`);
      console.log(`  delete entry ${eid}: ${r.status}`);
    }
    for (const pid of createdParties.slice().reverse()) {
      const r = await call("DELETE", `/parties/${pid}`);
      console.log(`  delete party ${pid}: ${r.status}`);
    }
    console.log(`\nIf any cleanup failed, search Capsule for "${tag}" and delete manually.`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
