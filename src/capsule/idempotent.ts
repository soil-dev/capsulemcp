/**
 * Idempotency helper for destructive ops.
 *
 * Capsule's delete/remove endpoints return an error when the target
 * is already gone (404 for most ops; 422 with "tag not found to
 * delete" for the tag-detach PUT shape). Reconciliation loops, undo
 * flows, and naïve retry logic expect destructive ops to be safe to
 * re-issue ("desired state: gone; current state: gone; → success").
 *
 * Originally each of the 11 destructive tools had its own try/catch
 * block doing the same shape. This helper collapses them to a single
 * call, plus a named predicate for each error class.
 *
 * Usage:
 *
 *   return idempotent(
 *     () => capsuleDelete(`/parties/${input.id}`),
 *     () => ({ deleted: true, alreadyDeleted: false, id: input.id }),
 *     () => ({ deleted: true, alreadyDeleted: true,  id: input.id }),
 *   );
 *
 * The default error predicate is `isCapsule404` — catches Capsule's
 * standard "doesn't exist" 404. For the PUT-with-_delete tag remove
 * (which 422s with a specific message rather than 404ing), pass
 * `isCapsuleTagNotFound` as the fourth argument.
 */

import { CapsuleApiError } from "./client.js";

/** Capsule returned 404 — the entity doesn't exist (any more). */
export const isCapsule404 = (err: unknown): boolean =>
  err instanceof CapsuleApiError && err.status === 404;

/**
 * Capsule returned 422 specifically because a tag link wasn't there.
 * Used by remove_tag_by_id, where the PUT-with-_delete shape on a
 * not-attached tag gets `422 ... tag not found to delete`. Other 422s
 * with different wording still surface.
 */
export const isCapsuleTagNotFound = (err: unknown): boolean =>
  err instanceof CapsuleApiError &&
  err.status === 422 &&
  /tag not found/i.test(err.message);

/**
 * Run a destructive operation idempotently: if `op` throws an error
 * matching `isAlreadyDoneError`, return the `alreadyDone()` shape;
 * otherwise return `success()` after `op` resolves. Any other error
 * propagates unchanged.
 *
 * The discarded return value of `op` is intentional — most destructive
 * Capsule responses are uninteresting (204 No Content, or the modified
 * entity which the caller doesn't usually need). Callers that DO need
 * the response shape (e.g. remove_party_email_address_by_id which
 * folds Capsule's updated party into the result) should call
 * capsulePut directly and merge into the success shape themselves.
 */
export async function idempotent<T>(
  op: () => Promise<unknown>,
  success: () => T,
  alreadyDone: () => T,
  isAlreadyDoneError: (err: unknown) => boolean = isCapsule404,
): Promise<T> {
  try {
    await op();
    return success();
  } catch (err) {
    if (isAlreadyDoneError(err)) return alreadyDone();
    throw err;
  }
}

/**
 * Same as `idempotent` but threads the operation's return value
 * through to `success(result)` — useful for the party-child PUT
 * remove tools that fold Capsule's updated party into the success
 * shape. The `alreadyDone` callback runs without arguments since the
 * op errored before producing anything.
 */
export async function idempotentWithResult<TOp, TOut>(
  op: () => Promise<TOp>,
  success: (result: TOp) => TOut,
  alreadyDone: () => TOut,
  isAlreadyDoneError: (err: unknown) => boolean = isCapsule404,
): Promise<TOut> {
  try {
    const result = await op();
    return success(result);
  } catch (err) {
    if (isAlreadyDoneError(err)) return alreadyDone();
    throw err;
  }
}
