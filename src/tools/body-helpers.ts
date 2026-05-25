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
export function setRef(body: Record<string, unknown>, key: string, id: number | undefined): void {
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
