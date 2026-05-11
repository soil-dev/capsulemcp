# Deploying capsulemcp as a hosted service

This guide walks through deploying capsulemcp once and registering it as a Claude **Custom Connector**, so an entire organisation can use it from a shared Claude Project without per-user setup. It uses **Google Cloud Run** as the worked example because it has a generous free tier and zero-config TLS, but the design is portable to any container host that exposes HTTPS.

For per-user installs (Claude Desktop / Claude Code), see [INSTALL.md](INSTALL.md) instead.

## What you'll end up with

- A Cloud Run service speaking OAuth 2.1 in front of the MCP HTTP endpoint
- One OAuth client_id + client_secret pair, both held by your Anthropic admin and your Cloud Run config
- Anthropic's Custom Connector wired to the URL; users with access to the connector get the Capsule tools in any chat that uses it
- Read-only deployment by default (controllable via env)

## Prerequisites

- Claude **Teams** or **Enterprise** plan with admin access (Custom Connectors aren't on Free/Pro plans)
- A Capsule **read-scoped** Personal Access Token (My Preferences → API Authentication Tokens → Read scope)
- A GCP project with billing enabled and `gcloud` installed locally

If your GCP project is under a Google Workspace organisation (the common case), there are two one-time setup steps that GWS-default policies otherwise silently break. Skim "GCP Workspace prerequisites" below before deploying.

## OAuth modes (pick one)

The HTTP entry runs in one of two modes, selected by env-var presence at startup:

| Mode | When to use | Trigger |
|---|---|---|
| **`static-client`** *(recommended for production)* | Public deployment behind HTTPS — exactly the Custom Connector case | Set `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET` |
| **`insecure-auto-approve`** | Local dev, private network, ngrok-style demos | Set `MCP_OAUTH_INSECURE_AUTO_APPROVE=1` |

In `static-client` mode the configured `client_secret` is the actual auth boundary: anyone who reaches the URL but doesn't have the secret cannot complete the OAuth flow. Dynamic Client Registration (`/register`) is disabled.

In `insecure-auto-approve` mode anyone who reaches the URL can complete the OAuth flow and call tools. This is fine on `localhost` or behind a VPN; it is **not** safe on the public internet because Cloud Run URLs are indexed in Certificate Transparency logs.

The runtime enforces this: if `MCP_OAUTH_INSECURE_AUTO_APPROVE=1` is set but `PUBLIC_BASE_URL` does not point at loopback (`localhost`, `127.0.0.1`, `::1`), the server **refuses to start** unless the operator also sets `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes`. The acknowledgement env var is intentionally awkward to type — it is meant for cases like deploying behind a Tailscale-only ingress where the public-DNS check would mislead.

If neither mode is configured, the server **refuses to start**. There's no path to deploy this in an unsafe configuration without explicitly typing `INSECURE_AUTO_APPROVE`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CAPSULE_API_TOKEN` | yes | Capsule PAT used for outbound API calls; read-scoped recommended |
| `PUBLIC_BASE_URL` | yes | Public origin where the server is reachable, e.g. `https://capsulemcp-...run.app`. Used to build OAuth metadata URLs |
| `MCP_OAUTH_SIGNING_KEY` | yes | HMAC key for OAuth tokens. ≥ 16 chars, stable across instances |
| `MCP_OAUTH_CLIENT_ID` | yes for static-client mode | The one allowed OAuth client_id. Pasted into Anthropic's connector config |
| `MCP_OAUTH_CLIENT_SECRET` | yes for static-client mode | Matching client_secret; ≥ 16 chars. The real auth gate |
| `MCP_OAUTH_REDIRECT_URIS` | optional | Comma-separated allow-list. Defaults to Anthropic's known callbacks (`https://claude.ai/api/mcp/auth_callback`, `https://claude.ai/api/oauth/callback`, `https://claude.ai/oauth/callback`) |
| `MCP_ALLOWED_ORIGINS` | optional | Comma-separated browser origins allowed to send Origin-bearing `/mcp` requests. Defaults include `PUBLIC_BASE_URL`'s origin and `https://claude.ai` |
| `MCP_OAUTH_INSECURE_AUTO_APPROVE` | yes for that mode | Set to `1` to enable auto-approve. Mutually exclusive with the static-client vars. Refused at startup unless `PUBLIC_BASE_URL` is loopback or `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes` |
| `MCP_OAUTH_I_KNOW_WHAT_IM_DOING` | only with insecure-auto-approve on a non-loopback host | Set to `yes` to acknowledge that you've put the deployment behind a private-network ingress (e.g. Tailscale, VPN). Required because the auto-approve mode lets anyone who reaches the URL register a client and use the shared Capsule token |
| `CAPSULE_MCP_READONLY` | optional | Set to `1` to skip registering all write/delete tools at the MCP layer |
| `CAPSULE_API_BASE_URL` | optional | Override the Capsule API base URL (default `https://api.capsulecrm.com/api/v2`). Useful for testing |
| `MCP_HTTP_JSON_LIMIT` | optional | Inbound JSON body limit for `/mcp` (default `35mb`). Leaves headroom for the base64 expansion of a 25 MB attachment binary; bump if you raise the attachment cap |
| `MCP_HTTP_RATE_LIMIT_MAX` | optional | Max `/mcp` requests per client per window (default `600`). The connector tracks usage per authenticated client_id, so one runaway caller can't burn the shared Capsule quota |
| `MCP_HTTP_RATE_LIMIT_WINDOW_MS` | optional | Window in ms for the above (default `60000`) |
| `MCP_HTTP_RATE_LIMIT_DISABLED` | optional | Set to `1` to disable the `/mcp` rate limiter entirely. Test-only |
| `MCP_HTTP_DEBUG` | optional | Set to `1` to include full `err.message` in `/mcp` error logs (default: low-cardinality summary only, to avoid Capsule response bodies smearing across log aggregators) |
| `PORT` | optional | Listen port (Cloud Run injects automatically; default 8080) |

Generate strong values:

```bash
openssl rand -hex 32        # signing key, client_secret
uuidgen                     # client_id (any unique string is fine)
```

## GCP Workspace prerequisites (one-time)

If your GCP project is under a Google Workspace org:

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

**2. (Sometimes) Override `iam.allowedPolicyMemberDomains`.** This GWS-default constraint blocks `allUsers` IAM bindings, which can make the simple `gcloud run deploy --allow-unauthenticated` path below fail or leave the service inaccessible. If your org blocks `allUsers`, either get a project-level org-policy exception, or deploy with Cloud Run v2's `invoker_iam_disabled=True` setting (for example via Pulumi's `gcp.cloudrunv2.Service`) instead of relying on the `--allow-unauthenticated` shorthand. See the troubleshooting matrix at the bottom.

