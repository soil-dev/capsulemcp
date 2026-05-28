/**
 * Builds the `serverInfo.icons` array shape for MCP's `initialize`
 * response. Lives separately from the generated `src/icon.ts` so the
 * shape can evolve (URL form, multiple sizes, fallback ordering)
 * without touching the SVG generator.
 *
 * Why two forms (URL + data URI):
 *
 *   - URL form (`https://<base>/icon.svg`) — preferred by client UIs
 *     whose Content-Security-Policy blocks `data:` image srcs in
 *     `<img>` tags. Empirically: a sibling MCP server (Discourse-
 *     flavored, served from a custom domain) renders its icon
 *     correctly in Claude.ai's connector list while capsulemcp on
 *     a `*.run.app` URL did not — the difference traced to URL-vs-
 *     data-URI src shape, not the icon bytes themselves.
 *   - Data URI form — host-independent fallback. The stdio entry
 *     has no HTTP route to serve the SVG from, so the data URI is
 *     the only viable shape there. Also useful for clients that
 *     prefer inline bytes (no extra fetch round-trip).
 *
 * Ordering rule: URL first when available, then data URI. Clients
 * that iterate the array and pick the first usable entry get the
 * URL form by default and never see the data URI; clients that
 * filter by `mimeType` or `sizes` see both and can pick either.
 *
 * When `publicBaseUrl` is undefined (stdio invocation, or HTTP
 * deploy that hasn't configured `PUBLIC_BASE_URL`), only the data
 * URI entry is emitted — preserves the pre-v1.6.x behaviour exactly.
 */

import { ICON_DATA_URI } from "./icon.js";

interface IconEntry {
  src: string;
  mimeType: string;
  sizes: string[];
}

export function buildIcons(publicBaseUrl?: string): IconEntry[] {
  const icons: IconEntry[] = [];

  if (publicBaseUrl) {
    // Strip trailing slash so the URL doesn't render as
    // `https://host//icon.svg` if the caller passes a base ending in /.
    // (Express's iconHandler at /icon.svg responds to either form, but
    // the wire shape should look clean to humans reading the
    // initialize response.)
    const base = publicBaseUrl.replace(/\/+$/, "");
    icons.push({
      src: `${base}/icon.svg`,
      mimeType: "image/svg+xml",
      sizes: ["any"],
    });
  }

  // Data URI: host-independent fallback. Always present — covers
  // stdio (no HTTP route) and clients that prefer inline bytes.
  icons.push({
    src: ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["64x64", "any"],
  });

  return icons;
}
