# Integrating capsulemcp with n8n

Wire up an n8n **AI Agent** workflow to your deployed capsulemcp
instance so the agent can read (and, if you don't run read-only,
write) Capsule CRM data as part of automated workflows. The agent
sees the same tool catalogue Claude Desktop sees — `list_users`,
`filter_parties`, `get_party`, the works.

Placeholders used below — replace with your real values:

- `<your-mcp-host>` — your capsulemcp deployment (e.g.
  `capsule-mcp.example.com` or a Cloud Run URL like
  `service-1234.region.run.app`)
- `<your-n8n-host>` — your n8n instance (e.g. `n8n.example.com`)
- `<your-service>` / `<your-region>` — your Cloud Run service name
  and region, if that's how capsulemcp is deployed

> **Scope.** This guide covers connecting **n8n's MCP Client Tool
> node** to a capsulemcp HTTP+OAuth deployment. Local stdio
> installs don't apply — n8n needs an HTTP endpoint with OAuth. If
> you don't have a deployment yet, see [DEPLOY.md](DEPLOY.md).

## Prerequisites

- A deployed capsulemcp HTTP+OAuth instance ([DEPLOY.md](DEPLOY.md)).
  You'll need the deployment's `MCP_OAUTH_CLIENT_ID` and
  `MCP_OAUTH_CLIENT_SECRET` values.
- An n8n instance — n8n Cloud or self-hosted. Recent versions ship
  the MCP Client Tool node; older versions don't.

## Step 1 — Find your n8n callback URL

n8n's OAuth flow uses a fixed callback URL pattern per instance.
You'll add this URL to capsulemcp's allowlist in Step 2.

| Deployment | Callback URL |
|---|---|
| n8n Cloud (n8n.io) | `https://oauth.n8n.cloud/oauth2/callback` |
| Self-hosted (HTTPS) | `https://<your-n8n-host>/rest/oauth2-credential/callback` |
| Self-hosted (localhost / dev) | `http://localhost:5678/rest/oauth2-credential/callback` |

If you're unsure, n8n's credential form displays the exact URL it
will send: **Credentials → New → Generic OAuth2 API** — the form
shows the redirect URL once you pick a grant type.

> **HTTPS vs HTTP.** capsulemcp's OAuth provider validates redirect
> URIs at startup. Plain `http://` callbacks are accepted only when
> the deployment runs with `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`
> against a loopback origin (i.e. localhost dev only). Production
> deployments require HTTPS callbacks.

## Step 2 — Add the n8n callback URL to capsulemcp's allowlist

capsulemcp uses an exact-match redirect URI allowlist on
`/authorize` and `/token`. Without your n8n callback on the list,
the OAuth flow dies at the redirect step with `redirect_uri
mismatch`.

The allowlist is the `MCP_OAUTH_REDIRECT_URIS` env var on the
deployment — comma-separated. capsulemcp's default list covers
Anthropic Custom Connector callbacks; you append your n8n entry.

### Cloud Run (or any platform with an "update env var" command)

```sh
# Read the existing value so you can append rather than overwrite
gcloud run services describe <your-service> --region=<your-region> \
  --format='value(spec.template.spec.containers[0].env)' \
  | tr ';' '\n' | grep MCP_OAUTH_REDIRECT_URIS

# Update — comma-separate the full new list. Replace EXISTING_LIST
# with what the previous command returned (the three Anthropic URLs
# by default).
gcloud run services update <your-service> \
  --region=<your-region> \
  --update-env-vars="MCP_OAUTH_REDIRECT_URIS=EXISTING_LIST,https://<your-n8n-host>/rest/oauth2-credential/callback"
```

Cloud Run rolls a new revision automatically. Confirm with
`gcloud run services describe …` that the new URL is on the list.

### Pulumi / Terraform / IaC-managed deployments

Edit the redirect URI list in your IaC source and re-apply. If the
callback URL contains sensitive hostnames (e.g. an internal
`*.int.example.com` domain you don't want in your IaC repo's git
history), store it as an **encrypted IaC secret** instead of a
literal value, and read it back into the env var assembly at apply
time. capsulemcp treats the env var as plaintext on the running
container — secret-store encryption is purely a "don't commit the
URL to the IaC repo" concern.

A worked Pulumi example (Python):

```python
# At module scope, before the Service definition
_anthropic_redirect_uris = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.ai/api/oauth/callback",
    "https://claude.ai/oauth/callback",
]
_extra_redirect_uris_secret = config.get_secret("extra_redirect_uris")
if _extra_redirect_uris_secret is None:
    redirect_uris_value = ",".join(_anthropic_redirect_uris)
else:
    redirect_uris_value = _extra_redirect_uris_secret.apply(
        lambda extra: ",".join(
            _anthropic_redirect_uris + ([extra] if extra else [])
        )
    )

# Then in the Service env spec:
gcp.cloudrunv2.ServiceTemplateContainerEnvArgs(
    name="MCP_OAUTH_REDIRECT_URIS",
    value=redirect_uris_value,
),
```

Set the secret with:

```sh
pulumi config set --stack <your-stack> --secret extra_redirect_uris \
  "https://<your-n8n-host>/rest/oauth2-credential/callback"
```

Multiple consumers (n8n + others): pass them as a single
comma-separated string in the secret.

## Step 3 — Create the OAuth2 credential in n8n

In n8n: **Credentials → New →** pick **"MCP Client Tool"** if the
dedicated credential type is offered, otherwise **"Generic OAuth2
API"**. Both work.