## Deploy: worked example with Cloud Run

This walks the simplest path: `gcloud run deploy --source=.` from a checkout of this repo. Cloud Build builds the container; Cloud Run runs it.

```bash
# 0. Prerequisites
PROJECT=<your-gcp-project>
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
REGION=europe-west1
SERVICE=capsulemcp

# 1. Generate credentials
SIGNING_KEY=$(openssl rand -hex 32)
CLIENT_ID=$(uuidgen)
CLIENT_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app

echo "=== save these for the Anthropic connector form ==="
echo "  CLIENT_ID=$CLIENT_ID"
echo "  CLIENT_SECRET=$CLIENT_SECRET"

# 2. Deploy. Note: a single --set-env-vars with the ^|^ delimiter syntax —
#    repeated --set-env-vars flags would overwrite each other (gcloud's
#    "set" semantics). Use --update-env-vars later for incremental adds.
git clone https://github.com/soil-dev/capsulemcp.git
cd capsulemcp
gcloud run deploy $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --source=. \
  --allow-unauthenticated \
  --set-env-vars="^|^CAPSULE_MCP_READONLY=1|PUBLIC_BASE_URL=$PUBLIC_URL|MCP_OAUTH_SIGNING_KEY=$SIGNING_KEY|MCP_OAUTH_CLIENT_ID=$CLIENT_ID|MCP_OAUTH_CLIENT_SECRET=$CLIENT_SECRET|CAPSULE_API_TOKEN=<your read-scoped capsule token>"
```

Cloud Run prints the service URL after a couple of minutes. It should match the `PUBLIC_URL` you computed.

> **Production tip**: don't pass secrets via `--set-env-vars` long-term — anyone with read access to the Cloud Run service config can see them. Move them to **Secret Manager** and reference them via `--set-secrets=CAPSULE_API_TOKEN=secret-name:latest`. The next section sketches that.

