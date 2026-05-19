/**
 * Tests for the tasks-config env reader.
 *
 * The reader has three jobs: parse truthy spellings of the enable
 * flag, parse positive-integer env vars with sensible fallbacks,
 * and apply the two clamps (defaultTtl <= maxKeepAlive,
 * defaultPollFrequency >= MIN_POLL_FREQUENCY).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTasksConfig } from "../../src/tasks/config.js";

const KEYS = [
  "MCP_TASKS_ENABLED",
  "MCP_TASKS_DEFAULT_TTL_MS",
  "MCP_TASKS_MAX_KEEP_ALIVE_MS",
  "MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS",
  "MCP_TASKS_MAX_PER_CLIENT",
  "MCP_TASKS_MAX_TOTAL",
];

describe("getTasksConfig", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("returns disabled with sensible defaults when no env vars are set", () => {
    const cfg = getTasksConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.defaultTtlMs).toBe(5 * 60 * 1000);
    expect(cfg.maxKeepAliveMs).toBe(15 * 60 * 1000);
    expect(cfg.defaultPollFrequencyMs).toBe(1500);
    expect(cfg.maxPerClient).toBe(20);
    expect(cfg.maxTotal).toBe(200);
  });

  it("accepts the same truthy spellings as the rest of the codebase", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "Yes"]) {
      process.env["MCP_TASKS_ENABLED"] = v;
      expect(getTasksConfig().enabled).toBe(true);
    }
  });

  it("treats other values as false", () => {
    for (const v of ["0", "false", "no", "off", "", "random"]) {
      process.env["MCP_TASKS_ENABLED"] = v;
      expect(getTasksConfig().enabled).toBe(false);
    }
  });

  it("falls back when integer env vars are malformed", () => {
    process.env["MCP_TASKS_MAX_PER_CLIENT"] = "not-a-number";
    process.env["MCP_TASKS_MAX_TOTAL"] = "-7";
    const cfg = getTasksConfig();
    expect(cfg.maxPerClient).toBe(20);
    expect(cfg.maxTotal).toBe(200);
  });

  it("clamps defaultTtlMs to maxKeepAliveMs", () => {
    process.env["MCP_TASKS_MAX_KEEP_ALIVE_MS"] = "10000";
    process.env["MCP_TASKS_DEFAULT_TTL_MS"] = "999999";
    const cfg = getTasksConfig();
    expect(cfg.maxKeepAliveMs).toBe(10000);
    expect(cfg.defaultTtlMs).toBe(10000);
  });

  it("floors defaultPollFrequencyMs at the safety minimum", () => {
    process.env["MCP_TASKS_DEFAULT_POLL_FREQUENCY_MS"] = "50";
    expect(getTasksConfig().defaultPollFrequencyMs).toBe(500);
  });
});
