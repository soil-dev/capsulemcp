import { z } from "zod";
import { capsulePost } from "../capsule/client.js";

export const addNoteSchema = z
  .object({
    content: z.string().min(1).describe("Note body text"),
    partyId: z.number().int().positive().optional(),
    opportunityId: z.number().int().positive().optional(),
    projectId: z.number().int().positive().optional(),
  })
  .refine(
    (d) => [d.partyId, d.opportunityId, d.projectId].filter(Boolean).length === 1,
    { message: "Provide exactly one of partyId, opportunityId, or projectId" },
  );

export async function addNote(input: z.infer<typeof addNoteSchema>) {
  const { content, partyId, opportunityId, projectId } = input;

  const body: Record<string, unknown> = { type: "note", content };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };

  return capsulePost<{ entry: unknown }>("/entries", { entry: body });
}
