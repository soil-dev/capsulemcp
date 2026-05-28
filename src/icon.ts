/**
 * The capsulemcp icon. Stylised diagonal capsule: two halves with a
 * faint highlight stripe. Designed for crisp display down to 16x16.
 * Visually neutral — does not reproduce any Capsule CRM trademark.
 *
 * Generated from assets/icon.svg by scripts/build-icon.mjs. **Do not
 * edit this file directly** — edit the SVG and re-run `npm run
 * build:icon` (or `npm run build`, which chains it).
 *
 * This file is generated DATA: the raw SVG plus its `data:` URI
 * form. The `serverInfo.icons` ARRAY shape (URL form vs data URI
 * form vs both, ordering, sizes hints) is hand-edited orchestration
 * and lives in `src/icon-builder.ts` — kept out of this generator
 * so the icon-array shape can evolve without touching the SVG.
 *
 * Exposed two ways at runtime:
 *   - Embedded as a `data:` URI in the MCP `serverInfo.icons` array
 *     (spec-compliant; works without any HTTP route — stdio path).
 *   - Served at `/icon.svg` and `/favicon.ico` by the HTTP entry,
 *     so clients that prefer to fetch a URL get a real HTTPS resource
 *     (some UIs' CSP blocks `data:` image srcs — URL form survives).
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
