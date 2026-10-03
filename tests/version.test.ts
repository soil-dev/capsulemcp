/**
 * The connector version has one source (src/version.ts) feeding both MCP
 * `serverInfo` and the `/health` page. The release checklist bumps it
 * together with package.json; this pins that the two never drift, so a
 * forgotten bump fails CI instead of shipping a stale version to the
 * monitoring surface.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
