import { z } from "zod";
import { capsulePost } from "../capsule/client.js";

// MCP SDK needs a plain ZodObject shape; enforce the exactly-one constraint in the handler.
export const addNoteSchema = z.object({
  content: z.string().min(1).describe("Note body text"),
  partyId: z.number().int().positive().optional().describe("Link note to a party (mutually exclusive with opportunityId/projectId)"),
  opportunityId: z.number().int().positive().optional().describe("Link note to an opportunity (mutually exclusive with partyId/projectId)"),
  projectId: z.number().int().positive().optional().describe("Link note to a project (mutually exclusive with partyId/opportunityId)"),
});

export async function addNote(input: z.infer<typeof addNoteSchema>) {
  const { content, partyId, opportunityId, projectId } = input;

  const linked = [partyId, opportunityId, projectId].filter(Boolean);
  if (linked.length !== 1) {
    throw new Error("Provide exactly one of partyId, opportunityId, or projectId");
  }

  const body: Record<string, unknown> = { type: "note", content };
  if (partyId) body["party"] = { id: partyId };
  if (opportunityId) body["opportunity"] = { id: opportunityId };
  if (projectId) body["kase"] = { id: projectId };

  return capsulePost<{ entry: unknown }>("/entries", { entry: body });
}
