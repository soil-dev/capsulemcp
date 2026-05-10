import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

// Capsule's default page size is 50 — most accounts have fewer than 50
// users so a single call returns everything, but a larger team would
// need to page. Defaults to perPage=100 (Capsule's max) for the same
// reason as the metadata tools.

export const listUsersSchema = z.object({
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export async function listUsers(input: z.infer<typeof listUsersSchema>) {
  const { data, nextPage } = await capsuleGet<{ users: unknown[] }>("/users", {
    page: input.page ?? 1,
    perPage: input.perPage ?? 100,
  });
  return { ...data, nextPage };
}
