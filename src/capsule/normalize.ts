/**
 * Normalize Capsule's legacy "kase" vocabulary to "project" in response
 * KEYS, at the client boundary.
 *
 * Capsule's v2 API still uses its legacy name for projects — `kases` —
 * in paths (`/kases`), request-body wrapper keys (`{ kase: {...} }`),
 * AND response keys (`{ kases: [...] }`, `task.kase`,
 * `restrictedKases`). Every capsulemcp tool name and input parameter
 * says "project" (`get_project`, `projectId`), so pre-v2 an LLM had to
 * know Capsule trivia to cross-reference its own writes: `update_task
 * { projectId: 5 }` read back as `task.kase.id === 5`.
 *
 * From v2 the connector translates at the read boundary: every JSON
 * response is deep-walked and the keys `kase` → `project`, `kases` →
 * `projects`, `restrictedKases` → `restrictedProjects` are renamed.
 * KEYS ONLY — values are never touched, so a party named "kase" or a
 * tag value "kases" passes through verbatim. The write side is
 * unchanged: request bodies still send Capsule's `kase` wrapper and
 * paths still hit `/kases` — the legacy name stays a wire detail no
 * tool consumer ever sees.
 *
 * Doing this once in `handleResponse` (rather than per-handler)
 * guarantees no tool can leak a `kase` key again, including future
 * ones. Error-message TEXT from Capsule (e.g. a 422 mentioning
 * "kase: owner is required") is passed through verbatim — it's
 * diagnostic prose, not a key.
 */

const KEY_RENAMES: Record<string, string> = {
  kase: "project",
  kases: "projects",
  restrictedKases: "restrictedProjects",
};

export function normalizeProjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeProjectKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[KEY_RENAMES[key] ?? key] = normalizeProjectKeys(v);
    }
    return out;
  }
  return value;
}
