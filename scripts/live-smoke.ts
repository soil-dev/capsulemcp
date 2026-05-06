/**
 * Live round-trip smoke test against the real Capsule API.
 *
 * Runs every write tool against a throwaway party, then deletes the
 * party (and dependent records) via DELETE. Idempotent in the failure
 * sense: if it crashes mid-way, the cleanup ID is logged so you can
 * delete manually.
 *
 * Usage: CAPSULE_API_TOKEN=... npx tsx scripts/live-smoke.ts
 */

import {
  createParty,
  updateParty,
  searchParties,
  getParty,
} from "../src/tools/parties.js";
import {
  createOpportunity,
  updateOpportunity,
} from "../src/tools/opportunities.js";
import { listPipelines, listMilestones } from "../src/tools/pipelines.js";
import { createTask, completeTask, listTasks } from "../src/tools/tasks.js";
import { addNote } from "../src/tools/entries.js";
import { fetch } from "undici";

const TAG = `[mcp-smoke-${Date.now()}]`;
const log = (label: string, val: unknown) =>
  console.log(`\n── ${label} ──\n${JSON.stringify(val, null, 2).slice(0, 400)}`);

let createdPartyId: number | undefined;
let createdOppId: number | undefined;

async function rawDelete(path: string) {
  const res = await fetch(`https://api.capsulecrm.com/api/v2${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${process.env["CAPSULE_API_TOKEN"]}`,
      Accept: "application/json",
    },
  });
  return res.status;
}

async function main() {
  // 1. create party
  const created = (await createParty({
    type: "person",
    firstName: "ZZZ-MCP-Test",
    lastName: TAG,
    jobTitle: "throwaway",
    emailAddresses: [{ address: `mcp-test+${Date.now()}@example.invalid`, type: "Work" }],
  })) as { party: { id: number; firstName: string } };
  createdPartyId = created.party.id;
  log("createParty →", created);

  // 2. update party
  const updated = await updateParty({ id: createdPartyId!, jobTitle: "updated-via-mcp" });
  log("updateParty →", updated);

  // 3. read back with embed
  const got = await getParty({ id: createdPartyId!, embed: "tags,fields" });
  log("getParty(embed=tags,fields) →", got);

  // 4. search by unique tag
  const found = await searchParties({ q: TAG });
  log(`searchParties(q="${TAG}") → count=${(found.parties as unknown[]).length}`, {
    nextPage: found.nextPage,
  });

  // 5. add note
  const note = await addNote({ partyId: createdPartyId!, content: `${TAG} live smoke note` });
  log("addNote →", note);

  // 6. pipelines + milestones
  const pipelines = (await listPipelines({})) as { pipelines: Array<{ id: number; name: string }> };
  log(`listPipelines → ${pipelines.pipelines.length} pipeline(s)`, pipelines.pipelines.slice(0, 2));
  const firstPipelineId = pipelines.pipelines[0]?.id;
  if (!firstPipelineId) throw new Error("No pipelines defined; cannot continue");

  const milestones = (await listMilestones({ pipelineId: firstPipelineId })) as {
    milestones: Array<{ id: number; name: string }>;
  };
  log(`listMilestones(pipeline=${firstPipelineId}) → ${milestones.milestones.length}`, milestones.milestones.slice(0, 2));
  const firstMilestoneId = milestones.milestones[0]?.id;
  if (!firstMilestoneId) throw new Error("No milestones in first pipeline");

  // 7. create opportunity
  const opp = (await createOpportunity({
    name: `${TAG} live opp`,
    partyId: createdPartyId!,
    milestoneId: firstMilestoneId,
    value: { amount: 1234, currency: "USD" },
  })) as { opportunity: { id: number; name: string } };
  createdOppId = opp.opportunity.id;
  log("createOpportunity →", opp);

  // 8. update opportunity
  const oppUpdated = await updateOpportunity({ id: createdOppId!, probability: 42 });
  log("updateOpportunity(probability=42) →", oppUpdated);

  // 9. create task linked to party
  const task = (await createTask({
    description: `${TAG} live task`,
    dueOn: "2099-12-31",
    partyId: createdPartyId!,
  })) as { task: { id: number; status: string } };
  log("createTask →", task);

  // 10. complete task
  const taskDone = await completeTask({ id: task.task.id });
  log("completeTask →", taskDone);

  // 11. list_tasks: check our task shows up under COMPLETED
  const listed = await listTasks({ status: "COMPLETED", perPage: 5, page: 1 });
  log("listTasks(status=COMPLETED) → page count", { count: (listed.tasks as unknown[]).length });
}

async function cleanup() {
  console.log("\n── cleanup ──");
  if (createdOppId !== undefined) {
    const s = await rawDelete(`/opportunities/${createdOppId}`);
    console.log(`DELETE /opportunities/${createdOppId} → ${s}`);
  }
  if (createdPartyId !== undefined) {
    const s = await rawDelete(`/parties/${createdPartyId}`);
    console.log(`DELETE /parties/${createdPartyId} → ${s}`);
  }
}

main()
  .then(cleanup)
  .then(() => {
    console.log("\n✅ live smoke complete");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n❌ smoke failed:", err);
    if (createdPartyId !== undefined) {
      console.error(`!! created party ${createdPartyId} was NOT cleaned up — running cleanup now`);
    }
    await cleanup();
    process.exit(1);
  });