### Better: secrets in Secret Manager

```bash
echo -n "$CAPSULE_API_TOKEN" | gcloud secrets create capsulemcp-capsule-api-token --data-file=- --project=$PROJECT
echo -n "$CLIENT_SECRET"     | gcloud secrets create capsulemcp-client-secret      --data-file=- --project=$PROJECT
echo -n "$SIGNING_KEY"       | gcloud secrets create capsulemcp-signing-key        --data-file=- --project=$PROJECT

# Grant the Cloud Run service account access (use the project's default compute SA, or a dedicated one)
SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
for s in capsulemcp-capsule-api-token capsulemcp-client-secret capsulemcp-signing-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:$SA \
    --role=roles/secretmanager.secretAccessor \
    --project=$PROJECT
done

# Deploy referencing the secrets. As above, --set-secrets accepts a
# single comma-separated list (or use the ^|^ delimiter trick).
gcloud run deploy $SERVICE \
  --project=$PROJECT --region=$REGION --source=. \
  --allow-unauthenticated \
  --set-env-vars="^|^CAPSULE_MCP_READONLY=1|PUBLIC_BASE_URL=$PUBLIC_URL|MCP_OAUTH_CLIENT_ID=$CLIENT_ID" \
  --set-secrets="CAPSULE_API_TOKEN=capsulemcp-capsule-api-token:latest,MCP_OAUTH_CLIENT_SECRET=capsulemcp-client-secret:latest,MCP_OAUTH_SIGNING_KEY=capsulemcp-signing-key:latest"
```

The `client_id` is fine in the env-var form — it's not secret. The other three live in Secret Manager.

### Other container hosts

The bundled `Dockerfile` builds a self-contained image that listens on `$PORT`. Any host that can run that image and route HTTPS to it works:

- **Render**: connect this repo, pick the Dockerfile, set env vars in the dashboard
- **Fly.io**: `fly launch`, `fly secrets set CAPSULE_API_TOKEN=… MCP_OAUTH_CLIENT_SECRET=… MCP_OAUTH_SIGNING_KEY=…`
- **AWS App Runner**: build from a public Docker image or directly from this repo's source
- **Cloudflare Workers**: needs the container-runtime feature (in beta as of writing)
- **A VPS**: `podman run` (or systemd unit) behind nginx/Caddy doing TLS termination

The application doesn't depend on anything Cloud Run-specific.

## Sanity check after deploy

The `/mcp` endpoint is OAuth-gated, so a direct `curl` smoke test would require walking the dance. Two simple checks first:

```bash
URL=https://<your-service-url>

# 1. Discovery returns 200 with the OAuth metadata
curl -s "$URL/.well-known/oauth-authorization-server" | head
curl -s "$URL/.well-known/oauth-protected-resource/mcp" | head

# 2. /mcp without a token returns 401 with WWW-Authenticate header (proves the gate is in place)
curl -i -X POST "$URL/mcp" -H "Content-Type: application/json" -d '{}' | head -5
```

