import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

const ENTITY_PATH = {
  parties: "/parties/tags",
  opportunities: "/opportunities/tags",
  kases: "/kases/tags",
} as const;

export const listTagsSchema = z.object({
  entity: z.enum(["parties", "opportunities", "kases"]).describe(
    "The resource type to list tags for",
  ),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export async function listTags(input: z.infer<typeof listTagsSchema>) {
  const path = ENTITY_PATH[input.entity];
  const { data, nextPage } = await capsuleGet<{ tags: unknown[] }>(path, {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}
