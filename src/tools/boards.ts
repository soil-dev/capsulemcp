import { z } from "zod";
import { positiveId, paginationFieldsNoDefaults } from "./shared-schemas.js";
import { capsuleGetCachedList } from "../capsule/client.js";

// Boards and stages are the project equivalents of pipelines and
// milestones for opportunities. A board has many stages; a project sits at
// one stage at a time. Capsule's response shape is symmetric to /pipelines
// and /milestones.

// ── Boards ──────────────────────────────────────────────────────────────────

export const listBoardsSchema = z.object({ ...paginationFieldsNoDefaults });

export async function listBoards(input: z.infer<typeof listBoardsSchema>) {
  return capsuleGetCachedList<{ boards: unknown[] }>("/boards", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ── Stages ──────────────────────────────────────────────────────────────────
//
// Capsule exposes a global /stages endpoint that returns every stage across
// every board, each with a `.board` reference. We expose that as the default
// — it's one round trip for "what stages exist anywhere?" — and accept an
// optional `boardId` to filter to a single board (uses /boards/{id}/stages).

export const listStagesSchema = z.object({
  boardId: positiveId
    .optional()
    .describe(
      "Optional. If provided, returns only the stages defined on that specific board (uses /boards/{id}/stages). Omit to get all stages across all boards in one call.",
    ),
  ...paginationFieldsNoDefaults,
});

export async function listStages(input: z.infer<typeof listStagesSchema>) {
  const path = input.boardId !== undefined ? `/boards/${input.boardId}/stages` : "/stages";
  return capsuleGetCachedList<{ stages: unknown[] }>(path, {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}