| Field | Value |
|---|---|
| **Grant Type** | Authorization Code with PKCE (or just "PKCE" — exact label depends on n8n version) |
| **Authorization URL** | `https://<your-mcp-host>/authorize` |
| **Access Token URL** | `https://<your-mcp-host>/token` |
| **Client ID** | the value of `MCP_OAUTH_CLIENT_ID` on the deployment |
| **Client Secret** | the value of `MCP_OAUTH_CLIENT_SECRET` on the deployment |
| **Scope** | *leave empty* |
| **Auth URI Query Parameters** | `resource=https://<your-mcp-host>/mcp` |
| **Authentication** | **Body** (NOT the default "Header" — see note below) |

> **Critical: switch "Authentication" to "Body".** n8n defaults to
> "Header", which sends client credentials as HTTP Basic auth
> (`Authorization: Basic <base64>`). capsulemcp's `/token` endpoint
> only reads form-body credentials (`client_secret_post` per RFC 6749
> §2.3.1). If you forget this toggle, you get
> `invalid_client / "client credentials required"` at the callback
> step. The "Authentication" field is sometimes hidden under "Show
> More Optional Settings" — expand if you don't see it.

> **The `resource` parameter is load-bearing.** capsulemcp enforces
> RFC 8707 resource indicators on both `/authorize` and `/token`.
> Without it, the auth flow returns `invalid_request`. Putting
> `resource=…` in "Auth URI Query Parameters" makes n8n send it on
> both legs of the OAuth round-trip.

Click **Connect**. n8n opens a browser tab to capsulemcp's
`/authorize`, capsulemcp auto-approves (single-tenant static-client
model), redirects back to your n8n callback URL with a code, n8n
exchanges the code at `/token`, and the credential turns green.

## Step 4 — Use the MCP server in an AI Agent workflow

Standard n8n AI Agent pattern:

1. Trigger node (Webhook / Manual / Schedule / Chat — whatever fits)
2. **AI Agent** node
3. **MCP Client Tool** node, connected to the AI Agent's **Tool** input
4. A Chat Model node (Anthropic, OpenAI, etc.), connected to the
   AI Agent's **Model** input

### MCP Client Tool node config

| Field | Value |
|---|---|
| **Endpoint** | `https://<your-mcp-host>/mcp` |
| **Transport** | **Streamable HTTP** (NOT legacy SSE — capsulemcp does not expose `/sse`) |
| **Authentication** | MCP OAuth2 (or the matching auth type) |
| **Credential** | the credential you created in Step 3 |
| **Tools to Expose** | "All" (49 in read-only mode, 86 with writes) — or "Selected" to narrow |

> If your n8n version only offers "SSE" transport and not
> "Streamable HTTP", you're on an older release. Update n8n —
> capsulemcp speaks Streamable HTTP only.

### Test it

Run the workflow with input like: *"List the users in our CRM"* —
the AI Agent should call `list_users` via the MCP Client Tool and
return the user list. The AI Agent node's execution log shows
which tools the agent invoked and the JSON-RPC round-trips.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_client / "client credentials required"` at `/token` | n8n sending creds via Basic header | Set "Authentication" to **Body** on the credential |
| `redirect_uri mismatch` at callback step | n8n callback not in `MCP_OAUTH_REDIRECT_URIS` | Add it (Step 2); confirm with `gcloud run services describe` |
| `invalid_request / missing code_challenge` at `/authorize` | n8n didn't use PKCE — wrong grant type | Change Grant Type to "Authorization Code with PKCE" |
| `invalid_request / "invalid resource"` at `/token` | `resource=` missing or doesn't match `/mcp` exactly | Re-check Auth URI Query Parameters; full URL with `/mcp` suffix |
| 401 on every `/mcp` call after a green credential | Access token expired (1-day TTL); silent refresh failed | Click **Reconnect** on the credential |
| Tools list shows 0 tools | Wrong endpoint URL, or `CAPSULE_MCP_READONLY` hiding tools you expected | Confirm endpoint URL; check the env on the deployment |
| AI Agent never calls any tool | "Tools to Expose" set to "None", or model can't see them | Set to "All" and rerun |

## Architecture notes

**Why MCP Client Tool, not HTTP Request Tool?** n8n has two HTTP
options for AI Agent tools. HTTP Request Tool node would force you
to construct each JSON-RPC call manually, parse SSE responses, and
the agent would see only ONE tool ("call MCP") rather than the 49
individual tools. MCP Client Tool node speaks JSON-RPC + SSE
natively, runs `tools/list` on connect, and exposes each tool to
the agent individually — much better routing accuracy and zero
boilerplate.

**Why not Dynamic Client Registration (DCR / RFC 7591)?** capsulemcp
uses static-client OAuth (one pre-shared `client_id`/`client_secret`
per deployment) rather than RFC 7591 DCR. n8n's MCP Client Tool
node supports both modes; static is simpler and avoids the
trust-model questions (open registration + shared Capsule API
token = anyone who can reach the URL could self-register and use
your token). Self-service DCR onboarding may land in a future
major version — see [IDEAS.md](IDEAS.md).

**Token TTL.** capsulemcp issues access tokens with a 1-day TTL and
refresh tokens with a 30-day TTL. n8n's OAuth client refreshes
silently in the background. After 30 days without use you'll need
to click **Reconnect** to re-authorize.

**Read-only mode.** If your deployment runs with
`CAPSULE_MCP_READONLY=1` (recommended for n8n agents you don't
fully trust to make destructive changes), only the 49 read tools
are advertised; write/delete tools are not registered at all. See
[DEPLOY.md](DEPLOY.md#read-only-mode) — pair the env flag with a
read-scoped Capsule API token for defence in depth.
