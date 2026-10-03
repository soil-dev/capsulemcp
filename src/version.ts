/**
 * The connector's version, as reported in MCP `serverInfo` and on the
 * unauthenticated `GET /health` page. Single source so the two can
 * never disagree; mirrors `package.json` and is bumped with it at
 * release time.
 */
export const VERSION = "2.3.2";
