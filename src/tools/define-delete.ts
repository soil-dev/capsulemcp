/**
 * Helper for building `delete_<entity>` MCP tools.
 *
 * Every whole-record delete tool in the connector follows an
 * identical shape: positive-integer `id`, mandatory `confirm: true`
 * literal, idempotent DELETE against `<pathPrefix>/<id>`, and a
 * `{deleted, alreadyDeleted, id}` envelope on the return.
 *
 * Centralising the pattern means a future delete tool inherits the
 * idempotent semantics, the confirm-gate enforcement, and the
 * envelope shape without re-implementing them — and the `confirm`
 * check error message stays in sync across all of them by
 * construction.
 */

import { z } from "zod";
import { confirmFlag } from "./confirm-flag.js";
import { positiveId } from "./shared-schemas.js";
import { capsuleDelete } from "../capsule/client.js";
import { idempotent } from "../capsule/idempotent.js";

export interface DeleteResult {
  deleted: true;
  alreadyDeleted: boolean;
  id: number;
}

interface DefineDeleteArgs {
  /** Tool name, e.g. "delete_party". Used in the confirm-flag error message. */
  toolName: string;
  /** Capsule API path prefix, e.g. "/parties". The id is appended as `${prefix}/${id}`. */
  pathPrefix: string;
  /**
   * Description for the `confirm` field. Each entity varies it
   * slightly — e.g. delete_project nudges callers toward
   * `update_project status='CLOSED'` instead, delete_task points at
   * `complete_task`, delete_party warns about cascading deletes.
   */
  confirmHint: string;
  /**
   * Optional description for the `id` field. Most callers leave it
   * out; entries.ts uses one because its id covers notes, emails,
   * and task records (the entity name doesn't fully convey the
   * shape).
   */
  idDescription?: string;
}

export function defineDelete(args: DefineDeleteArgs) {
  const { toolName, pathPrefix, confirmHint, idDescription } = args;
  const schema = z.object({
    id: idDescription ? positiveId.describe(idDescription) : positiveId,
    confirm: confirmFlag().describe(confirmHint),
  });

  async function handler(input: z.infer<typeof schema>): Promise<DeleteResult> {
    if (input.confirm !== true) {
      throw new Error(`${toolName} requires confirm: true`);
    }
    return idempotent<DeleteResult>(
      () => capsuleDelete(`${pathPrefix}/${input.id}`),
      () => ({ deleted: true, alreadyDeleted: false, id: input.id }),
      () => ({ deleted: true, alreadyDeleted: true, id: input.id }),
    );
  }

  return { schema, handler };
}
