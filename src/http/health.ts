/**
 * GET /health — the connector's upstream-credential check: an alerting
 * target for an external uptime checker, NOT a container liveness probe
 * (a platform that restarted the container on 503 would take the
 * service down for exactly the condition this page exists to report).
 *
 * Unauthenticated on purpose: it exists so an external uptime checker
 * (Cloud Monitoring, a cron with curl, …) can tell within minutes that
 * the Capsule token was revoked, and those checkers cannot do OAuth.
 * What it exposes is therefore kept to exactly the fields an operator
 * needs and nothing an attacker could use: the connector's version,
 * the probe verdict, and when the probe ran. No token material, no
 * `detail` text (which may quote an error message), no tenant data.
 *
 * Semantics:
 *   200 `{ status: "ok", token_status: "valid", … }`        — token accepted
 *   503 `{ status: "degraded", token_status: "rejected" | "unreachable", … }`
 *
 * 503 for BOTH non-valid states so a checker configured for "HTTP 200
 * and body contains `"token_status":"valid"`" is the whole alert rule.
 * `Cache-Control: no-store` because a cached 200 would defeat the point.
 * The probe itself is cached 60 s (src/capsule/health.ts), so a checker
 * polling every 5 minutes costs Capsule one request per poll and a
 * flood of unauthenticated hits costs it at most one per minute; the
 * per-IP limiter bounds the CPU spend on top. The probe runs under an
 * 8 s deadline, so a hung Capsule becomes a 503 from THIS handler before
 * the checker (~10 s) or the hosting platform's request timeout gives up
 * and turns the page into a 504 that looks like a connector fault.
 *
 * Path. `/health` by default — deliberately NOT `/healthz`: Cloud Run's
 * frontend reserves `/healthz` and answers it with its own 404 before
 * the container sees the request, which would make an uptime check on
 * this page fail closed forever and hide the one thing it exists to
 * detect. `CAPSULE_MCP_HEALTH_PATH` moves the page for platforms that
 * claim `/health` as well, without a connector release; the deployment's
 * checker must point at the same path (DEPLOY.md).
 */

import type express from "express";
import { type CapsuleHealth, checkCapsuleHealth } from "../capsule/health.js";
import { VERSION } from "../version.js";
import { createIpRateLimit } from "./rate-limit.js";

export const DEFAULT_HEALTH_PATH = "/health";

/**
 * Prefixes an override may not claim: the page is mounted ahead of the
 * OAuth router and the MCP endpoint, so a colliding path would silently
 * shadow them instead of failing loudly.
 */
const RESERVED_PATH_PREFIXES = [
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/.well-known",
  "/icon.svg",
  "/favicon.ico",
];

/**
 * The route the health page is mounted on. Read at mount time (not
 * module load) so tests can set the env per case. An override must be
 * an absolute path with no query string; anything else is refused
 * loudly at startup rather than silently mounting an unreachable page.
 */
export function resolveHealthPath(): string {
  const override = process.env["CAPSULE_MCP_HEALTH_PATH"];
  if (override === undefined || override === "") return DEFAULT_HEALTH_PATH;
  // One or more non-empty segments: rejects a relative path, a query
  // string, whitespace, a trailing slash and a protocol-relative `//host`.
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(override) || override.length > 128) {
    throw new Error(
      "CAPSULE_MCP_HEALTH_PATH must be an absolute path such as /health or /-/health " +
        "(segments of letters, digits, . _ ~ -; no query string, no empty segments).",
    );
  }
  const lower = override.toLowerCase();
  if (RESERVED_PATH_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`))) {
    throw new Error(
      `CAPSULE_MCP_HEALTH_PATH may not be ${override}: that path belongs to the OAuth or MCP ` +
        `surface (reserved: ${RESERVED_PATH_PREFIXES.join(", ")}).`,
    );
  }
  return override;
}

export interface HealthBody {
  status: "ok" | "degraded";
  connector_version: string;
  token_status: CapsuleHealth["token_status"];
  checked_at: string;
}

/** Project a probe result onto the public response body — the ONLY fields /health ever returns. */
export function healthBody(health: CapsuleHealth): HealthBody {
  return {
    status: health.token_status === "valid" ? "ok" : "degraded",
    connector_version: VERSION,
    token_status: health.token_status,
    checked_at: health.checked_at,
  };
}

export function healthStatusCode(health: CapsuleHealth): 200 | 503 {
  return health.token_status === "valid" ? 200 : 503;
}

export const healthHandler: express.RequestHandler = async (_req, res) => {
  let health: CapsuleHealth;
  try {
    health = await checkCapsuleHealth();
  } catch (err) {
    // checkCapsuleHealth folds every failure into `unreachable` and
    // should never reject; if it somehow does, still answer honestly
    // rather than let Express turn it into a 500 with a stack trace.
    health = {
      token_status: "unreachable",
      checked_at: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  res.status(healthStatusCode(health)).set("Cache-Control", "no-store").json(healthBody(health));
};

export function mountHealth(app: express.Express): void {
  const limiter = createIpRateLimit({
    handler: (_req, res) => {
      res.status(429).set("Cache-Control", "no-store").json({ error: "too_many_requests" });
    },
  });
  app.get(resolveHealthPath(), limiter, healthHandler);
}
