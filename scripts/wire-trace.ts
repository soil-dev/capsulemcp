/**
 * Wire-trace test: invoke each write-side tool function (and a few
 * key read-side ones) with realistic inputs, intercept the actual
 * HTTP requests our code emits, and verify the wire format matches
 * what Capsule's API expects.
 *
 * Run with:
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace.ts
 *
 * Caveats:
 * - Makes REAL Capsule API calls. Each create is followed by a delete
 *   in this same script. If it crashes mid-run, leftovers may stay
 *   (search for 'ZZZ-MCP-WIRE-TRACE' to clean up manually).
 * - Designed as a one-shot pre-1.0 verifier, not a maintained suite.
 */

import { subscribe } from "node:diagnostics_channel";

// ── Fetch interceptor via undici's diagnostics channel ──────────────────────
// undici publishes events for every request it makes. Subscribe to
// 'undici:request:create' so we observe the wire shape (method, path,
// body) of every request our tool functions emit, without touching
// the fetch export (read-only in ESM).

interface UndiciRequest {
  method: string;
  path: string;
  origin?: string;
  headers?: string | string[] | Record<string, string>;
  body?: string | Buffer | unknown;
}

const calls: Array<{ method: string; path: string; body?: string }> = [];

subscribe("undici:request:create", (message: unknown) => {
  const r = (message as { request?: UndiciRequest }).request;
  if (!r) return;
  let bodyPreview: string | undefined;
  if (typeof r.body === "string") bodyPreview = r.body;
  else if (Buffer.isBuffer(r.body)) bodyPreview = `<Buffer ${r.body.length} bytes>`;
  else if (r.body) bodyPreview = "<non-string body>";
  calls.push({ method: r.method, path: r.path, body: bodyPreview });
});

function dumpLastCall(label: string) {
  const c = calls[calls.length - 1];
  if (!c) {
    console.log(`  [${label}] NO CALL CAPTURED`);
    return;
  }
  const body = c.body ? (c.body.length > 200 ? `${c.body.slice(0, 200)}…` : c.body) : "";
  console.log(`  [${label}] ${c.method} ${c.path}`);
  if (body) console.log(`           body: ${body}`);
}

function dumpCall(offsetFromEnd: number, label: string) {
  const c = calls[calls.length - 1 - offsetFromEnd];
  if (!c) {
    console.log(`  [${label}] NO CALL CAPTURED`);
    return;
  }
  const body = c.body ? (c.body.length > 200 ? `${c.body.slice(0, 200)}…` : c.body) : "";
  console.log(`  [${label}] ${c.method} ${c.path}`);
  if (body) console.log(`           body: ${body}`);
}

