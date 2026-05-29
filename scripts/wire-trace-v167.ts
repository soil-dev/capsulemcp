/**
 * Wire-trace probes for the connector-gap audit (post-v1.6.6). Answers
 * the two questions that gate whether the proposed `list_tracks` and
 * `delete_tag_definition` tools are even BUILDABLE — i.e. whether
 * Capsule's v2 API exposes the upstream endpoints they'd need. The
 * connector's own notes only document entity-scoped + by-id track
 * reads and tag DETACH (never definition-delete), so both are
 * unverified assumptions until probed.
 *
 *   PROBE 1 — tenant-wide track-instance enumeration.
 *     Does `GET /tracks` list all track instances across the tenant?
 *     If yes (200 + a `tracks` array), a `list_tracks` tool is
 *     buildable and orphan track instances (which survive parent
 *     deletion — NOTES §25) become sweepable. If 404/405, there is
 *     no read-side path to orphans by-anything-but-known-id, and
 *     `list_tracks` is NOT buildable.
 *
 *   PROBE 2 — tag-definition deletion.
 *     `add_tag` auto-creates a tenant-global tag definition; the
 *     connector can DETACH a tag from an entity (`remove_tag_by_id`)
 *     but never DELETE the definition. Does Capsule expose a
 *     definition-delete endpoint? Probes `DELETE /parties/tags/{id}`
 *     then `DELETE /tags/{id}`. If either 200/204s, a
 *     `delete_tag_definition` tool is buildable.
 *
 *     CAVEAT: this probe must create a throwaway tag definition to
 *     attempt deleting it. If NO delete endpoint works, that
 *     definition is stranded in the tenant (there's no API path to
 *     remove it — which is precisely the gap being measured). It is
 *     labelled `ZZZ-V167-DELME-*` so it's trivially findable for
 *     manual web-UI cleanup. The probe reports whether it stranded.
 *
 * Pattern mirrors scripts/wire-trace-v164.ts … -v166.ts: ZZZ-V167-*
 * labelled test records, full cleanup on exit, no tenant-specific
 * strings or IDs committed (everything discovered at runtime). Run
 * with:
 *
 *   CAPSULE_API_TOKEN=<write-scoped> npx tsx scripts/wire-trace-v167.ts
 */

import { fetch } from "undici";

const TOKEN = process.env["CAPSULE_API_TOKEN"];
if (!TOKEN) {
  console.error("CAPSULE_API_TOKEN env var required (write-scoped)");
  process.exit(1);
}

const BASE = "https://api.capsulecrm.com/api/v2";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

interface ApiResult {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = await res.text().catch(() => null);
  }
  return { status: res.status, body: parsed };
}

/** Compact one-line view of a response body, capped. */
function bodyPreview(body: unknown): string {
  return JSON.stringify(body)?.slice(0, 300) ?? "null";
}

/** Pull the array under a top-level key (e.g. `tracks`, `tags`), or []. */
function arrayUnder(body: unknown, key: string): Array<Record<string, unknown>> {
  if (body && typeof body === "object" && key in (body as Record<string, unknown>)) {
    const arr = (body as Record<string, unknown>)[key];
    if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>;
  }
  return [];
}

async function probeTenantWideTracks(): Promise<void> {
  console.log("\n=========================================");
  console.log("PROBE 1: GET /tracks — is there a tenant-wide track-instance list?");
  console.log("=========================================");

  const res = await call("GET", "/tracks?page=1&perPage=2");
  console.log(`  GET /tracks → status ${res.status}`);
  if (res.status === 200) {
    const tracks = arrayUnder(res.body, "tracks");
    const keys = Object.keys((res.body as Record<string, unknown>) ?? {});
    console.log(`  top-level keys: ${JSON.stringify(keys)}`);
    console.log(`  tracks[] present? ${tracks.length > 0 || keys.includes("tracks")}`);
    console.log(`  → BUILDABLE: a list_tracks tool can enumerate tenant-wide instances.`);
    console.log(`  sample: ${bodyPreview(res.body)}`);
  } else if (res.status === 404 || res.status === 405) {
    console.log(`  → NOT BUILDABLE: no tenant-wide track-instance endpoint.`);
    console.log(`     Orphan tracks are reachable only by known id (GET /tracks/{id})`);
    console.log(`     or entity-scoped (GET /<entity>/{id}/tracks). list_tracks is moot.`);
    console.log(`  body: ${bodyPreview(res.body)}`);
  } else {
    console.log(`  → INCONCLUSIVE (unexpected status). body: ${bodyPreview(res.body)}`);
  }

  // Contrast: confirm the entity-scoped + definitions endpoints behave
  // as the connector already assumes (sanity that the token can read
  // tracks at all, so a 404 above is "no endpoint" not "no access").
  const defs = await call("GET", "/tracks/definitions?perPage=1");
  console.log(
    `  contrast GET /tracks/definitions → status ${defs.status} (definitions list the connector already uses)`,
  );
}

