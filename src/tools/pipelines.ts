import { z } from "zod";
import { positiveId, paginationFieldsNoDefaults } from "./shared-schemas.js";
import { capsuleGetCachedList } from "../capsule/client.js";

export const listPipelinesSchema = z.object({ ...paginationFieldsNoDefaults });

export async function listPipelines(input: z.infer<typeof listPipelinesSchema>) {
  return capsuleGetCachedList<{ pipelines: unknown[] }>("/pipelines", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
}

// ───────────────────────────────────────────────────────────────────────────

export const listMilestonesSchema = z.object({
  pipelineId: positiveId,
  ...paginationFieldsNoDefaults,
});

export async function listMilestones(input: z.infer<typeof listMilestonesSchema>) {
  return capsuleGetCachedList<{ milestones: unknown[] }>(
    `/pipelines/${input.pipelineId}/milestones`,
    { page: input.page ?? 1, perPage: input.perPage ?? 100 },
  );
}
