/**
 * Wire-trace probes for the v1.6.5 tool-surface consistency sweep —
 * empirically verify Capsule's behaviour on three asymmetries
 * surfaced by the v1.6.4 consistency audit:
 *
 *   A. PUT /opportunities/:id { owner: null }            — verify owner-clear on opp
 *      PUT /opportunities/:id { owner: null, team: {id} } — combined transfer-to-team
 *      (v1.6.4 confirmed this works on /parties; here we confirm
 *      /opportunities mirrors the semantic so update_opportunity.ownerId
 *      can become nullable to match update_party / update_project.)
 *
 *   B. PUT /kases/:id { stage: null }                    — verify stage-clear on project
 *      (create_project.stageId is optional, but update_project.stageId
 *      was non-nullable; this probe confirms callers can move a project
 *      off all stages via PUT.)
 *
 *   C. POST /parties|/opportunities|/kases { ..., fields: [...] }
 *      — verify custom-field writes on CREATE (the v1.6.3-era surface
 *      only accepted fields[] on PUT, forcing a create-then-update
 *      ritual for any caller setting custom fields on new records).
 *
 * Pattern mirrors scripts/wire-trace-v163.ts and -v164.ts: ZZZ-V165-*
 * labelled test records, full cleanup on exit, no tenant-specific
 * strings or IDs in the committed source (everything is discovered at
 * runtime). Run with:
 *
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace-v165.ts
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

function pp(label: string, result: ApiResult, fieldsToShow: string[] = []): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  status: ${result.status}`);
  if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
    const obj = result.body as Record<string, unknown>;
    const wrapperKey = Object.keys(obj).find((k) =>
      ["party", "opportunity", "kase", "task"].includes(k),
    );
    if (wrapperKey && fieldsToShow.length > 0) {
      const entity = obj[wrapperKey] as Record<string, unknown>;
      console.log(`  ${wrapperKey}.id: ${entity["id"]}`);
      for (const f of fieldsToShow) {
        console.log(`  ${wrapperKey}.${f}: ${JSON.stringify(entity[f])}`);
      }
    } else {
      console.log(`  body:`, JSON.stringify(result.body, null, 2)?.slice(0, 600));
    }
  } else {
    console.log(`  body:`, JSON.stringify(result.body, null, 2)?.slice(0, 600));
  }
}

interface FieldDefinitionListItem {
  id: number;
  name: string;
  type: string;
}

interface FieldDefinitionFull extends FieldDefinitionListItem {
  options?: Array<{ value: string } | string>;
}

/**
 * Discover a custom-field definition for `entity` whose value we can
 * write without guessing. Strategy:
 *   1. Prefer TEXT/LARGE_TEXT — any non-empty string is valid.
 *   2. Otherwise fall back to a LIST type and read its first option
 *      value (Capsule's `options` array on the full definition).
 * Returns `{id, sampleValue}` or null if neither shape is available.
 */
async function discoverWritableFieldDef(
  entity: "parties" | "opportunities" | "kases",
): Promise<{ id: number; sampleValue: string; type: string } | null> {
  const list = await call("GET", `/${entity}/fields/definitions`);
  const defs = (list.body as { definitions?: FieldDefinitionListItem[] })?.definitions ?? [];

  const text = defs.find(
    (d) =>
      d.type === "TEXT" || d.type === "LARGE_TEXT" || d.type === "text" || d.type === "large_text",
  );
  if (text) return { id: text.id, sampleValue: "v165 probe value", type: text.type };

  const listType = defs.find((d) => d.type === "LIST" || d.type === "list");
  if (!listType) return null;

  const full = await call("GET", `/${entity}/fields/definitions/${listType.id}`);
  const fullDef = (full.body as { definition?: FieldDefinitionFull })?.definition;
  if (!fullDef?.options || fullDef.options.length === 0) return null;
  const firstOpt = fullDef.options[0]!;
  const value = typeof firstOpt === "string" ? firstOpt : firstOpt.value;
  return { id: listType.id, sampleValue: value, type: listType.type };
}

