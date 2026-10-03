/**
 * Per-source-IP rate limiting for the unauthenticated public surfaces
 * (`GET /health` today). The authenticated `/mcp` limiter in app.ts
 * keys on the OAuth client_id instead — a different threat model — but
 * both read the same `MCP_HTTP_RATE_LIMIT_*` knobs so an operator tunes
 * one set of numbers.
 *
 * Each `createIpRateLimit` call gets its own in-memory store, so a
 * monitoring probe hammering `/health` never eats into a caller's
 * `/mcp` budget and vice versa.
 */

import type express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { readPositiveInt } from "../env.js";

const DEFAULT_MCP_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MCP_RATE_LIMIT_MAX = 600;
const MAX_MEMORY_STORE_WINDOW_MS = 2 ** 31 - 1;

export function resolveMcpRateLimitConfig(): {
  windowMs: number;
  limit: number;
  disabled: boolean;
} {
  // express-rate-limit's default MemoryStore backs `windowMs` with
  // setInterval, so over-large or negative values get coerced by Node
  // timers after only a logged validation error. Parse defensively here
  // so operator typos fall back or clamp before they reach the store.
  const windowMs = Math.min(
    readPositiveInt("MCP_HTTP_RATE_LIMIT_WINDOW_MS", DEFAULT_MCP_RATE_LIMIT_WINDOW_MS),
    MAX_MEMORY_STORE_WINDOW_MS,
  );
  return {
    windowMs,
    limit: readPositiveInt("MCP_HTTP_RATE_LIMIT_MAX", DEFAULT_MCP_RATE_LIMIT_MAX),
    disabled: process.env["MCP_HTTP_RATE_LIMIT_DISABLED"] === "1",
  };
}

export interface IpRateLimitOptions {
  /** What to send when the limit is hit; the surface decides the body shape. */
  handler: express.RequestHandler;
}

/**
 * A limiter keyed on the SOURCE IP, never on anything the caller
 * controls. `trust proxy` (set on the app before any router) makes
 * `req.ip` the real client address behind a single front-end hop, and
 * `ipKeyGenerator` buckets IPv6 by /56 so a /128 walk can't sidestep it.
 */
export function createIpRateLimit(opts: IpRateLimitOptions): express.RequestHandler {
  const { windowMs, limit, disabled } = resolveMcpRateLimitConfig();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    skip: () => disabled,
    handler: opts.handler,
  });
}