async function probeTagDefinitionDelete(): Promise<void> {
  console.log("\n=========================================");
  console.log("PROBE 2: tag-definition deletion — DELETE /parties/tags/{id} then /tags/{id}");
  console.log("=========================================");

  const tag = `ZZZ-V167-${Date.now()}`;
  const tagName = `ZZZ-V167-DELME-${Date.now()}`;
  let hostPartyId: number | undefined;
  let tagId: number | undefined;
  let stranded = true;

  try {
    // Host party to attach the throwaway tag to (add_tag's path is a
    // PUT on an entity; you can't mint a definition without one).
    const host = await call("POST", "/parties", {
      party: { type: "organisation", name: `${tag}-TAGHOST` },
    });
    if (host.status !== 201) {
      console.log(`  setup failed (create host party → ${host.status}); aborting probe 2`);
      return;
    }
    hostPartyId = (host.body as { party: { id: number } }).party.id;
    console.log(`  host party ${hostPartyId}`);

    // Attach a fresh-named tag → Capsule auto-creates the definition.
    // The PUT response does NOT echo the tags array, so read the party
    // back with embed=tags to get the tag object (which carries the
    // tenant-global definition id — NOTES §20).
    await call("PUT", `/parties/${hostPartyId}`, {
      party: { tags: [{ name: tagName }] },
    });
    const read = await call("GET", `/parties/${hostPartyId}?embed=tags`);
    const tags = arrayUnder((read.body as { party?: unknown })?.party ?? {}, "tags");
    const created = tags.find((t) => t["name"] === tagName);
    tagId = typeof created?.["id"] === "number" ? (created["id"] as number) : undefined;
    console.log(`  created tag definition "${tagName}" → id ${tagId ?? "UNKNOWN"}`);
    if (tagId === undefined) {
      console.log(`  could not resolve new tag id; party+tags body: ${bodyPreview(read.body)}`);
      return;
    }

    // Candidate delete endpoints, in order. Stop at first 2xx.
    const candidates = [`/parties/tags/${tagId}`, `/tags/${tagId}`];
    for (const path of candidates) {
      const del = await call("DELETE", path);
      console.log(`  DELETE ${path} → status ${del.status}`);
      if (del.status === 200 || del.status === 204) {
        console.log(`  → BUILDABLE: delete_tag_definition can use DELETE ${path}`);
        stranded = false;
        break;
      }
      if (del.status !== 404 && del.status !== 405) {
        console.log(`     (non-404/405 body: ${bodyPreview(del.body)})`);
      }
    }
    if (stranded) {
      console.log(`  → NOT BUILDABLE: no tag-definition delete endpoint responded 2xx.`);
      console.log(`     Tag definitions can only be removed via Capsule's web UI.`);
    }
  } finally {
    if (hostPartyId !== undefined) {
      const d = await call("DELETE", `/parties/${hostPartyId}`);
      console.log(`  cleanup: delete host party ${hostPartyId} → ${d.status}`);
    }
    // Verify whether the definition outlived the host party (it will,
    // if no delete endpoint worked — definitions are tenant-global,
    // independent of any entity).
    if (tagId !== undefined) {
      const check = await call("GET", "/parties/tags?perPage=100");
      const present = arrayUnder(check.body, "tags").some((t) => t["id"] === tagId);
      console.log(
        `  post-cleanup: tag definition ${tagId} still in tenant? ${present ? "YES" : "no"}`,
      );
      if (present) {
        console.log(`  ⚠ STRANDED: search Capsule's web UI for "${tagName}" and delete manually.`);
      }
    }
  }
}

async function main() {
  try {
    await probeTenantWideTracks();
    await probeTagDefinitionDelete();
    console.log("\nAll probes complete.");
  } catch (err) {
    console.error("\n!!! probe run crashed:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
