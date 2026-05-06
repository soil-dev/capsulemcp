import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

export const listPipelinesSchema = z.object({});

export async function listPipelines(_input: z.infer<typeof listPipelinesSchema>) {
  const { data } = await capsuleGet<{ pipelines: unknown[] }>("/pipelines");
  return data;
}

// ───────────────────────────────────────────────────────────────────────────

export const listMilestonesSchema = z.object({
  pipelineId: z.number().int().positive(),
});

export async function listMilestones(input: z.infer<typeof listMilestonesSchema>) {
  const { data } = await capsuleGet<{ milestones: unknown[] }>(
    `/pipelines/${input.pipelineId}/milestones`,
  );
  return data;
}
