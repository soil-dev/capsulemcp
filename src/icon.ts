/**
 * The capsulemcp icon.
 *
 * Inlined as a string here (rather than read from disk) so it survives
 * the tsup bundle without needing assets/ in the runtime image. The
 * canonical source is `assets/icon.svg`; if you edit one, edit both,
 * or run a build step that generates this from the SVG file.
 *
 * Exposed two ways:
 *   - Embedded as a data: URI in the MCP `serverInfo.icons` array
 *     (spec-compliant; works without any HTTP route)
 *   - Served at `/icon.svg` and `/favicon.ico` by the HTTP entry, in
 *     case the consuming client (Anthropic's connector UI) prefers a
 *     URL it can fetch
 */

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="capsulemcp">
  <defs>
    <clipPath id="cap">
      <rect x="2" y="22" width="60" height="20" rx="10" ry="10"
            transform="rotate(-32 32 32)"/>
    </clipPath>
  </defs>
  <g clip-path="url(#cap)">
    <rect x="0" y="0" width="32" height="64" fill="#3B82F6"/>
    <rect x="32" y="0" width="32" height="64" fill="#1E3A8A"/>
    <rect x="2" y="22" width="60" height="2" fill="rgba(255,255,255,0.35)"
          transform="rotate(-32 32 32)"/>
  </g>
  <rect x="2" y="22" width="60" height="20" rx="10" ry="10"
        transform="rotate(-32 32 32)" fill="none"
        stroke="rgba(0,0,0,0.15)" stroke-width="1"/>
</svg>`;

export const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG, "utf8").toString("base64")}`;

/**
 * Spec-compliant `Icons.icons` payload for `Implementation`.
 * Three sizes hint to the consumer that the SVG is scalable.
 */
export const ICONS = [
  {
    src: ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];
