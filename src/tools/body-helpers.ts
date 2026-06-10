/**
 * Tiny helpers for building Capsule API request bodies.
 *
 * Capsule represents most foreign keys as nested objects with an
 * `id` property: `owner: { id: 42 }`, `team: { id: 10 }`,
 * `party: { id: 100 }`, and so on. Every create/update handler
 * repeats the same conditional-build pattern when translating the
 * caller-facing flat ID field into the wire shape.
 *
 * Centralising the two shapes (set-if-present, set-or-null-or-skip)
 * keeps the call sites short and the wire-shape transformation
 * uniform across resources.
 */

/**
 * Add a `key: { id }` reference to `body` if `id` is a positive
 * number; otherwise do nothing. Use for fields where the caller
 * either supplies a value or omits it (no explicit "clear" path).
 *
 * Truthy guard intentionally matches the historical `if (ownerId)`
 * pattern — combined with the positive-integer Zod schema, the
 * effective behaviour is "set if defined". `0` is impossible (the
 * schema rejects it as not-positive) but the truthy check defends
 * against future schema relaxation.
 */
export function setRef(
  body: Record<string, unknown>,
  key: string,
  id: number | null | undefined,
): void {
  if (id) body[key] = { id };
}

/**
 * Like `setRef`, but supports explicit `null` to clear the reference
 * on the wire. Use for fields where the caller can opt in to
 * "unassign" semantics — e.g. `update_project { ownerId: null }`,
 * `update_opportunity { teamId: null }`. `undefined` means "leave
 * the field alone"; `null` means "explicitly unset".
 */
export function setNullableRef(
  body: Record<string, unknown>,
  key: string,
  id: number | null | undefined,
): void {
  if (id === null) body[key] = null;
  else if (id !== undefined) body[key] = { id };
}

/**
 * Enforce Capsule's at-most-one-parent invariant for entities that can
 * link to a party, opportunity, OR project — but never more than one
 * (Capsule rejects multi-parent writes with a 422 "can be related to at
 * most one entity"). One canonical definition so the four handlers that
 * need it (create_task, update_task, add_note, upload_attachment) can't
 * drift in predicate or wording again.
 *
 * Counts only `number` values: `undefined` (omitted) never counts, and
 * `null` never counts either — update-side tools use `null` to mean
 * "detach/swap this parent", which is exactly one parent on the wire.
 * The positive-integer Zod schemas guarantee 0 can't reach us.
 *
 * `opts.required` switches the rule from "at most one" (updates, where
 * omitting all three means "leave parentage alone") to "exactly one"
 * (creates of inherently-parented records like notes and attachments).
 */
export function assertSingleParentRef(
  toolName: string,
  refs: {
    partyId?: number | null;
    opportunityId?: number | null;
    projectId?: number | null;
  },
  opts: { required?: boolean } = {},
): void {
  const set = [refs.partyId, refs.opportunityId, refs.projectId].filter(
    (v) => typeof v === "number",
  ).length;
  if (opts.required && set !== 1) {
    throw new Error(`${toolName}: provide exactly one of partyId, opportunityId, or projectId`);
  }
  if (set > 1) {
    throw new Error(
      `${toolName}: provide at most one of partyId, opportunityId, or projectId — Capsule allows a record to be related to at most one entity`,
    );
  }
}