For the full OAuth dance + a real `tools/call` round-trip, see [HOWTO.md](HOWTO.md#smoke-test-a-deployed-instance).

## Register the Custom Connector in Claude

In Claude.ai admin → **Settings → Connectors → Custom Connectors → Add custom connector**:

| Field | Value |
|---|---|
| Name | `Capsule CRM` (or whatever fits your org) |
| Description | one line that helps people understand what's connected |
| MCP Server URL | `https://<your-service-url>/mcp` |
| Client ID | `MCP_OAUTH_CLIENT_ID` you set during deploy |
| Client Secret | `MCP_OAUTH_CLIENT_SECRET` you set during deploy |

Save. Anthropic walks the OAuth dance silently; on success the connector page shows the tools (49 if `CAPSULE_MCP_READONLY=1`, 81 if not).

## Wire up a shared Project

1. Create a Claude Project at the org level (admin)
2. Add Project Instructions describing your Capsule structure — naming conventions, custom fields, tagging system, pipelines, anything that helps Claude reason about your data
3. Attach the Capsule connector to the Project
4. Share the Project with the org

Anyone in the org now opens that Project, starts a chat, and the Capsule tools + your instructions are there automatically. **Make sure each chat / Project has the connector toggled on** — it's a per-chat setting; the most common "no tools available" report is forgetting this step.

## Security model

```
┌─────────┐  OAuth flow → Bearer <signed access token>  ┌──────────┐
│ Claude  │ ──────────────────────────────────────────▶ │ Cloud Run│
│         │                                             │   /mcp   │
└─────────┘                                             └──────────┘
                                                              │
                            Authorization: Bearer <CAPSULE_API_TOKEN>
                                                              │
                                                              ▼
                                                        ┌──────────┐
                                                        │  Capsule │
                                                        │   API    │
                                                        └──────────┘
```

Three secrets, three concerns:

| Credential | Travels between | What it proves |
|---|---|---|
| OAuth access token (HMAC-signed by `MCP_OAUTH_SIGNING_KEY`) | Claude → Cloud Run | "I completed the OAuth dance with this server" |
| `MCP_OAUTH_CLIENT_SECRET` | server-side gate at `/token` | "I'm the configured caller" — the real auth boundary |
| `CAPSULE_API_TOKEN` | Cloud Run → Capsule | "I'm a registered Capsule user with these scopes" |

- The `client_secret` is what stops a random caller from completing the OAuth flow. It lives in your Cloud Run env (or Secret Manager) and Anthropic's stored connector config; nowhere else.
- The `signing_key` is what stops anyone from forging an access token. Anyone who has it can mint tokens; treat it like a private key. **It is also the kill switch**: rotating `MCP_OAUTH_SIGNING_KEY` immediately invalidates every outstanding access and refresh token (the design is stateless HMAC, so there is no per-token revocation list — by intent, since Cloud Run instances must come and go without sharing state).
- OAuth tokens are bound to the canonical MCP resource URL (`PUBLIC_BASE_URL` + `/mcp`) via the MCP/RFC 8707 `resource` indicator. Requests with tokens minted for a different MCP resource are rejected.
- `/mcp` validates any browser `Origin` header against `PUBLIC_BASE_URL`, `https://claude.ai`, and optional `MCP_ALLOWED_ORIGINS` entries, matching the Streamable HTTP DNS-rebinding guidance.
- Issued tokens have **1-day access TTL** and **30-day refresh TTL**. Anthropic's connector renews silently in the background using the static client_id/secret; if a refresh token leaks, its useful life is bounded by the 30-day TTL **or** by the next signing-key rotation, whichever comes first.
- The `capsule_api_token` scope is the **blast radius cap**. If a token leaks somehow, the read-only scope means no writes happen.

### Trust model — read before deploying

Three things worth being explicit about, because they're not always obvious to operators:

1. **Shared Capsule identity.** Every MCP caller that completes the OAuth dance against this deployment uses the **same** `CAPSULE_API_TOKEN` against Capsule's API. Capsule sees one identity; per-MCP-caller authorization happens **only** at the OAuth gate (client_secret + access-token validation), not at the Capsule layer. If you want different team members to operate under different Capsule identities, run separate deployments with separate tokens — there is no per-user identity multiplexing here.
2. **Unsanitized data passthrough.** Custom field values, party notes, opportunity descriptions, and other free-text content flow Capsule → connector → MCP client without sanitization. The trust boundary is **Capsule's web UI** (where the data was entered). If a Capsule admin pastes raw HTML or markdown into a custom field, the MCP client receives it verbatim. This is intentional — sanitizing in the connector would corrupt structured content — but operators with adversarial-tenant scenarios should know.
3. **Leaked-token response.** There is no per-token revocation. The kill switch for any leaked access or refresh token is **rotating `MCP_OAUTH_SIGNING_KEY`**. All clients re-authorise on next call; the static `client_id`/`client_secret` stay unchanged.

### What you should treat as public

- Cloud Run URLs (`*.run.app`) are indexed in Certificate Transparency logs and discoverable via `crt.sh`. Don't rely on URL obscurity as security.
- The OAuth `client_id` is semi-public — Anthropic admins can see it; it's pasted into the connector form. Treat as known.

### What stops an attacker who knows the URL and the client_id

The `client_secret`. Without it, `/token` returns `invalid_client` no matter what.

### Optional hardening

| Defence | Effort | Adds |
|---|---|---|
| Cloud Armor IP allowlist for Anthropic's egress IPs | medium | Only Anthropic's network can reach `/mcp` |
| Rotate `client_secret` periodically | low | Bounds the exposure window of any leak |
| Cloud Run logs → alerting on anomalous patterns | low | Visibility into misuse |
| Per-user OAuth via Capsule's own OAuth | high | Real per-user identity in Capsule's audit log |

## Operations

### Rotation cadences

None of these auto-expire — the cadences are preventive hygiene, not availability requirements.

| Credential | Cadence | Anthropic-side action? |
|---|---|---|
| `MCP_OAUTH_SIGNING_KEY` | every 30–90 days | none — Anthropic re-runs OAuth silently with the unchanged client_id/secret |
| `MCP_OAUTH_CLIENT_SECRET` | every 90–180 days | yes — paste new value into Custom Connector |
| `CAPSULE_API_TOKEN` | every 6 months / when owner changes | none |

> **Signing-key rotation is the global kill switch.** Issued tokens are stateless HMAC blobs verified from the signing key alone, so there is no per-token revocation. If you suspect a single access or refresh token was compromised, rotate `MCP_OAUTH_SIGNING_KEY` — every outstanding token (including the legitimate user's) is invalidated immediately, and Anthropic transparently re-runs the OAuth dance to mint fresh ones. Outside of incident response, the bounded TTLs (1-day access, 30-day refresh) give you a natural maximum exposure window even without rotation.

### Rotation procedures

For Cloud Run with secrets stored as env vars:

```bash
# Signing key — silent rotation
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=MCP_OAUTH_SIGNING_KEY=$(openssl rand -hex 32)

# Client secret — also update in Anthropic's connector config
NEW=$(openssl rand -hex 32)
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=MCP_OAUTH_CLIENT_SECRET=$NEW
echo "paste this into Anthropic's connector: $NEW"

# Capsule API token
gcloud run services update $SERVICE \
  --region=$REGION \
  --update-env-vars=^|^CAPSULE_API_TOKEN=<new token>
```

If using Secret Manager, add new versions and update the service to point at `:latest` (or a specific version).

### Cold starts

Default `--min-instances=0` means cold-start latency of a few seconds on the first request after idle. For a snappier experience set `--min-instances=1` (one always-on instance, ~$5/month at this size).

### Logs

```bash
gcloud run services logs read $SERVICE --region=$REGION --limit=50
```

### Cost

For a few dozen internal users, expect to fall within Cloud Run's free tier (2M requests/month, 360k vCPU-seconds/month) most months.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails with `PERMISSION_DENIED: Build failed because the default service account...` | Cloud Build IAM grant missing | Run the Cloud Build IAM grant in "GCP Workspace prerequisites" |
| Service URL returns Google HTML 401 / 404 (not from your container) | `iam.allowedPolicyMemberDomains` blocking `allUsers` | Either get an org-policy admin to override at project level, or deploy via Pulumi using `invoker_iam_disabled=True` (modern Cloud Run v2 flag that bypasses this) |
| `/.well-known/oauth-*` returns 404 | Server didn't start, or `PUBLIC_BASE_URL` env var isn't set | Check Cloud Run logs |
| Server fails to start with "No OAuth mode configured" | Missing both static-client vars and the auto-approve flag | Set either `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET`, or `MCP_OAUTH_INSECURE_AUTO_APPROVE=1` |
| Connector saves but shows 0 tools | OAuth handshake failing | Look in Cloud Run logs around `/authorize` and `/token` for the actual error |
| Connector OK in admin but Claude says "no tools" in chat | Connector not toggled on for *this* chat / Project | Per-chat connector toggle in the composer's tools panel |
| Anthropic returns `invalid_client` mid-flow | `client_id` or `client_secret` mismatch between Anthropic's config and your env | Check what's deployed (`gcloud run services describe ...`) and what Anthropic has stored |
| `/mcp` returns 500 with "401 Unauthorized" in logs | The deployed `CAPSULE_API_TOKEN` is invalid or expired | Generate a new token in Capsule and rotate |
| `tools/list` returns no `create_*`/`update_*`/`delete_*` tools | Working as intended — `CAPSULE_MCP_READONLY=1` is set | n/a |
| Tool calls return empty results despite data existing in Capsule | Capsule PAT inherits the user's record-level visibility; that user might not see those records | Use a PAT from an account with the right Capsule access |
| Cold-start latency on first request after idle | Default scaling | Set `--min-instances=1` |

For tasks beyond deployment — adding a tool, contributing, debugging, smoke-testing the deployed instance — see [HOWTO.md](HOWTO.md).
