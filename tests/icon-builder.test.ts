/**
 * Tests for `buildIcons()` — the `serverInfo.icons` array
 * constructor.
 *
 * Pins three contracts:
 *   1. Stdio shape (no publicBaseUrl) is data-URI-only — preserves
 *      the pre-fix wire shape so stdio installs see no behavioural
 *      change.
 *   2. HTTP shape (publicBaseUrl present) is URL-first, data-URI
 *      second — clients iterating the array and picking the first
 *      usable entry get the URL form (the goal of the fix).
 *   3. Trailing slash on publicBaseUrl is tolerated — `${base}/icon.svg`
 *      doesn't render as `host//icon.svg`.
 */

import { describe, expect, it } from "vitest";
import { buildIcons } from "../src/icon-builder.js";

describe("buildIcons", () => {
  it("stdio shape: undefined publicBaseUrl → data-URI-only entry", () => {
    const icons = buildIcons(undefined);

    expect(icons).toHaveLength(1);
    expect(icons[0]?.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(icons[0]?.mimeType).toBe("image/svg+xml");
    // Preserves the historic `sizes: ["64x64", "any"]` for stdio.
    expect(icons[0]?.sizes).toEqual(["64x64", "any"]);
  });

  it("HTTP shape: URL-first, data-URI-second when publicBaseUrl is set", () => {
    const icons = buildIcons("https://example.test");

    expect(icons).toHaveLength(2);

    // URL entry comes first — clients picking the first array entry
    // get the URL form (the fix's whole point).
    expect(icons[0]?.src).toBe("https://example.test/icon.svg");
    expect(icons[0]?.mimeType).toBe("image/svg+xml");

    // Data URI is the fallback for clients that can't reach the URL
    // (CSP-restricted iframes, offline caches, etc.).
    expect(icons[1]?.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(icons[1]?.mimeType).toBe("image/svg+xml");
  });

  it("strips trailing slash on publicBaseUrl (no `host//icon.svg`)", () => {
    const icons = buildIcons("https://example.test/");
    expect(icons[0]?.src).toBe("https://example.test/icon.svg");

    // Multiple trailing slashes too — defensive against operator typos.
    const icons2 = buildIcons("https://example.test///");
    expect(icons2[0]?.src).toBe("https://example.test/icon.svg");
  });

  it("empty-string publicBaseUrl is treated as 'not set' (data-URI-only)", () => {
    // Defensive: an unset env var sometimes shows up as "" instead
    // of undefined depending on how it's read. Both should fall back
    // to the stdio shape rather than producing a relative URL like
    // `/icon.svg` that's not resolvable.
    const icons = buildIcons("");

    expect(icons).toHaveLength(1);
    expect(icons[0]?.src.startsWith("data:")).toBe(true);
  });
});