async function main() {
  const tag = `ZZZ-V165-${Date.now()}`;
  const created: { kind: "party" | "opportunity" | "kase"; id: number }[] = [];

  try {
    // ── Discovery ─────────────────────────────────────────────────────
    console.log("=== Discovery ===");

    const teamsRes = await call("GET", "/teams");
    const teams = (teamsRes.body as { teams?: { id: number; name: string }[] })?.teams ?? [];
    if (teams.length === 0) {
      console.error("No teams in tenant. Create one before re-running.");
      process.exit(1);
    }
    const teamId = teams[0]!.id;
    console.log(`  team id ${teamId}`);

    const milestonesRes = await call("GET", "/milestones");
    const milestones =
      (milestonesRes.body as { milestones?: { id: number; name: string }[] })?.milestones ?? [];
    const openMilestone = milestones.find((m) => (m as { closed?: boolean }).closed !== true);
    if (!openMilestone) {
      console.error("No open milestone in tenant. Cannot create probe opportunity.");
      process.exit(1);
    }
    const milestoneId = openMilestone.id;
    console.log(`  milestone id ${milestoneId}`);

    const stagesRes = await call("GET", "/stages");
    const stages = (stagesRes.body as { stages?: { id: number; name: string }[] })?.stages ?? [];
    if (stages.length === 0) {
      console.error("No stages in tenant. Cannot create probe project with stage.");
      process.exit(1);
    }
    const stageId = stages[0]!.id;
    console.log(`  stage id ${stageId}`);

    const partyFieldDef = await discoverWritableFieldDef("parties");
    const oppFieldDef = await discoverWritableFieldDef("opportunities");
    const projectFieldDef = await discoverWritableFieldDef("kases");
    console.log(
      `  party custom field:   ${partyFieldDef ? `id=${partyFieldDef.id} type=${partyFieldDef.type}` : "NONE"}`,
    );
    console.log(
      `  opp custom field:     ${oppFieldDef ? `id=${oppFieldDef.id} type=${oppFieldDef.type}` : "NONE"}`,
    );
    console.log(
      `  project custom field: ${projectFieldDef ? `id=${projectFieldDef.id} type=${projectFieldDef.type}` : "NONE"}`,
    );

    // Setup party (parent for opp + project probes).
    const setupParty = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-SETUP-PARTY` },
    });
    pp("setup: create org party", setupParty, ["name"]);
    const partyId = (setupParty.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: partyId });

    // ── PROBE A: PUT /opportunities/:id { owner: null } ──────────────
    console.log("\n=========================================");
    console.log("PROBE A: PUT /opportunities/:id with owner: null");
    console.log("=========================================");

    const opp = await call("POST", "/opportunities", {
      opportunity: {
        name: `${tag}-OPP-A`,
        party: { id: partyId },
        milestone: { id: milestoneId },
      },
    });
    pp("create opp (owner default)", opp, ["owner", "team"]);
    const oppId = (opp.body as { opportunity: { id: number } }).opportunity.id;
    created.push({ kind: "opportunity", id: oppId });

    const pA1 = await call("PUT", `/opportunities/${oppId}`, {
      opportunity: { owner: null },
    });
    pp(`A1: PUT /opportunities/${oppId} { owner: null }`, pA1, ["owner", "team"]);

    const pA2 = await call("PUT", `/opportunities/${oppId}`, {
      opportunity: { owner: null, team: { id: teamId } },
    });
    pp(`A2: PUT /opportunities/${oppId} { owner: null, team: {id} }`, pA2, ["owner", "team"]);

    // ── PROBE B: PUT /kases/:id { stage: null } ──────────────────────
    console.log("\n=========================================");
    console.log("PROBE B: PUT /kases/:id { stage: null }");
    console.log("=========================================");

    const project = await call("POST", "/kases", {
      kase: {
        name: `${tag}-PROJECT-B`,
        party: { id: partyId },
        status: "OPEN",
        stage: stageId,
      },
    });
    pp("create project (with stage)", project, ["stage", "owner", "team"]);
    const projectId = (project.body as { kase: { id: number } }).kase.id;
    created.push({ kind: "kase", id: projectId });

    const pB1 = await call("PUT", `/kases/${projectId}`, {
      kase: { stage: null },
    });
    pp(`B1: PUT /kases/${projectId} { stage: null }`, pB1, ["stage", "owner", "team"]);

    // ── PROBE C: POST with fields[] ──────────────────────────────────
    console.log("\n=========================================");
    console.log("PROBE C: POST /<entity> { fields: [...] }");
    console.log("=========================================");

    if (partyFieldDef) {
      const cP = await call("POST", "/parties", {
        party: {
          type: "organisation",
          name: `${tag}-C-PARTY`,
          fields: [{ definition: { id: partyFieldDef.id }, value: partyFieldDef.sampleValue }],
        },
      });
      pp(`C-party: POST /parties { fields: [def=${partyFieldDef.id}] }`, cP, ["name"]);
      if (cP.status === 201 || cP.status === 200) {
        const cpId = (cP.body as { party: { id: number } }).party.id;
        created.push({ kind: "party", id: cpId });
        // Re-fetch with embed=fields to confirm the value was persisted.
        const cPread = await call("GET", `/parties/${cpId}?embed=fields`);
        const fields = (cPread.body as { party?: { fields?: unknown[] } })?.party?.fields;
        console.log(`  party.fields (after embed=fields read): ${JSON.stringify(fields)}`);
      }
    } else {
      console.log("\n--- C-party: SKIPPED (no writable party custom field in tenant) ---");
    }

    if (oppFieldDef) {
      const cO = await call("POST", "/opportunities", {
        opportunity: {
          name: `${tag}-C-OPP`,
          party: { id: partyId },
          milestone: { id: milestoneId },
          fields: [{ definition: { id: oppFieldDef.id }, value: oppFieldDef.sampleValue }],
        },
      });
      pp(`C-opp: POST /opportunities { fields: [def=${oppFieldDef.id}] }`, cO, ["name"]);
      if (cO.status === 201 || cO.status === 200) {
        const coId = (cO.body as { opportunity: { id: number } }).opportunity.id;
        created.push({ kind: "opportunity", id: coId });
        const cOread = await call("GET", `/opportunities/${coId}?embed=fields`);
        const fields = (cOread.body as { opportunity?: { fields?: unknown[] } })?.opportunity
          ?.fields;
        console.log(`  opportunity.fields (after embed=fields read): ${JSON.stringify(fields)}`);
      }
    } else {
      console.log("\n--- C-opp: SKIPPED (no writable opp custom field in tenant) ---");
    }

    if (projectFieldDef) {
      const cK = await call("POST", "/kases", {
        kase: {
          name: `${tag}-C-PROJECT`,
          party: { id: partyId },
          status: "OPEN",
          fields: [{ definition: { id: projectFieldDef.id }, value: projectFieldDef.sampleValue }],
        },
      });
      pp(`C-kase: POST /kases { fields: [def=${projectFieldDef.id}] }`, cK, ["name"]);
      if (cK.status === 201 || cK.status === 200) {
        const ckId = (cK.body as { kase: { id: number } }).kase.id;
        created.push({ kind: "kase", id: ckId });
        const cKread = await call("GET", `/kases/${ckId}?embed=fields`);
        const fields = (cKread.body as { kase?: { fields?: unknown[] } })?.kase?.fields;
        console.log(`  kase.fields (after embed=fields read): ${JSON.stringify(fields)}`);
      }
    } else {
      console.log("\n--- C-kase: SKIPPED (no writable project custom field in tenant) ---");
    }

    console.log("\nAll probes complete.");
  } catch (err) {
    console.error("\n!!! probe run crashed:", err);
  } finally {
    console.log("\n=========================================");
    console.log(`Cleanup: deleting ${created.length} records...`);
    console.log("=========================================");
    // Delete children before parents: opportunities and kases first.
    const order = (a: { kind: string }, b: { kind: string }) => {
      const rank = (k: string) => (k === "party" ? 2 : 1);
      return rank(a.kind) - rank(b.kind);
    };
    for (const { kind, id } of [...created].sort(order)) {
      const path =
        kind === "opportunity"
          ? `/opportunities/${id}`
          : kind === "kase"
            ? `/kases/${id}`
            : `/parties/${id}`;
      const res = await call("DELETE", path);
      console.log(`  delete ${kind} ${id}: ${res.status}`);
    }
    console.log(`\nIf any cleanup failed, search Capsule for "${tag}" and delete manually.`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