// ── Test runner ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env["CAPSULE_API_TOKEN"]) {
    console.error("CAPSULE_API_TOKEN not set");
    process.exit(1);
  }

  const { createParty, updateParty, deleteParty } = await import("../src/tools/parties.js");
  const { createOpportunity, updateOpportunity, deleteOpportunity } = await import(
    "../src/tools/opportunities.js"
  );
  const { createProject, updateProject, deleteProject } = await import("../src/tools/projects.js");
  const { createTask, updateTask, completeTask, deleteTask } = await import(
    "../src/tools/tasks.js"
  );
  const { addNote, updateEntry, deleteEntry } = await import("../src/tools/entries.js");
  const { uploadAttachment } = await import("../src/tools/attachments.js");
  const { addAdditionalParty, removeAdditionalParty } = await import(
    "../src/tools/relationships.js"
  );
  const { applyTrack, updateTrack, removeTrack } = await import("../src/tools/tracks.js");
  const { capsuleGet } = await import("../src/capsule/client.js");

  console.log("========== WIRE TRACE — invoking real TS code ==========\n");

  // ── 1. PARTY ─────────────────────────────────────────────────────────────
  console.log("== parties ==");
  const partyA = (await createParty({
    type: "organisation",
    name: "ZZZ-MCP-WIRE-TRACE-A",
    about: "wire-trace probe — will be deleted",
  })) as { party: { id: number } };
  dumpLastCall("createParty");

  await updateParty({ id: partyA.party.id, about: "updated by wire-trace" });
  dumpLastCall("updateParty");

  const partyB = (await createParty({
    type: "organisation",
    name: "ZZZ-MCP-WIRE-TRACE-B",
  })) as { party: { id: number } };

  // ── 2. OPPORTUNITY ───────────────────────────────────────────────────────
  console.log("\n== opportunities ==");
  const pipelinesResp = (await capsuleGet<{ pipelines: { id: number }[] }>("/pipelines")) as {
    data: { pipelines: { id: number }[] };
  };
  const pipelineId = pipelinesResp.data.pipelines[0]!.id;
  const milestonesResp = (await capsuleGet<{ milestones: { id: number }[] }>(
    `/pipelines/${pipelineId}/milestones`,
  )) as { data: { milestones: { id: number }[] } };
  const milestoneId = milestonesResp.data.milestones[0]!.id;

  const opp = (await createOpportunity({
    name: "ZZZ-MCP wire-trace deal",
    partyId: partyA.party.id,
    milestoneId,
    value: { amount: 1000, currency: "USD" },
  })) as { opportunity: { id: number } };
  dumpLastCall("createOpportunity");

  await updateOpportunity({
    id: opp.opportunity.id,
    description: "updated by wire-trace",
  });
  dumpLastCall("updateOpportunity");

  // ── 3. ADDITIONAL-PARTY (write side) ─────────────────────────────────────
  console.log("\n== additional parties ==");
  await addAdditionalParty({
    entity: "opportunities",
    entityId: opp.opportunity.id,
    partyId: partyB.party.id,
  });
  dumpLastCall("addAdditionalParty");

  await removeAdditionalParty({
    entity: "opportunities",
    entityId: opp.opportunity.id,
    partyId: partyB.party.id,
    confirm: true,
  });
  dumpLastCall("removeAdditionalParty");

  await deleteOpportunity({ id: opp.opportunity.id, confirm: true });
  dumpLastCall("deleteOpportunity");

  // ── 4. PROJECT + TRACK ───────────────────────────────────────────────────
  console.log("\n== projects + tracks ==");
  const proj = (await createProject({
    name: "ZZZ-MCP wire-trace project",
    partyId: partyA.party.id,
    status: "OPEN",
  })) as { project: { id: number } };
  dumpLastCall("createProject");

  await updateProject({
    id: proj.project.id,
    description: "updated by wire-trace",
  });
  dumpLastCall("updateProject");

  // Track lifecycle — the apply_track bug we just fixed
  const tdResp = (await capsuleGet<{
    trackDefinitions: { id: number }[];
  }>("/trackdefinitions?perPage=1")) as {
    data: { trackDefinitions: { id: number }[] };
  };
  const tdefId = tdResp.data.trackDefinitions[0]!.id;

  const track = (await applyTrack({
    entity: "projects",
    entityId: proj.project.id,
    trackDefinitionId: tdefId,
  })) as { track: { id: number } | null };
  dumpLastCall("applyTrack");
  if (!track.track?.id) {
    throw new Error(
      "applyTrack returned null id — the v1.0.0 fix didn't take. Inspect the body above.",
    );
  }

  await updateTrack({
    trackId: track.track.id,
    fields: { complete: true },
  });
  dumpLastCall("updateTrack");

  await removeTrack({ trackId: track.track.id, confirm: true });
  dumpLastCall("removeTrack");

  await deleteProject({ id: proj.project.id, confirm: true });
  dumpLastCall("deleteProject");

  // ── 5. TASK ──────────────────────────────────────────────────────────────
  console.log("\n== tasks ==");
  const task = (await createTask({
    description: "ZZZ-MCP wire-trace task",
    dueOn: "2026-12-31",
    partyId: partyA.party.id,
  })) as { task: { id: number } };
  dumpLastCall("createTask");

  await updateTask({ id: task.task.id, detail: "updated" });
  dumpLastCall("updateTask");

  await completeTask({ id: task.task.id });
  dumpLastCall("completeTask");

  await deleteTask({ id: task.task.id, confirm: true });
  dumpLastCall("deleteTask");

  // ── 6. NOTE / ENTRY ──────────────────────────────────────────────────────
  console.log("\n== entries ==");
  const note = (await addNote({
    content: "wire-trace probe note",
    partyId: partyA.party.id,
  })) as { entry: { id: number } };
  dumpLastCall("addNote");

  await updateEntry({ id: note.entry.id, content: "updated" });
  dumpLastCall("updateEntry");

  await deleteEntry({ id: note.entry.id, confirm: true });
  dumpLastCall("deleteEntry");

  // ── 7. ATTACHMENT ────────────────────────────────────────────────────────
  console.log("\n== attachments ==");
  const probeBytes = Buffer.from("wire-trace attachment probe");
  const att = (await uploadAttachment({
    filename: "probe.txt",
    contentType: "text/plain",
    dataBase64: probeBytes.toString("base64"),
    partyId: partyA.party.id,
  })) as { entry: { id: number } };
  // The two-step orchestration emits two calls; dump both.
  dumpCall(1, "uploadAttachment (upload step)");
  dumpCall(0, "uploadAttachment (entry-create step)");

  await deleteEntry({ id: att.entry.id, confirm: true });
  dumpLastCall("deleteEntry (attachment cleanup)");

  // ── 8. CLEANUP ───────────────────────────────────────────────────────────
  console.log("\n== cleanup ==");
  await deleteParty({ id: partyA.party.id, confirm: true });
  dumpLastCall("deleteParty A");
  await deleteParty({ id: partyB.party.id, confirm: true });
  dumpLastCall("deleteParty B");

  console.log("\n✓ wire-trace complete — every write tool's actual TS output was observed.");
}

main().catch((err) => {
  console.error("\n✗ wire-trace failed:", err);
  console.error(
    "\nIf records were created before the failure, search Capsule for 'ZZZ-MCP-WIRE-TRACE' and delete manually.",
  );
  process.exit(1);
});
