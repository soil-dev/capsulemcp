/**
 * The capsulemcp icon. Stylised diagonal capsule: two halves with a
 * faint highlight stripe. Designed for crisp display down to 16x16.
 * Visually neutral — does not reproduce any Capsule CRM trademark.
 *
 * Generated from assets/icon.svg by scripts/build-icon.mjs. **Do not
 * edit this file directly** — edit the SVG and re-run `npm run
 * build:icon` (or `npm run build`, which chains it).
 *
 * Exposed two ways:
 *   - Embedded as a `data:` URI in the MCP `serverInfo.icons` array
 *     (spec-compliant; works without any HTTP route).
 *   - Served at `/icon.svg` and `/favicon.ico` by the HTTP entry,
 *     in case the consuming client prefers a URL it can fetch.
 */

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="capsulemcp">
  <!-- Stylised diagonal capsule: two halves with a faint highlight stripe.
       Designed for crisp display down to 16x16. Visually neutral — does
       not reproduce any Capsule CRM trademark. -->
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
 * Shaped for MCP's `serverInfo.icons` field. Single 64x64 SVG that
 * scales cleanly to any size; `sizes: ["any"]` tells the client it
 * works at every render size.
 */
export const ICONS = [
  {
    src: ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["64x64", "any"],
  },
];
