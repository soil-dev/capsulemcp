# Server deployment

This document covers running capsulemcp as a hosted HTTP service so it can be registered as a Claude **Custom Connector** and shared org-wide via a Claude Project. For per-user local installs (Claude Desktop / Claude Code), see the main [README](README.md).

## Why deploy this way

A hosted server lets you:

- Register **one** Custom Connector in Claude Teams/Enterprise admin settings
- Attach it to a **shared Project** with custom instructions describing your Capsule structure
- Have every org member use both the tools and the instructions from any chat in that Project — no per-user setup

## Prerequisites

- Claude **Teams** or **Enterprise** plan with admin access (Custom Connectors aren't available on Free/Pro)
- A container host that terminates HTTPS publicly. This guide uses **Google Cloud Run**, but anything that runs the bundled `Dockerfile` and exposes it on HTTPS works (Cloudflare Workers via container support, Render, Fly.io, AWS App Runner, a VPS with a reverse proxy, etc.)
- A **read-scoped** Capsule Personal Access Token (My Preferences → API Authentication Tokens → pick the Read scope)

### Cloud Run / Google Workspace prerequisites

If your GCP project lives under a Google Workspace organisation (the common case), there are two things to check up front. Both are GWS-org-default policies that silently break Cloud Run deploys until handled.

**1. Grant Cloud Build permissions to the default Compute service account.** As of mid-2024, Google removed the auto-grant. New projects need this once:

```bash
PROJECT=<your-gcp-project>
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
  --role=roles/cloudbuild.builds.builder \
  --condition=None
```

Without this, `gcloud run deploy --source` fails with `PERMISSION_DENIED: Build failed because the default service account is missing required IAM permissions`.

**2. Override `iam.allowedPolicyMemberDomains` at project level so the service can be made public.** Custom Connectors call your endpoint without GCP IAM, so the URL must accept anonymous traffic. GWS org default blocks `allUsers` IAM bindings; without the override, `--allow-unauthenticated` is silently rejected and your URL returns Google's HTML 401/404 pages instead of reaching your container.

This requires `roles/orgpolicy.policyAdmin` (an org-admin role, not a project-owner role). If you don't have it, ask your GWS admin to:

```bash
cat <<EOF > policy.yaml
constraint: constraints/iam.allowedPolicyMemberDomains
listPolicy:
  allValues: ALLOW
EOF

gcloud resource-manager org-policies set-policy policy.yaml --project=$PROJECT
```

The override is project-scoped — other projects in the org keep the default constraint. Reverse with `gcloud resource-manager org-policies delete iam.allowedPolicyMemberDomains --project=$PROJECT`.

## Auth modes

The HTTP entry supports two OAuth modes, selected at startup by env-var presence. Static-client is the recommended mode for any public deployment; auto-approve is opt-in for local / private-network use. If neither is configured, the server **refuses to start** so you can't accidentally deploy in an unsafe configuration.

### `static-client` mode (default, recommended)

Active when `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET` are set. One hard-coded OAuth client is recognised; Dynamic Client Registration (`/register`) is **disabled**. The configured `client_secret` is the real auth boundary, equivalent to a strong API key.

Only callers presenting both the right `client_id` and the right `client_secret` can complete the OAuth dance. This is the model you want for any deployment reachable from the public internet.

### `insecure-auto-approve` mode

Active when `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`. DCR is open and `/authorize` auto-approves. **Anyone who can reach the URL can register a client and get in.** Suitable only for:

- local development on `localhost`
- private-network deployments (VPN, internal-only Cloud Run, behind Cloud Armor IP allowlist)
- ngrok-style temporary demos

The server logs a loud warning at boot when this mode is active.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CAPSULE_API_TOKEN` | yes | — | Use a read-scoped token for org deployments |
| `PUBLIC_BASE_URL` | yes (HTTP entry only) | — | The public origin where this server is reachable, e.g. `https://capsulemcp.example.run.app`. Used to build OAuth metadata URLs |
| `MCP_OAUTH_SIGNING_KEY` | yes (HTTP entry only) | — | HMAC key used to sign OAuth access tokens. Must be ≥ 16 chars and stable across instances. Treat like a private key. Falls back to `MCP_SHARED_SECRET` for backwards compat |
| `MCP_OAUTH_CLIENT_ID` | yes for `static-client` mode | — | The one allowed OAuth client_id; pasted into Anthropic's connector form |
| `MCP_OAUTH_CLIENT_SECRET` | yes for `static-client` mode | — | The matching client_secret; same treatment. Must be ≥ 16 chars |
| `MCP_OAUTH_REDIRECT_URIS` | no | Anthropic's known callbacks | Comma-separated allow-list of redirect URIs. Default covers `claude.ai/api/mcp/auth_callback`, `claude.ai/api/oauth/callback`, `claude.ai/oauth/callback` |
| `MCP_OAUTH_INSECURE_AUTO_APPROVE` | yes for that mode | — | Set to `1`/`true` to enable auto-approve mode. Mutually exclusive with `MCP_OAUTH_CLIENT_ID` |
| `CAPSULE_MCP_READONLY` | no | unset | Set to `1` to belt-and-brace your read-scoped token (skips registering write tools at the MCP layer) |
| `PORT` | no | `8080` | Cloud Run sets this automatically |

Generate strong values with:

```bash
openssl rand -hex 32        # signing key, client_secret
uuidgen                     # client_id (any unique string is fine, UUID is convenient)
```

## Security model

Two distinct credentials handle two distinct trust relationships. Understanding the difference matters before you deploy.

```
┌─────────┐  OAuth flow → Bearer <signed access token>  ┌──────────┐
│ Claude  │ ──────────────────────────────────────────▶ │ Cloud Run│
│         │                                              │   /mcp   │
└─────────┘                                              └──────────┘
                                                              │
                            Authorization: Bearer <CAPSULE_API_TOKEN>
                                                              │
                                                              ▼
                                                        ┌──────────┐
                                                        │  Capsule │
                                                        │   API    │
                                                        └──────────┘
```

| Credential | Travels between | Lives in | What it proves |
|---|---|---|---|
| OAuth access token (HMAC-signed by `MCP_OAUTH_SIGNING_KEY`) | Claude → your Cloud Run | Issued by `/token`, sent in `Authorization: Bearer …` on every `/mcp` request | "I completed the OAuth dance with this server and the signing key still says I'm valid" |
| `MCP_OAUTH_SIGNING_KEY` | server-only | Cloud Run env var (typically backed by Secret Manager) | The HMAC key. Never sent over the network. Rotating it invalidates every outstanding access + refresh token |
| `CAPSULE_API_TOKEN` | your Cloud Run → Capsule API | Cloud Run env var only — never seen by Claude or end users | "I'm a registered Capsule user with these scopes" |

### Why this design

Anthropic's Custom Connector machinery requires the MCP HTTP server to speak OAuth 2.1 + Dynamic Client Registration. Behind the OAuth surface, this server runs in one of two modes (see Auth modes above). In `static-client` mode the configured `client_secret` is the real auth boundary; in `insecure-auto-approve` it isn't.

Even in `static-client` mode, all valid callers grant the same effective access — there's no per-user identity. Calls to Capsule use the single shared `CAPSULE_API_TOKEN`. Per-user identity in Capsule would require federating `/authorize` to Capsule's own OAuth, which is significantly more code and only worth it if you need per-user audit in Capsule.

### What end users (and Claude) never see

The Capsule API token is set as a Cloud Run env var, read by the server at startup, and used to authenticate the server's own outbound calls to `api.capsulecrm.com`. It is never sent in any response to Claude. It is never visible in any tool result. The LLM cannot exfiltrate it.

### The layers and what they protect

| Layer | Type | Protects against | Doesn't protect against |
|---|---|---|---|
| The URL itself | Obscurity | Random scans, casual snooping | Targeted lookups via Certificate Transparency logs (every Cloud Run cert is in CT logs, searchable on `crt.sh`) |
| `MCP_OAUTH_CLIENT_SECRET` (static-client mode only) | Real authentication | Anyone without the client_secret | Anyone *with* the client_secret |
| OAuth handshake + access token | Token integrity | Forged tokens, replay against a rotated key | Tokens stolen from in-flight HTTPS / a compromised Anthropic side |
| `CAPSULE_API_TOKEN` scope | Authorisation / blast radius | Limits what tokens at any of the above layers can ultimately do | Reading data the Capsule token's user already has access to |

**Treat the URL as public.** Cloud Run URLs are not secrets — they're indexed in CT logs. In `static-client` mode your security boundary is the `client_secret` + the Capsule token's scope; in `insecure-auto-approve` mode it's only the Capsule token's scope.

### Threat-model summary

In `static-client` mode: anyone who obtains both the URL AND `MCP_OAUTH_CLIENT_SECRET` can read whatever the deployed Capsule token can read. The `client_secret` is the gate.

In `insecure-auto-approve` mode: anyone who can reach the URL can read whatever the deployed Capsule token can read. There is no real auth gate — only the Capsule token's read scope bounds the damage.

For an internal read-only org connector deployed publicly, **use `static-client` mode plus a read-scoped Capsule token** and you have a sensible balance: simple to operate, real auth boundary, blast radius capped by the read scope.

### Optional hardening

| Defence | Effort | What it adds |
|---|---|---|
| Cloud Armor IP allowlist for Anthropic's egress IPs | Medium | Only Anthropic can reach `/mcp` and the OAuth endpoints |
| Rotate `MCP_OAUTH_SIGNING_KEY` on a schedule | Low | Invalidates outstanding tokens; Anthropic re-runs the OAuth dance silently |
| Cloud Run logs → alerting on anomalous patterns | Low | Visibility into misuse |
| Rate limiting (Cloud Armor or app-level) | Medium | Caps damage if a token is leaked or the URL is being probed |
| Per-user OAuth against Capsule's OAuth (real per-user identity) | High | Per-user audit in Capsule, individual revocation. Significant build |

## Deploying to Google Cloud Run

Two paths. **Path A** is simpler; **Path B** gives you a locally-buildable, pinnable image.

### Path A — build remotely from source (simplest)

Cloud Run builds the container with Cloud Build using the bundled `Dockerfile`. No local container runtime needed.

```bash
PROJECT=<your-gcp-project>
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
REGION=europe-west1
SERVICE=capsulemcp
SIGNING_KEY=$(openssl rand -hex 32)
CLIENT_ID=$(uuidgen)
CLIENT_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app

echo "Save these for the Anthropic Custom Connector form:"
echo "  CLIENT_ID=$CLIENT_ID"
echo "  CLIENT_SECRET=$CLIENT_SECRET"

gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --source=. \
  --allow-unauthenticated \
  --set-env-vars=CAPSULE_MCP_READONLY=1,MCP_OAUTH_SIGNING_KEY=$SIGNING_KEY,PUBLIC_BASE_URL=$PUBLIC_URL \
  --set-env-vars=MCP_OAUTH_CLIENT_ID=$CLIENT_ID,MCP_OAUTH_CLIENT_SECRET=$CLIENT_SECRET \
  --set-env-vars=^|^CAPSULE_API_TOKEN=<your read-scoped capsule token>
```

`--allow-unauthenticated` makes the service reachable from Claude's servers; auth is enforced at the application layer via OAuth (static-client mode). Cloud Run prints the service URL after a minute or two — it should match the `PUBLIC_BASE_URL` you computed (`https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`).

### Path B — build locally, push to Artifact Registry

Useful when you want to test the exact image before deploying, or when you want reproducible builds tagged by version. Examples use Podman; Docker commands are identical.

```bash
PROJECT=<your-gcp-project>
REGION=europe-west1
SERVICE=capsulemcp
REPO=$REGION-docker.pkg.dev/$PROJECT/$SERVICE
TAG=v0.1.0

# 1. one-time: create an Artifact Registry repo
gcloud artifacts repositories create $SERVICE \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT

# 2. one-time: configure auth so podman/docker can push
gcloud auth configure-docker $REGION-docker.pkg.dev

# 3. build, tag, push
# IMPORTANT: --platform linux/amd64 if you're on Apple Silicon (M1/M2/M3) or any
# ARM dev machine. Cloud Run runs amd64; without this flag your container won't
# start on Cloud Run and the deploy fails with a "container failed to start
# and listen on the port" error.
podman build --platform linux/amd64 -t $REPO/$SERVICE:$TAG .
podman push $REPO/$SERVICE:$TAG

# 4. deploy that exact image
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SIGNING_KEY=$(openssl rand -hex 32)
CLIENT_ID=$(uuidgen)
CLIENT_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app
echo "  CLIENT_ID=$CLIENT_ID  CLIENT_SECRET=$CLIENT_SECRET   ← paste into Anthropic"
gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --image=$REPO/$SERVICE:$TAG \
  --allow-unauthenticated \
  --set-env-vars=CAPSULE_MCP_READONLY=1,MCP_OAUTH_SIGNING_KEY=$SIGNING_KEY,PUBLIC_BASE_URL=$PUBLIC_URL \
  --set-env-vars=MCP_OAUTH_CLIENT_ID=$CLIENT_ID,MCP_OAUTH_CLIENT_SECRET=$CLIENT_SECRET \
  --set-env-vars=^|^CAPSULE_API_TOKEN=<your read-scoped capsule token>
```

To roll out a new version: rebuild with a new `TAG`, push, then `gcloud run deploy ... --image=...:NEW_TAG`. To roll back: `gcloud run services update-traffic $SERVICE --to-revisions=PREV=100`.

## Deploying elsewhere

Any container host works as long as:

1. It builds (or accepts) the bundled `Dockerfile`
2. It exposes the container's `$PORT` over HTTPS publicly
3. You can set environment variables on the running container

A non-exhaustive list of equivalents:

- **Cloudflare Workers** — needs the container-runtime feature; otherwise build a small Worker shim that proxies to a backing service
- **Render** — connect this repo, pick the Dockerfile, set env vars in the dashboard
- **Fly.io** — `fly launch`, set secrets with `fly secrets set ...`
- **AWS App Runner** — supports building from a public Docker image or directly from source via CodeCommit/GitHub
- **A VPS** — `podman run` (or systemd unit) behind nginx/Caddy doing TLS termination

The application doesn't depend on anything Cloud Run-specific. Cloud Run is just where the example commands go.

## Sanity check after deploy

The canonical service URL format is `https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`. The legacy `${SERVICE}-${HASH}-${REGION_SHORT}.a.run.app` format that `gcloud run services describe` sometimes shows may not route on newer services — prefer the project-number format.

The `/mcp` endpoint is gated by OAuth, so a direct `curl` smoke test requires walking the OAuth dance. The simplest checks:

```bash
URL=https://<your-service-url>

# 1. Discovery — should return JSON metadata (no auth)
curl -s "$URL/.well-known/oauth-authorization-server" | python3 -m json.tool | head -10
curl -s "$URL/.well-known/oauth-protected-resource" | python3 -m json.tool | head -10

# 2. /mcp without a token — should be HTTP 401 with WWW-Authenticate header
curl -i -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{}' | head -5
# → HTTP/2 401
#   www-authenticate: Bearer error="invalid_token", ...
```

If both pass, the OAuth surfaces are correctly exposed and the connector machinery in Claude will be able to register a client and obtain a token. The full `/mcp` round-trip is best done by registering the connector in Claude and issuing a test prompt — see "Register as a Custom Connector" below.

## Register as a Custom Connector in Claude

Anthropic's Custom Connector form (as of this writing) asks for three values: **MCP Server URL**, **Client ID**, **Client Secret**. In `static-client` mode you provide them directly:

| Field | Value |
|---|---|
| MCP Server URL | `https://<your-service-url>/mcp` |
| Client ID | `MCP_OAUTH_CLIENT_ID` you set during deploy |
| Client Secret | `MCP_OAUTH_CLIENT_SECRET` you set during deploy |

Save. Anthropic walks the OAuth dance using those credentials. No DCR involved.

In `insecure-auto-approve` mode the Anthropic UI still wants Client ID + Client Secret, so you do a one-off DCR call against your deployed server to mint a pair:

```sh
URL=https://<your-service-url>
curl -s -X POST "$URL/register" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Anthropic Claude Custom Connector",
    "redirect_uris": [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/oauth/callback",
      "https://claude.ai/oauth/callback"
    ],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"]
  }' | python3 -m json.tool
```

The response contains `client_id` and `client_secret` to paste into Anthropic's form. Note: in auto-approve mode anyone can do this — that's the whole point of the warning.

Anthropic's UI evolves; if a field looks different, check Anthropic's current connector docs.

## Wire up a shared Project

1. Create a Claude Project at the org level (admin)
2. Add Project instructions describing your Capsule structure — naming conventions, custom fields, tagging system, pipelines, anything that helps Claude reason about your data
3. Attach the Capsule connector to the Project
4. Share the Project with the org

Anyone in the org now opens that Project, starts a chat, and the Capsule tools + your instructions are there automatically.

## Operations

### Rotation

```bash
# Rotate the OAuth signing key. This invalidates every outstanding access
# and refresh token; Anthropic's connector silently re-runs the OAuth
# dance on the next request and gets a fresh token. No user action
# required.
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=MCP_OAUTH_SIGNING_KEY=$(openssl rand -hex 32)

# Rotate the Capsule token
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=^|^CAPSULE_API_TOKEN=<new token>
```

### Cold starts and scaling

Default `--min-instances=0` means cold starts of a few seconds on the first request after idle. For a snappier experience set `--min-instances=1` (you'll pay for one always-on instance — a few dollars per month at this size).

The server is stateless, so `--max-instances` can be set as high as you like. For an internal connector the default of 100 is overkill but harmless.

### Logs

```bash
gcloud run services logs read $SERVICE --region=$REGION --limit=50
```

Or in the Cloud Console under Cloud Run → service → Logs.

### Cost

For a few dozen internal users, expect this to fall within Cloud Run's free tier (2M requests/month, 360k vCPU-seconds/month) most months. Add a Cloud Build budget alert if you're nervous.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Deploy fails with `PERMISSION_DENIED: Build failed because the default service account...` | Grant `roles/cloudbuild.builds.builder` to the default Compute SA — see Prerequisites |
| URL returns Google HTML 404 / "Your client does not have permission" | `iam.allowedPolicyMemberDomains` constraint is blocking `allUsers`. Override at project level — see Prerequisites |
| `gcloud run deploy --image` succeeds but Cloud Run reports "container failed to start and listen on the port" | Image was built for the wrong architecture. Rebuild with `--platform linux/amd64` |
| URL from `gcloud run services describe` returns 404 but the deploy command's "Service URL" works | Use the canonical `https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app` format |
| `/.well-known/oauth-*` returns 404 | Server didn't start, or `PUBLIC_BASE_URL` env var isn't set. Check logs |
| Connector adds OK in Anthropic but `tools/list` is empty | Anthropic's OAuth client failed to obtain a token. Check Cloud Run logs around `/authorize` and `/token` requests |
| `/mcp` returns 500 with "401 Unauthorized" in logs | The deployed `CAPSULE_API_TOKEN` is invalid or expired |
| `tools/list` returns no `create_*`/`update_*` tools | Working as intended — `CAPSULE_MCP_READONLY=1` is set, or your Capsule token has Read scope |
| Tool calls return empty results | Verify the Capsule token's user has access to that data; tokens inherit the user's record-level visibility |
| Cold-start latency on first request after idle | Set `--min-instances=1` |

If you hit something not on this list, paste the request, response, and a Cloud Run log snippet — happy to dig in.
