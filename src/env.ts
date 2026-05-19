/**
 * Shared env-var readers.
 *
 * Every config-reading site in the codebase parses environment
 * variables at call time (not module init) so tests can flip values
 * per case without reloading the module. The shape of "boolean flag
 * with truthy spellings" and "positive integer with fallback"
 * recurred enough across `src/log.ts`, `src/capsule/{cache,batch,
 * client}.ts`, and `src/tasks/config.ts` that the helpers live here
 * instead of being copy-pasted.
 *
 * The truthy-spelling rule is uniform: `1`, `true`, `yes`, `on`
 * (case-insensitive). Anything else, including unset, is `false`.
 * Documented in DEPLOY.md against every individual env var so
 * operators don't have to discover this by experimentation.
 */

/** Parse a boolean env var. Recognises 1/true/yes/on (case-insensitive). */
export function readBool(name: string): boolean {
  const raw = process.env[name]?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Parse a positive-integer env var. Returns `fallback` when the
 * variable is unset, empty, non-numeric, negative, or below `min`.
 * Floors fractional inputs.
 */
export function readPositiveInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}
