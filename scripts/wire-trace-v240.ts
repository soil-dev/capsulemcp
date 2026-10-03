/**
 * Wire-trace for v2.4.0 — the token-health probe behind `GET /health`
 * (src/capsule/health.ts), exercised against the LIVE Capsule API
 * through the real TS code:
 *
 *   1. the configured token  → token_status "valid" (Capsule answered
 *      GET /users/current with 200), one request, no 429 retry
 *   2. a garbage token        → token_status "rejected" / "unauthorized"
 *      (Capsule answered 401), so a revoked token is told apart from
 *      an outage
 *   3. the probe's deadline   → 8 s, never the tool calls' 60 s
 *
 * Read-only: nothing is created. Run with:
 *   CAPSULE_API_TOKEN=<any-scope> npx tsx scripts/wire-trace-v240.ts
 *
 * The forced `capsule.auth` events the probe emits are printed to
 * stderr as part of the run — that is the event the deployment's
 * log-based alert counts.
 */

import { subscribe } from "node:diagnostics_channel";

const calls: Array<{ method: string; path: string }> = [];
subscribe("undici:request:create", (message: unknown) => {
  const r = (message as { request?: { method: string; path: string } }).request;
  if (r) calls.push({ method: r.method, path: r.path });
});

let checks = 0;
function assertWire(label: string, cond: boolean, detail: string) {
  checks++;
  if (!cond) throw new Error(`✗ [${label}] ${detail}`);
  console.log(`  ✓ ${label} — ${detail}`);
}

async function main() {
  const realToken = process.env["CAPSULE_API_TOKEN"];
  if (!realToken) {
    console.error("CAPSULE_API_TOKEN not set");
    process.exit(1);
  }
  const { HEALTH_PROBE_PATH, HEALTH_PROBE_TIMEOUT_MS, checkCapsuleHealth, resetHealthForTests } =
    await import("../src/capsule/health.js");

  console.log(
    "========== WIRE TRACE v2.4.0 — token-health probe against the live API ==========\n",
  );

  console.log("== valid token ==");
  const valid = await checkCapsuleHealth({ force: true });
  assertWire(
    "verdict",
    valid.token_status === "valid",
    `configured token → token_status=${valid.token_status}`,
  );
  assertWire(
    "one request",
    calls.length === 1 && calls[0]!.method === "GET" && calls[0]!.path.endsWith(HEALTH_PROBE_PATH),
    `exactly one GET ${HEALTH_PROBE_PATH} on the wire (no retry, no extra calls)`,
  );

  console.log("\n== garbage token ==");
  process.env["CAPSULE_API_TOKEN"] = "ZZZ-MCP-WT240-not-a-real-token";
  resetHealthForTests();
  const rejected = await checkCapsuleHealth({ force: true });
  process.env["CAPSULE_API_TOKEN"] = realToken;
  assertWire(
    "verdict",
    rejected.token_status === "rejected" && rejected.reason === "unauthorized",
    `garbage token → token_status=${rejected.token_status}, reason=${rejected.reason} (Capsule answered 401)`,
  );
  assertWire(
    "no detail leak",
    !(rejected.detail ?? "").includes("ZZZ-MCP-WT240"),
    "detail never quotes the token",
  );

  console.log("\n== deadline ==");
  assertWire("probe deadline", HEALTH_PROBE_TIMEOUT_MS === 8_000, "8 s, not the tool calls' 60 s");

  console.log(`\n✓ wire-trace v2.4.0 complete — ${checks} checks passed against the live API.`);
}

main().catch((err) => {
  console.error("\n✗ wire-trace v2.4.0 failed:", err);
  process.exit(1);
});
