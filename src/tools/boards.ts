import { z } from "zod";
import { positiveId } from "./shared-schemas.js";
import { capsuleGetCached } from "../capsule/client.js";

// Boards and stages are the project (kase) equivalents of pipelines and
// milestones for opportunities. A board has many stages; a project sits at
// one stage at a time. Capsule's response shape is symmetric to /pipelines
// and /milestones.

const paginationFields = {
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
};

// ── Boards ──────────────────────────────────────────────────────────────────

export const listBoardsSchema = z.object({ ...paginationFields });

export async function listBoards(input: z.infer<typeof listBoardsSchema>) {
  const { data, nextPage } = await capsuleGetCached<{ boards: unknown[] }>("/boards", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
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
  ...paginationFields,
});

export async function listStages(input: z.infer<typeof listStagesSchema>) {
  const path = input.boardId !== undefined ? `/boards/${input.boardId}/stages` : "/stages";
  const { data, nextPage } = await capsuleGetCached<{ stages: unknown[] }>(path, {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}
