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

// ── Current user ────────────────────────────────────────────────────────────
//
// GET /users/current returns the user owning the PAT in use. Useful for
// audit ("under whose identity does the connector run?") and for
// admins switching between rotated tokens. Documented at
// <https://developer.capsulecrm.com/v2/operations/User#showCurrentUser>;
// note the path is /users/current, NOT /users/me as the GitHub API
// convention would suggest.

export const getCurrentUserSchema = z.object({});

export async function getCurrentUser(_input: z.infer<typeof getCurrentUserSchema>) {
  const { data } = await capsuleGet<{ user: unknown }>("/users/current");
  return data;
}
