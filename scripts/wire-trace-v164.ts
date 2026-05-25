/**
 * Wire-trace probes for the v1.6.4 candidate work — empirically
 * verify Capsule's PUT behaviour on the two party fields we have
 * NOT yet plumbed through update_party:
 *
 *   - team: { id } / team: null on PUT /parties/:id
 *   - owner: null on PUT /parties/:id
 *
 * Reporter scenario (the load-bearing case): 16 ORGANISATION parties,
 * end state owner=null + team=<id>. So the probes cover organisations
 * primarily, plus persons for symmetry.
 *
 * Pattern mirrors scripts/wire-trace-v163.ts: ZZZ-V164-* labelled test
 * records, full cleanup on exit. Run with:
 *
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace-v164.ts
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

function pp(label: string, result: ApiResult): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  status: ${result.status}`);
  // Print just the team/owner fields (and a short header) — the full
  // party body is too verbose and we only care about those two
  // fields for these probes.
  if (
    result.body &&
    typeof result.body === "object" &&
    "party" in (result.body as Record<string, unknown>)
  ) {
    const party = (result.body as { party: Record<string, unknown> }).party;
    console.log(`  party.id:     ${party["id"]}`);
    console.log(`  party.type:   ${party["type"]}`);
    console.log(`  party.owner:  ${JSON.stringify(party["owner"])}`);
    console.log(`  party.team:   ${JSON.stringify(party["team"])}`);
  } else {
    console.log(`  body:`, JSON.stringify(result.body, null, 2)?.slice(0, 400));
  }
}

async function main() {
  const tag = `ZZZ-V164-${Date.now()}`;
  const created: { kind: string; id: number }[] = [];

  try {
    // Discover the first team id — we need a real team to assign.
    console.log("Discovering teams...");
    const teamsRes = await call("GET", "/teams");
    const teams = (teamsRes.body as { teams: { id: number; name: string }[] }).teams;
    if (!teams || teams.length === 0) {
      console.error(
        "No teams found in tenant. Create one in Capsule UI before re-running this probe.",
      );
      process.exit(1);
    }
    const teamId = teams[0]!.id;
    console.log(`  using team id ${teamId} (name: "${teams[0]!.name}")`);

    // Setup: create one person + one organisation, both with explicit
    // owner so probes can be observed clearing it.
    console.log(`\nCreating test records (tag: ${tag})...`);

    const person = await call("POST", "/parties", {
      party: { type: "person", firstName: `${tag}-PERSON` },
    });
    pp("create person", person);
    const personId = (person.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: personId });

    const org = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-ORG` },
    });
    pp("create org", org);
    const orgId = (org.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: orgId });

    // ── PROBES ────────────────────────────────────────────────────────

    console.log("\n=========================================");
    console.log("PROBE A: PUT /parties/{org} { team: { id: T } } — set team on org");
    console.log("=========================================");
    const pA = await call("PUT", `/parties/${orgId}`, {
      party: { team: { id: teamId } },
    });
    pp(`PUT /parties/${orgId} { team: { id: ${teamId} } }`, pA);

    console.log("\n=========================================");
    console.log("PROBE B: PUT /parties/{org} { team: null } — clear team on org");
    console.log("=========================================");
    const pB = await call("PUT", `/parties/${orgId}`, {
      party: { team: null },
    });
    pp(`PUT /parties/${orgId} { team: null }`, pB);

    console.log("\n=========================================");
    console.log("PROBE C: PUT /parties/{person} { team: { id: T } } — set team on person");
    console.log("=========================================");
    const pC = await call("PUT", `/parties/${personId}`, {
      party: { team: { id: teamId } },
    });
    pp(`PUT /parties/${personId} { team: { id: ${teamId} } }`, pC);

    console.log("\n=========================================");
    console.log("PROBE D: PUT /parties/{person} { team: null } — clear team on person");
    console.log("=========================================");
    const pD = await call("PUT", `/parties/${personId}`, {
      party: { team: null },
    });
    pp(`PUT /parties/${personId} { team: null }`, pD);

    console.log("\n=========================================");
    console.log("PROBE E: PUT /parties/{person} { owner: null } — clear owner on person");
    console.log("=========================================");
    const pE = await call("PUT", `/parties/${personId}`, {
      party: { owner: null },
    });
    pp(`PUT /parties/${personId} { owner: null }`, pE);

    console.log("\n=========================================");
    console.log("PROBE F: PUT /parties/{org} { owner: null } — clear owner on org");
    console.log("=========================================");
    const pF = await call("PUT", `/parties/${orgId}`, {
      party: { owner: null },
    });
    pp(`PUT /parties/${orgId} { owner: null }`, pF);

    console.log("\n=========================================");
    console.log("PROBE G: PUT /parties/{org} { owner: null, team: { id: T } }");
    console.log("         — the reporter's actual end-state (unassigned + team-owned org)");
    console.log("=========================================");
    const pG = await call("PUT", `/parties/${orgId}`, {
      party: { owner: null, team: { id: teamId } },
    });
    pp(`PUT /parties/${orgId} { owner: null, team: { id: ${teamId} } }`, pG);

    console.log("\nAll probes complete.");
  } catch (err) {
    console.error("\n!!! probe run crashed:", err);
  } finally {
    console.log("\n=========================================");
    console.log(`Cleanup: deleting ${created.length} records...`);
    console.log("=========================================");
    for (const { kind, id } of created.reverse()) {
      const path = kind === "party" ? `/parties/${id}` : `/parties/${id}`;
      const res = await call("DELETE", path);
      console.log(`  delete ${kind} ${id}: ${res.status}`);
    }
    console.log(`\nIf any cleanup failed, search the Capsule UI for "${tag}" and delete manually.`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
