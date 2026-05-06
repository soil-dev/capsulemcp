import { z } from "zod";
import { capsuleGet } from "../capsule/client.js";

export const listUsersSchema = z.object({});

export async function listUsers(_input: z.infer<typeof listUsersSchema>) {
  const { data } = await capsuleGet<{ users: unknown[] }>("/users");
  return data;
}
