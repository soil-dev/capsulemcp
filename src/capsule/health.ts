/**
 * Token-health probe: is the connector's Capsule Personal Access Token
 * still accepted?
 *
 * Why this exists. A hosted connector that sees traffic a few times a
 * day can stay silently broken for a long time when its token is
 * revoked, expires, or the owning user is deactivated: every call
 * answers 401 with the same body, and no error-rate alert ever has
 * enough samples to fire. The fix is an active probe the connector
 * runs itself and exposes two ways — the unauthenticated `GET /health`
 * page (src/http/health.ts) for an external uptime checker, and the
 * forced `capsule.auth` log event — so a dead token is noticed in
 * minutes, not weeks.
 *
 * What it does. One authenticated `GET /users/current` under the
 * probe's own 8 s deadline (`HEALTH_PROBE_TIMEOUT_MS`, not the tool
 * calls' 60 s). It is the cheapest call a read-scoped token can make
 * and answers 200 for any token Capsule accepts, so 200 means "token
 * valid" with no false negatives. 401 means Capsule rejected the
 * credential (revoked, expired, user gone) → `rejected`. 403 means the
 * token authenticated but may not read its own user — a scope problem,
 * still a token problem → `rejected`. Any other status, a timeout or a
 * transport error → `unreachable`: nothing is known about the token
 * either way, and the probe says so rather than guess.
 *
 * Why 8 s. The probe exists to answer an external uptime checker, and
 * those give up after ~10 s; the hosting platform's own request
 * timeout is typically of the same order as the client's 60 s deadline.
 * A 60 s probe could therefore never report "unreachable" in time —
 * the platform would answer the checker 504 long after it stopped
 * listening. 8 s turns an upstream hang into a prompt 503 plus the
 * forced event, while leaving a slow Capsule room to answer one small
 * GET.
 *
 * The result is cached for 60 s (`HEALTH_CACHE_TTL_MS`) and concurrent
 * callers share one in-flight probe, so a flood of unauthenticated
 * `/health` hits costs Capsule at most one request per minute.
 * `force: true` bypasses the cache (startup, tests).
 *
 * Events. Every CHANGE of `token_status` — including the first result —
 * emits a forced `capsule.auth` event (bypasses the verbose gate) so an
 * operator sees "valid → rejected" without turning verbose logging on.
 * It carries `token_status` and a closed-vocabulary `reason`
 * (`HealthReason`) — NOT the free-text `detail`, which may quote an
 * upstream error message and would break the "no request / response
 * bodies, ever" logging invariant on the one event operators cannot
 * switch off. `detail` stays on the result for the startup warning.
 *
 * Never logs or returns the token.
 */

import { logEvent } from "../log.js";
import { CapsuleAuthError, CapsuleTimeoutError, capsuleProbe } from "./client.js";

/** The probe target. See the module comment for why this endpoint. */
export const HEALTH_PROBE_PATH = "/users/current";
/** Deadline for the probe request — 8 s, not the client's 60 s `REQUEST_TIMEOUT_MS`. */
export const HEALTH_PROBE_TIMEOUT_MS = 8_000;
/** How long a verdict is served from cache before Capsule is asked again. */
export const HEALTH_CACHE_TTL_MS = 60_000;

/**
 * Closed vocabulary for a non-`valid` verdict — the only cause that
 * goes into log events:
 *
 *   unauthorized   — rejected: Capsule answered 401 (revoked / expired / user gone)
 *   forbidden      — rejected: Capsule answered 403 (token lacks the read scope)
 *   http_<status>  — unreachable: any other non-2xx status (5xx, 429, …)
 *   timeout        — unreachable: the request hit the probe's deadline
 *   network_error  — unreachable: DNS / connect / TLS / reset
 *   config_error   — unreachable: CAPSULE_API_TOKEN unset or CAPSULE_API_BASE_URL invalid
 */
export type HealthReason =
  | "unauthorized"
  | "forbidden"
  | `http_${number}`
  | "timeout"
  | "network_error"
  | "config_error";

