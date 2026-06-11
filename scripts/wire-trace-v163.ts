/**
 * Wire-trace probes for v1.6.3 — empirically verify Capsule's PUT
 * behaviour on the four "missing parent-reference" fields we're
 * about to expose on the update_* tools:
 *
 *   - update_opportunity { partyId }    — re-parent opp
 *   - update_party       { organisationId } on a person — link/unlink
 *   - update_party       { organisationId } on an org   — should reject
 *   - update_project     { partyId }    — re-parent project
 *   - update_task        { partyId | opportunityId | projectId } — re-link task
 *
 * Each probe runs a hand-rolled PUT against the live Capsule API.
 * Results are printed to stdout for analysis. Test records are created
 * with ZZZ-V163-* prefixes so any stragglers are obvious in the UI.
 *
 * Run with:
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace-v163.ts
 *
 * Use a non-production tenant if possible. The script makes real API
 * calls — careful cleanup on success, but a crash in the wrong place
 * could leave stray records.
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
  console.log(`  body:`, JSON.stringify(result.body, null, 2)?.slice(0, 600));
}

async function main() {
  const tag = `ZZZ-V163-${Date.now()}`;
  const created: { kind: string; id: number }[] = [];

  try {
    // ── Setup: create two people, two orgs, one opp, one project, one task
    console.log(`Creating test records (tag: ${tag})...`);

    const personA = await call("POST", "/parties", {
      party: { type: "person", firstName: `${tag}-PERSON-A` },
    });
    pp("create personA", personA);
    const personAId = (personA.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: personAId });

    const personB = await call("POST", "/parties", {
      party: { type: "person", firstName: `${tag}-PERSON-B` },
    });
    const personBId = (personB.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: personBId });

    const orgX = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-ORG-X` },
    });
    const orgXId = (orgX.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: orgXId });

    const orgY = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-ORG-Y` },
    });
    const orgYId = (orgY.body as { party: { id: number } }).party.id;
    created.push({ kind: "party", id: orgYId });

    // For opp + project + task we need a milestone/board to attach to.
    // Discover the first pipeline, then first milestone via the
    // /pipelines/<id>/milestones sub-resource (Capsule's actual shape).
    const pipelines = await call("GET", "/pipelines");
    const firstPipelineId = (pipelines.body as { pipelines: { id: number }[] }).pipelines[0]!.id;
    const milestones = await call("GET", `/pipelines/${firstPipelineId}/milestones`);
    const milestoneId = (milestones.body as { milestones: { id: number }[] }).milestones[0]!.id;
    const boards = await call("GET", "/boards");
    const boardIdsRes = boards.body as { boards: { id: number }[] };
    const firstBoardId = boardIdsRes.boards[0]?.id;
    const stages = firstBoardId
      ? await call("GET", `/boards/${firstBoardId}/stages`)
      : { status: 0, body: null };
    const stageId =
      stages.status === 200
        ? ((stages.body as { stages: { id: number }[] }).stages[0]?.id ?? undefined)
        : undefined;

    const opp = await call("POST", "/opportunities", {
      opportunity: {
        name: `${tag}-OPP`,
        party: { id: personAId },
        milestone: { id: milestoneId },
      },
    });
    pp("create opp", opp);
    const oppId = (opp.body as { opportunity: { id: number } }).opportunity.id;
    created.push({ kind: "opportunity", id: oppId });

    const project = await call("POST", "/kases", {
      kase: {
        name: `${tag}-PROJECT`,
        party: { id: personAId },
        ...(stageId ? { stage: stageId } : {}),
      },
    });
    pp("create project", project);
    const projectId = (project.body as { kase: { id: number } }).kase.id;
    created.push({ kind: "kase", id: projectId });

    const task = await call("POST", "/tasks", {
      task: {
        description: `${tag}-TASK`,
        party: { id: personAId },
        dueOn: new Date().toISOString().slice(0, 10),
      },
    });
    pp("create task", task);
    const taskId = (task.body as { task: { id: number } }).task.id;
    created.push({ kind: "task", id: taskId });

    // ── PROBES ──────────────────────────────────────────────────────────

    console.log("\n=========================================");
    console.log("PROBE 1: update_opportunity { partyId } — re-parent");
    console.log("=========================================");
    const p1 = await call("PUT", `/opportunities/${oppId}`, {
      opportunity: { party: { id: personBId } },
    });
    pp(`PUT /opportunities/${oppId} { party: { id: personB } }`, p1);
    const p1Read = await call("GET", `/opportunities/${oppId}`);
    pp(`GET /opportunities/${oppId} (verify)`, p1Read);

    console.log("\n=========================================");
    console.log("PROBE 2: update_opportunity { party: null } — orphan opp?");
    console.log("=========================================");
    const p2 = await call("PUT", `/opportunities/${oppId}`, {
      opportunity: { party: null },
    });
    pp(`PUT /opportunities/${oppId} { party: null }`, p2);
    const p2Read = await call("GET", `/opportunities/${oppId}`);
    pp(`GET /opportunities/${oppId} (verify)`, p2Read);

    console.log("\n=========================================");
    console.log("PROBE 3: update_party { organisation: { id } } on a person — link");
    console.log("=========================================");
    const p3 = await call("PUT", `/parties/${personAId}`, {
      party: { organisation: { id: orgXId } },
    });
    pp(`PUT /parties/${personAId} { organisation: { id: orgX } }`, p3);
    const p3Read = await call("GET", `/parties/${personAId}`);
    pp(`GET /parties/${personAId} (verify)`, p3Read);

    console.log("\n=========================================");
    console.log("PROBE 4: update_party { organisation: null } on a person — unlink");
    console.log("=========================================");
    const p4 = await call("PUT", `/parties/${personAId}`, {
      party: { organisation: null },
    });
    pp(`PUT /parties/${personAId} { organisation: null }`, p4);
    const p4Read = await call("GET", `/parties/${personAId}`);
    pp(`GET /parties/${personAId} (verify)`, p4Read);

    console.log("\n=========================================");
    console.log("PROBE 5: update_party { organisation: { id } } on an org — should reject?");
    console.log("=========================================");
    const p5 = await call("PUT", `/parties/${orgXId}`, {
      party: { organisation: { id: orgYId } },
    });
    pp(`PUT /parties/${orgXId} { organisation: { id: orgY } }`, p5);

    console.log("\n=========================================");
    console.log("PROBE 6: update_project { party: { id } } — re-parent");
    console.log("=========================================");
    const p6 = await call("PUT", `/kases/${projectId}`, {
      kase: { party: { id: personBId } },
    });
    pp(`PUT /kases/${projectId} { party: { id: personB } }`, p6);
    const p6Read = await call("GET", `/kases/${projectId}`);
    pp(`GET /kases/${projectId} (verify)`, p6Read);

    console.log("\n=========================================");
    console.log("PROBE 7: update_task { party: { id } } — re-link to different party");
    console.log("=========================================");
    const p7 = await call("PUT", `/tasks/${taskId}`, {
      task: { party: { id: personBId } },
    });
    pp(`PUT /tasks/${taskId} { party: { id: personB } }`, p7);
    const p7Read = await call("GET", `/tasks/${taskId}`);
    pp(`GET /tasks/${taskId} (verify)`, p7Read);

    console.log("\n=========================================");
    console.log("PROBE 8: update_task { party: null } — orphan a task?");
    console.log("=========================================");
    const p8 = await call("PUT", `/tasks/${taskId}`, {
      task: { party: null },
    });
    pp(`PUT /tasks/${taskId} { party: null }`, p8);
    const p8Read = await call("GET", `/tasks/${taskId}`);
    pp(`GET /tasks/${taskId} (verify)`, p8Read);

    console.log("\n=========================================");
    console.log("PROBE 9: update_project { party: null } — orphan project?");
    console.log("=========================================");
    const p9 = await call("PUT", `/kases/${projectId}`, {
      kase: { party: null },
    });
    pp(`PUT /kases/${projectId} { party: null }`, p9);

    console.log("\n=========================================");
    console.log("PROBE 10: update_task { opportunity: { id } } — re-link to opp");
    console.log("=========================================");
    const p10 = await call("PUT", `/tasks/${taskId}`, {
      task: { opportunity: { id: oppId } },
    });
    pp(`PUT /tasks/${taskId} { opportunity: { id: opp } }`, p10);
    const p10Read = await call("GET", `/tasks/${taskId}`);
    pp(`GET /tasks/${taskId} (verify)`, p10Read);

    console.log("\n=========================================");
    console.log("PROBE 11: update_task { kase: { id } } — re-link to project");
    console.log("=========================================");
    const p11 = await call("PUT", `/tasks/${taskId}`, {
      task: { opportunity: null, kase: { id: projectId } },
    });
    pp(`PUT /tasks/${taskId} { opportunity: null, kase: { id: project } }`, p11);
    const p11Read = await call("GET", `/tasks/${taskId}`);
    pp(`GET /tasks/${taskId} (verify)`, p11Read);

    console.log("\n=========================================");
    console.log("PROBE 12: update_task with TWO parents set — does Capsule enforce XOR?");
    console.log("=========================================");
    const p12 = await call("PUT", `/tasks/${taskId}`, {
      task: { party: { id: personAId }, opportunity: { id: oppId } },
    });
    pp(`PUT /tasks/${taskId} { party + opportunity both set }`, p12);
    const p12Read = await call("GET", `/tasks/${taskId}`);
    pp(`GET /tasks/${taskId} (verify)`, p12Read);

    console.log("\nAll probes complete.");
  } catch (err) {
    console.error("\n!!! probe run crashed:", err);
  } finally {
    // ── Cleanup: delete every record we created, in reverse-create order
    console.log("\n=========================================");
    console.log(`Cleanup: deleting ${created.length} records...`);
    console.log("=========================================");
    for (const { kind, id } of created.reverse()) {
      const path =
        kind === "party"
          ? `/parties/${id}`
          : kind === "opportunity"
            ? `/opportunities/${id}`
            : kind === "kase"
              ? `/kases/${id}`
              : `/tasks/${id}`;
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
