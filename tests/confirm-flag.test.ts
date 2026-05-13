import { describe, it, expect } from "vitest";
import { deletePartySchema } from "../src/tools/parties.js";
import { deleteOpportunitySchema } from "../src/tools/opportunities.js";
import { deleteProjectSchema } from "../src/tools/projects.js";
import { deleteTaskSchema } from "../src/tools/tasks.js";
import { deleteEntrySchema } from "../src/tools/entries.js";
import { removeTrackSchema } from "../src/tools/tracks.js";
import { removeAdditionalPartySchema } from "../src/tools/relationships.js";

const EXPECTED =
  "confirm: true is required to perform this destructive operation (set the parameter explicitly to acknowledge the destructive intent)";

// Each gated schema gets a minimal base input that's valid except for
// the `confirm` field. The shape varies (id vs trackId vs entity-tuple)
// so each row supplies its own.
const cases: { name: string; schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } } }; base: Record<string, unknown> }[] = [
  { name: "delete_party",            schema: deletePartySchema,            base: { id: 1 } },
  { name: "delete_opportunity",      schema: deleteOpportunitySchema,      base: { id: 1 } },
  { name: "delete_project",          schema: deleteProjectSchema,          base: { id: 1 } },
  { name: "delete_task",             schema: deleteTaskSchema,             base: { id: 1 } },
  { name: "delete_entry",            schema: deleteEntrySchema,            base: { id: 1 } },
  { name: "remove_track",            schema: removeTrackSchema,            base: { trackId: 1 } },
  { name: "remove_additional_party", schema: removeAdditionalPartySchema,  base: { entity: "opportunities", entityId: 1, partyId: 2 } },
];

describe("confirm: true literal — friendly rejection message", () => {
  for (const { name, schema, base } of cases) {
    it(`${name}: missing confirm → friendly message`, () => {
      const r = schema.safeParse(base);
      expect(r.success).toBe(false);
      if (!r.success) {
        const issue = r.error!.issues.find((i) => i.path[0] === "confirm");
        expect(issue?.message).toBe(EXPECTED);
      }
    });

    it(`${name}: confirm:false → friendly message`, () => {
      const r = schema.safeParse({ ...base, confirm: false });
      expect(r.success).toBe(false);
      if (!r.success) {
        const issue = r.error!.issues.find((i) => i.path[0] === "confirm");
        expect(issue?.message).toBe(EXPECTED);
      }
    });

    it(`${name}: confirm:true → accepts`, () => {
      const r = schema.safeParse({ ...base, confirm: true });
      expect(r.success).toBe(true);
    });
  }
});