export interface CapsuleHealth {
  /**
   * `valid`       — an authenticated GET /users/current answered 200.
   * `rejected`    — Capsule answered 401 or 403: the token is not usable.
   * `unreachable` — anything else: network error, timeout, a 5xx, a
   *                 configuration error. Says nothing about the token.
   */
  token_status: "valid" | "rejected" | "unreachable";
  /** ISO-8601 timestamp of the probe that produced this result. */
  checked_at: string;
  /** Closed-vocabulary cause for a non-`valid` status. This — never `detail` — goes into log events. */
  reason?: HealthReason;
  /**
   * Operator-facing explanation for a non-`valid` status, for the
   * startup stderr warning and nothing else: it may quote an upstream
   * error message. Never contains the token. Not returned by `/health`,
   * not logged.
   */
  detail?: string;
}

let cached: CapsuleHealth | undefined;
let cachedAtMs = 0;
let inflight: Promise<CapsuleHealth> | undefined;

/** Last probe result, if any — regardless of age. `undefined` before the first probe. */
export function getCachedHealth(): CapsuleHealth | undefined {
  return cached;
}

/** Test hook: forget the cached result and any in-flight probe. */
export function resetHealthForTests(): void {
  cached = undefined;
  cachedAtMs = 0;
  inflight = undefined;
}

/**
 * Return the cached health if it is fresh, otherwise probe Capsule.
 * Never rejects: every failure mode is folded into `token_status:
 * "unreachable"` with a `detail`, because callers (the startup hook,
 * `/health`) need an answer, not an exception.
 *
 * `timeoutMs` exists for tests that exercise the deadline wiring with
 * a real clock; production callers take the default.
 */
export async function checkCapsuleHealth(
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<CapsuleHealth> {
  if (!opts.force && cached && Date.now() - cachedAtMs < HEALTH_CACHE_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = runProbe(opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function runProbe(timeoutMs: number): Promise<CapsuleHealth> {
  const previous = cached;
  const verdict = await probeToken(timeoutMs);
  const health: CapsuleHealth = {
    token_status: verdict.token_status,
    checked_at: new Date().toISOString(),
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.detail ? { detail: verdict.detail } : {}),
  };
  cached = health;
  cachedAtMs = Date.now();

  if (!previous || previous.token_status !== health.token_status) {
    // `reason`, never `detail`: this event is forced (cannot be turned
    // off) and `detail` may quote an upstream error message.
    logEvent(
      "capsule.auth",
      {
        token_status: health.token_status,
        ...(health.reason ? { reason: health.reason } : {}),
      },
      { force: true },
    );
  }
  return health;
}

type TokenVerdict = Pick<CapsuleHealth, "token_status" | "reason" | "detail">;

function reasonForThrow(err: unknown): HealthReason {
  if (err instanceof CapsuleAuthError) return "config_error";
  if (err instanceof CapsuleTimeoutError) return "timeout";
  return "network_error";
}

async function probeToken(timeoutMs: number): Promise<TokenVerdict> {
  let status: number;
  try {
    ({ status } = await capsuleProbe(HEALTH_PROBE_PATH, timeoutMs));
  } catch (err) {
    // Network error, timeout, missing CAPSULE_API_TOKEN, invalid base
    // URL — none of these say anything about the token itself.
    return {
      token_status: "unreachable",
      reason: reasonForThrow(err),
      detail: `GET ${HEALTH_PROBE_PATH} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (status >= 200 && status < 300) return { token_status: "valid" };
  if (status === 401) {
    return {
      token_status: "rejected",
      reason: "unauthorized",
      detail:
        `Capsule answered GET ${HEALTH_PROBE_PATH} with 401: the Personal Access Token was revoked, ` +
        "expired, or its user was deactivated. Generate a new token (My Preferences → API " +
        "Authentication Tokens) and update CAPSULE_API_TOKEN.",
    };
  }
  if (status === 403) {
    return {
      token_status: "rejected",
      reason: "forbidden",
      detail:
        `Capsule answered GET ${HEALTH_PROBE_PATH} with 403: the token authenticated but may not read ` +
        "its own user — check the token's scope.",
    };
  }
  return {
    token_status: "unreachable",
    reason: `http_${status}`,
    detail: `GET ${HEALTH_PROBE_PATH} answered HTTP ${status}`,
  };
}

/** The startup warning for a rejected token — one place, so stderr and docs agree. */
export function tokenRejectedWarning(health: CapsuleHealth): string {
  return (
    `the Capsule API token is not usable (${health.reason ?? "rejected"}). ` +
    "Every tool call will fail until CAPSULE_API_TOKEN is replaced. " +
    (health.detail ?? "")
  ).trim();
}
