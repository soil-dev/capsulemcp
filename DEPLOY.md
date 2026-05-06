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

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CAPSULE_API_TOKEN` | yes | — | Use a read-scoped token for org deployments |
| `MCP_SHARED_SECRET` | strongly recommended | (none) | Bearer token gating inbound `/mcp` requests. Without it, anyone who finds the URL can use your Capsule token |
| `CAPSULE_MCP_READONLY` | no | unset | Set to `1` to belt-and-brace your read-scoped token (skips registering write tools at the MCP layer) |
| `PORT` | no | `8080` | Cloud Run sets this automatically |

Generate a strong shared secret with:

```bash
openssl rand -hex 32
```

## Deploying to Google Cloud Run

Two paths. **Path A** is simpler; **Path B** gives you a locally-buildable, pinnable image.

### Path A — build remotely from source (simplest)

Cloud Run builds the container with Cloud Build using the bundled `Dockerfile`. No local container runtime needed.

```bash
PROJECT=<your-gcp-project>
REGION=europe-west1
SERVICE=capsulemcp
SHARED_SECRET=$(openssl rand -hex 32)
echo "save this: SHARED_SECRET=$SHARED_SECRET"

gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --source=. \
  --allow-unauthenticated \
  --set-env-vars=CAPSULE_MCP_READONLY=1,MCP_SHARED_SECRET=$SHARED_SECRET \
  --set-env-vars=^|^CAPSULE_API_TOKEN=<your read-scoped capsule token>
```

`--allow-unauthenticated` makes the service reachable from Claude's servers; auth is enforced at the application layer via `MCP_SHARED_SECRET`. Cloud Run prints the service URL after a minute or two — something like `https://capsulemcp-abc123-ew.a.run.app`.

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
podman build -t $REPO/$SERVICE:$TAG .
podman push $REPO/$SERVICE:$TAG

# 4. deploy that exact image
SHARED_SECRET=$(openssl rand -hex 32)
gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --image=$REPO/$SERVICE:$TAG \
  --allow-unauthenticated \
  --set-env-vars=CAPSULE_MCP_READONLY=1,MCP_SHARED_SECRET=$SHARED_SECRET \
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

```bash
URL=https://<your-service-url>

# Health (no auth required)
curl $URL/healthz
# → {"ok":true,"readOnly":true}

# MCP initialize handshake (auth required)
curl $URL/mcp \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}},"id":1}'
# → event: message
#   data: {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{...}}, ...}}

# Real tool call
curl $URL/mcp \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_users","arguments":{}},"id":2}'
```

If the third call returns Capsule data, the deployment is good.

## Register as a Custom Connector in Claude

1. In Claude.ai, open **Settings → Connectors → Custom Connectors** (admin only)
2. Click **Add custom connector**
3. **Name**: `Capsule CRM` (or whatever fits your org)
4. **Description**: short summary that helps members understand what it does
5. **Server URL**: `https://<your-service-url>/mcp`
6. **Authentication**: Bearer token, value = your `MCP_SHARED_SECRET`
7. Save

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
# Rotate the shared secret — also update it in the Custom Connector config in Claude
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=MCP_SHARED_SECRET=$(openssl rand -hex 32)

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
| `/healthz` works but `/mcp` returns 401 | `MCP_SHARED_SECRET` mismatch between the deployment env var and the Custom Connector config |
| `/mcp` returns 500 with "401 Unauthorized" in logs | The deployed `CAPSULE_API_TOKEN` is invalid or expired |
| `tools/list` returns no `create_*`/`update_*` tools | Working as intended — `CAPSULE_MCP_READONLY=1` is set, or your Capsule token has Read scope |
| Tool calls return empty results | Verify the Capsule token's user has access to that data; tokens inherit the user's record-level visibility |
| Cold-start latency on first request after idle | Set `--min-instances=1` |

If you hit something not on this list, paste the request, response, and a Cloud Run log snippet — happy to dig in.
