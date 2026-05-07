# HOWTO

Task-oriented procedures for working on capsulemcp. Focused on the things you might actually need to do; if something common is missing, that's a doc bug.

## Run tests locally

```sh
git clone https://github.com/arapov/capsulemcp.git
cd capsulemcp
npm install
npm test
```

84 tests, all mocked — no Capsule API calls happen, no token needed.

Watch mode while editing:

```sh
npm run test:watch
```

## Build

```sh
npm run build
```

Produces `dist/index.js` (stdio entry, ~600 B), `dist/http.js` (HTTP entry, ~13 KB), and a shared `dist/chunk-*.js` (~34 KB) holding the tools and SDK code. tsup target is Node 20.

## Run the stdio server locally

For testing the stdio path interactively (e.g. with [`mcp-inspector`](https://github.com/modelcontextprotocol/inspector)):

```sh
npm run build

CAPSULE_API_TOKEN=<your token> \
CAPSULE_MCP_READONLY=1 \
node dist/index.js
```

## Run the HTTP server locally

```sh
npm run build

CAPSULE_API_TOKEN=<your token> \
CAPSULE_MCP_READONLY=1 \
PUBLIC_BASE_URL=http://localhost:8080 \
MCP_OAUTH_SIGNING_KEY=$(openssl rand -hex 32) \
MCP_OAUTH_CLIENT_ID=local-test \
MCP_OAUTH_CLIENT_SECRET=$(openssl rand -hex 32) \
MCP_OAUTH_REDIRECT_URIS=http://localhost:9999/cb \
node dist/http.js
```

You can then walk the OAuth dance against `http://localhost:8080`. See [Smoke test a deployed instance](#smoke-test-a-deployed-instance) for a script that does it.

For dev with auto-rebuild, use `npm run dev` (tsup watch) in one terminal and re-run `node dist/http.js` in another whenever you want to pick up changes.

## Smoke test a deployed instance

Save this as `smoke.sh` and run it against any deployed capsulemcp:

```sh
#!/bin/sh
set -eu
URL="${URL:-https://your-deployment-url}"
CLIENT_ID="${CLIENT_ID:?set CLIENT_ID env var}"
CLIENT_SECRET="${CLIENT_SECRET:?set CLIENT_SECRET env var}"

# PKCE pair
VERIFIER=$(python3 -c "import secrets; print(secrets.token_urlsafe(64))")
CHALLENGE=$(python3 -c "
import base64, hashlib, sys
print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b'=').decode())
" "$VERIFIER")

# 1. Authorize → get a code
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "$URL/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=$CHALLENGE&code_challenge_method=S256&state=t1")
CODE=$(python3 -c "
import sys
from urllib.parse import urlparse, parse_qs
print(parse_qs(urlparse(sys.argv[1]).query).get('code', [''])[0])
" "$LOC")

# 2. Exchange code for access token
ACCESS_TOKEN=$(curl -s -X POST "$URL/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "code_verifier=$VERIFIER" \
  --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 3. Call /mcp
curl -s -X POST "$URL/mcp" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_users","arguments":{}},"id":1}'
```

Run with:

```sh
URL=https://your.deployment.example \
CLIENT_ID=... \
CLIENT_SECRET=... \
sh smoke.sh
```

If you see `"users":` in the response, the full chain works.

## Run the live round-trip script

`scripts/live-smoke.ts` exercises every write tool against your real Capsule tenant: create a throwaway party → update it → add notes → create opportunity → create + complete + delete task → delete entry → delete opportunity → delete party. Cleans up on exit (success or failure).

```sh
CAPSULE_API_TOKEN=<your token> npx tsx scripts/live-smoke.ts
```

> **Use a non-production tenant if possible.** The script makes real API calls. It's careful about cleanup but a crash in just the wrong place could leave a stray party named `ZZZ-MCP-Test-...` in your Capsule.

## Add a new tool

Tools live in `src/tools/<resource>.ts`. Pattern for a new read tool:

```ts
// src/tools/parties.ts (example — adding a hypothetical "count parties" tool)
export const countPartiesSchema = z.object({});

export async function countParties(_input: z.infer<typeof countPartiesSchema>) {
  const { data } = await capsuleGet<{ count: number }>("/parties/count");
  return data;
}
```

Register it in `src/server.ts`:

```ts
import { countPartiesSchema, countParties, ... } from "./tools/parties.js";
// ...
server.tool(
  "count_parties",
  "Return the total number of parties in the Capsule tenant.",
  countPartiesSchema.shape,
  async (input) => {
    const result = await countParties(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);
```

For a write tool:

```ts
export const createSomethingSchema = z.object({
  name: z.string().min(1),
  // ...
});

export async function createSomething(input: z.infer<typeof createSomethingSchema>) {
  return capsulePost<{ thing: unknown }>("/things", { thing: input });
}
```

Register inside the `if (!readOnly)` block in `server.ts` so `CAPSULE_MCP_READONLY=1` correctly hides it.

For a delete tool, include `confirm: z.literal(true)` in the schema and check it in the handler — see any `delete_*` tool for the pattern. The schema-level gate prevents accidental destruction; never skip it.

Add a unit test in `tests/<resource>.test.ts` mocking `undici.fetch`. The existing tests are good templates.

Run `npm test` and `npm run build` to confirm it integrates cleanly. Commit, push, optionally cut a release (see below).

## Cut a release

```sh
# 1. Bump version in package.json and src/server.ts (the McpServer name+version block)
# 2. Confirm tests pass
npm test
npm run build

# 3. Commit + tag + push
git commit -am "release: vX.Y.Z"
git push
git tag -a vX.Y.Z -m "vX.Y.Z — short summary"
git push origin vX.Y.Z

# 4. Optional: GitHub Release with notes
gh release create vX.Y.Z --title "vX.Y.Z — title" --notes "<release notes>"
```

The `npx -y github:arapov/capsulemcp#vX.Y.Z` install path picks up the new tag immediately. Users on `#vX.Y.(Z-1)` keep using the old tag until they bump.

Versioning convention:

| Bump | When |
|---|---|
| Patch (`0.3.0` → `0.3.1`) | Bug fixes, doc updates, internal refactors |
| Minor (`0.3.0` → `0.4.0`) | New tools, new env vars, new transport options. Backwards-compatible behaviour change |
| Major (`0.x.y` → `1.0.0`) | Breaking change. Pre-1.0 there's no formal stability promise; treat 1.0 as the first time you commit to API stability |

## Debug a tool that's misbehaving

Reproduce locally:

```sh
npm run build
CAPSULE_API_TOKEN=<your token> npx tsx scripts/live-smoke.ts
```

Or call the tool function directly with `tsx` (the IIFE wrapper is needed because `tsx -e` doesn't enable top-level await by default):

```sh
CAPSULE_API_TOKEN=<your token> npx tsx -e '
  (async () => {
    const { searchParties } = await import("./src/tools/parties.js");
    const r = await searchParties({ q: "Acme", page: 1, perPage: 10 });
    console.log(JSON.stringify(r, null, 2));
  })();
'
```

To see the raw HTTP traffic:

```sh
CAPSULE_API_TOKEN=<your token> NODE_DEBUG=undici npx tsx -e '...' 2>&1 | head -50
```

If a Capsule endpoint behaves unexpectedly, hit it directly with curl:

```sh
curl -s -H "Authorization: Bearer $CAPSULE_API_TOKEN" \
     -H "Accept: application/json" \
     "https://api.capsulecrm.com/api/v2/parties/<id>?embed=tags,fields" | python3 -m json.tool
```

The `CAPSULE_API_BASE_URL` env var lets you swap the base URL — useful for hitting a mock server in tests.

## Troubleshooting recipes

| Problem | First check |
|---|---|
| Tool not visible to Claude | `tools/list` via the inspector or smoke script — is it actually registered? |
| `npx` install pulling stale code | `rm -rf ~/.npm/_npx`, restart Claude Desktop |
| Tests pass but live behaviour differs | Capsule API may have undocumented quirks; verify with curl |
| OAuth dance succeeds but `/mcp` 401s | `MCP_OAUTH_SIGNING_KEY` differs between issuance and verification — usually means a deploy rolled in between |
| Cloud Run instance idle / cold | First request after ~15 min idle takes a few seconds. Set `--min-instances=1` to eliminate |

For deployment-specific troubleshooting see [DEPLOY.md](DEPLOY.md#troubleshooting).
