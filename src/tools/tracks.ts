import { z } from "zod";
import { positiveId } from "./shared-schemas.js";
import { confirmFlag } from "./confirm-flag.js";
import { idempotent } from "../capsule/idempotent.js";
import { capsuleDelete, capsuleGet, capsulePost, capsulePut } from "../capsule/client.js";

// Track INSTANCES — applications of a track definition to a specific
// record. Distinct from list_track_definitions (in metadata.ts), which
// returns the templates.
//
// Lifecycle:
//   list_entity_tracks(entity, entityId)
//     GET /<entity>/{id}/tracks — instances on a specific record
//   show_track(trackId)
//     GET /tracks/{id}
//   apply_track(entity, entityId, trackDefinitionId, startDate?)
//     POST /tracks — create a new instance, auto-creating the
//     trackDefinition's task definitions on the target entity
//   update_track(trackId, body)
//     PUT /tracks/{id} — passthrough; usable to e.g. mark complete
//   remove_track(trackId, confirm)
//     DELETE /tracks/{id} — remove the instance; Capsule also deletes
//     the auto-tasks the track created when it was applied
//
// Entity for list_entity_tracks is "parties", "opportunities", or
// "kases". apply_track intentionally exposes only "kases" and
// "opportunities" — tracks model deal/project workflows, not party
// lifecycle, and we haven't seen a real workflow that needs party-
// applied tracks. The Capsule API would accept "parties" too if
// `applyTrackSchema.entity` were widened.

const TrackEntity = z
  .enum(["parties", "opportunities", "kases"])
  .describe("Use 'kases' for projects.");

// ── List entity tracks ──────────────────────────────────────────────────────

export const listEntityTracksSchema = z.object({
  entity: TrackEntity,
  entityId: positiveId,
});

export async function listEntityTracks(input: z.infer<typeof listEntityTracksSchema>) {
  const { data } = await capsuleGet<{ tracks: unknown[] }>(
    `/${input.entity}/${input.entityId}/tracks`,
  );
  return data;
}

// ── Show one track instance ─────────────────────────────────────────────────

export const showTrackSchema = z.object({
  trackId: positiveId,
});

export async function showTrack(input: z.infer<typeof showTrackSchema>) {
  const { data } = await capsuleGet<{ track: unknown }>(`/tracks/${input.trackId}`);
  return data;
}

// ── Apply a track ───────────────────────────────────────────────────────────

export const applyTrackSchema = z.object({
  entity: z
    .enum(["opportunities", "kases"])
    .describe("Which entity to apply the track to. Use 'kases' for projects."),
  entityId: positiveId,
  trackDefinitionId: positiveId.describe(
    "The trackDefinition to apply (from list_track_definitions). Auto-creates task definitions on the target entity per the track's rules.",
  ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Optional ISO-8601 date (YYYY-MM-DD) the track should start from — drives task due-date calculations (each task's `dueOn` is computed as startDate + the track-definition's `daysAfter` offset). Defaults to today if omitted. Useful for scheduling a renewal-queue track against a future contract end-date, or backfilling tracks for historical projects.",
    ),
});

export async function applyTrack(input: z.infer<typeof applyTrackSchema>) {
  const target = input.entity === "opportunities" ? "opportunity" : "kase";

  // Capsule's POST /tracks body expects `definition`, not `trackDefinition`,
  // even though the docs (in some places) say otherwise and the GET
  // response uses `trackDefinition` as the key. Verified live: sending
  // `trackDefinition` returns 422 "track definition is required" with
  // field=definition. Sending `definition` works.
  //
  // The user-facing `startDate` parameter maps to Capsule's `trackDateOn`
  // body field — same field, different name. Verified via NOTES-ON-
  // CAPSULE-API.md §2 (Capsule's verbatim POST /tracks example uses
  // `trackDateOn`). Sending `startDate` directly is silently ignored by
  // Capsule (the field is dropped without error).
  const track: Record<string, unknown> = {
    definition: { id: input.trackDefinitionId },
    [target]: { id: input.entityId },
  };
  if (input.startDate !== undefined) track["trackDateOn"] = input.startDate;

  return capsulePost<{ track: unknown }>("/tracks", { track });
}

// ── Update a track instance ─────────────────────────────────────────────────

export const updateTrackSchema = z.object({
  trackId: positiveId,
  fields: z
    // zod 4: z.record requires an explicit key schema (was implicit
    // string in zod 3). Capsule field names are strings.
    .record(z.string(), z.unknown())
    .describe(
      "Object of fields to update on the track. Capsule's PUT semantics are partial — only the fields you provide are changed. Common: { complete: true } to mark a track completed. Capsule rejects unknown keys; consult Capsule's docs for the full updatable set.",
    ),
});

export async function updateTrack(input: z.infer<typeof updateTrackSchema>) {
  if (Object.keys(input.fields).length === 0) {
    throw new Error("update_track: provide at least one field in `fields`");
  }
  return capsulePut<{ track: unknown }>(`/tracks/${input.trackId}`, {
    track: input.fields,
  });
}

// ── Remove a track instance ─────────────────────────────────────────────────

export const removeTrackSchema = z.object({
  trackId: positiveId,
  confirm: confirmFlag().describe(
    "Must be set to true. Removes the track instance from its entity. **Capsule also deletes the auto-tasks the track created when it was applied** — they go with the track and become unreachable (404 on GET /tasks/{id}, gone from list_tasks on the parent entity). If you need any of those tasks to outlive the track, copy their content into fresh tasks (or use the web UI) before calling remove_track.",
  ),
});

export async function removeTrack(input: z.infer<typeof removeTrackSchema>) {
  if (input.confirm !== true) {
    throw new Error("remove_track requires confirm: true");
  }
  return idempotent(
    () => capsuleDelete(`/tracks/${input.trackId}`),
    () => ({ removed: true, alreadyRemoved: false, trackId: input.trackId }),
    () => ({ removed: true, alreadyRemoved: true, trackId: input.trackId }),
  );
}
