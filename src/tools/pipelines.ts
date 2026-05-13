import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

const paginationFields = {
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
};

export const listPipelinesSchema = z.object({ ...paginationFields });

export async function listPipelines(input: z.infer<typeof listPipelinesSchema>) {
  const { data, nextPage } = await capsuleGet<{ pipelines: unknown[] }>("/pipelines", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}

// ───────────────────────────────────────────────────────────────────────────

export const listMilestonesSchema = z.object({
  pipelineId: z.number().int().positive(),
  ...paginationFields,
});

export async function listMilestones(input: z.infer<typeof listMilestonesSchema>) {
  const { data, nextPage } = await capsuleGet<{ milestones: unknown[] }>(
    `/pipelines/${input.pipelineId}/milestones`,
    { page: input.page ?? 1, perPage: input.perPage ?? 100 },
  );
  return { ...data, nextPage };
}
