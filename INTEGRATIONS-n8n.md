# Integrating capsulemcp with n8n

Wire n8n to a deployed capsulemcp HTTP+OAuth instance so workflows
can call Capsule CRM tools such as `list_users`, `filter_parties`, and
`get_party`.

## Current compatibility

capsulemcp exposes MCP over **Streamable HTTP** at `/mcp`. It does not
serve a legacy `/sse` endpoint.

n8n currently has two MCP client surfaces:

- **MCP Client node**: a regular workflow node. n8n documents a
  configurable server transport, endpoint URL, and OAuth2
  authentication. Use this path with capsulemcp.
- **MCP Client Tool node**: a sub-node for AI Agent tool use. As of
  2026-05-25, n8n's public docs list only an **SSE Endpoint** for this
  node. It will not connect directly to capsulemcp unless your n8n
  build has gained Streamable HTTP support for that sub-node, or you
  put an SSE-to-Streamable-HTTP bridge in front of capsulemcp.

This guide covers the supported regular workflow-node path. For AI
Agent workflows, run capsulemcp calls as explicit MCP Client workflow
steps, or revisit this guide once n8n's MCP Client Tool node documents
Streamable HTTP support.

Reference:

- n8n MCP Client node: <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcpClient/>
- n8n MCP Client Tool node: <https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/>

## Prerequisites

- A deployed capsulemcp HTTP+OAuth instance. See [DEPLOY.md](DEPLOY.md).
- The deployment's `MCP_OAUTH_CLIENT_ID` and
  `MCP_OAUTH_CLIENT_SECRET`.
- An n8n instance with the MCP Client node available.

## Step 1 - Find your n8n OAuth callback URL

n8n's OAuth credential form displays the callback URL it will send.
Use that exact URL in capsulemcp's allowlist.

Common defaults:

| Deployment | Callback URL |
|---|---|
| n8n Cloud | `https://oauth.n8n.cloud/oauth2/callback` |
| Self-hosted HTTPS | `https://<your-n8n-host>/rest/oauth2-credential/callback` |
| Self-hosted localhost/dev | `http://localhost:5678/rest/oauth2-credential/callback` |

Production capsulemcp deployments require HTTPS redirect URIs. Plain
`http://` is only appropriate for localhost development.

## Step 2 - Add the n8n callback URL to capsulemcp

capsulemcp uses an exact-match redirect URI allowlist on `/authorize`
and `/token`. Add the n8n callback URL to
`MCP_OAUTH_REDIRECT_URIS`, comma-separated with any existing entries.

### Cloud Run example

Read the current env var first so you append instead of overwriting:

```sh
gcloud run services describe <your-service> \
  --region=<your-region> \
  --format='value(spec.template.spec.containers[0].env)'
```

Then update with the full comma-separated list:

```sh
gcloud run services update <your-service> \
  --region=<your-region> \
  --update-env-vars="MCP_OAUTH_REDIRECT_URIS=EXISTING_LIST,https://<your-n8n-host>/rest/oauth2-credential/callback"
```

Cloud Run rolls a new revision automatically. Confirm the env var on
the new revision before testing OAuth.

### IaC-managed deployments

Edit the redirect URI list in your IaC source and re-apply. If the
callback hostname is sensitive, store it as an encrypted IaC secret
and assemble `MCP_OAUTH_REDIRECT_URIS` from that secret at deploy time.

## Step 3 - Create the OAuth2 credential in n8n

Create a generic OAuth2 credential or the credential type n8n offers
for the MCP Client node.

| Field | Value |
|---|---|
| Grant Type | Authorization Code with PKCE |
| Authorization URL | `https://<your-mcp-host>/authorize` |
| Access Token URL | `https://<your-mcp-host>/token` |
| Client ID | `MCP_OAUTH_CLIENT_ID` |
| Client Secret | `MCP_OAUTH_CLIENT_SECRET` |
| Scope | leave empty |
| Auth URI Query Parameters | `resource=https://<your-mcp-host>/mcp` |
| Authentication | Body |

Two settings matter:

- **Authentication must be Body.** n8n often defaults generic OAuth2
  credentials to HTTP Basic auth. capsulemcp's `/token` endpoint reads
  form-body credentials (`client_secret_post`), so Basic auth produces
  `invalid_client`.
- **`resource` must point at `/mcp`.** capsulemcp enforces RFC 8707
  resource indicators on both OAuth legs.

Click connect. n8n should open capsulemcp's `/authorize`, receive a
code at the callback URL, exchange it at `/token`, and store the token.

## Step 4 - Use the MCP Client node

Add an **MCP Client** node to the workflow and configure it with:

| Field | Value |
|---|---|
| Server Transport | Streamable HTTP, or the equivalent HTTP transport label in your n8n build |
| MCP Endpoint URL | `https://<your-mcp-host>/mcp` |
| Authentication | OAuth2 |
| Credential | the credential from Step 3 |
| Tool | select the capsulemcp tool to call |
| Input Mode | JSON for nested tool arguments; Manual is fine for simple calls |

Test with a read-only call first:

```json
{
  "name": "list_users",
  "arguments": {}
}
```

For data-changing workflows, keep the capsulemcp deployment in
`CAPSULE_MCP_READONLY=1` until the n8n workflow is reviewed. Pair that
with a read-scoped Capsule token for defense in depth.

## AI Agent workflows

The n8n AI Agent needs tool sub-nodes. n8n's documented MCP Client
Tool sub-node currently asks for an `SSE Endpoint`, while capsulemcp
only provides Streamable HTTP at `/mcp`.

Until n8n documents Streamable HTTP support for that tool sub-node,
use one of these patterns:

- Call capsulemcp from explicit MCP Client nodes before/after the AI
  Agent and pass the results through the workflow.
- Use selected capsulemcp outputs as structured context for the AI
  Agent rather than exposing the entire MCP catalog as dynamic tools.
- Put a maintained MCP transport bridge in front of capsulemcp only if
  your deployment policy accepts the extra moving part.

Do not point the MCP Client Tool node at `https://<your-mcp-host>/mcp`
if it is asking for an SSE endpoint; that configuration is expected to
fail.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_client / "client credentials required"` at `/token` | n8n sent credentials via Basic auth | Set OAuth credential authentication to Body |
| `redirect_uri mismatch` at callback step | n8n callback not in `MCP_OAUTH_REDIRECT_URIS` | Add the exact callback URL and redeploy |
| `invalid_request / missing code_challenge` at `/authorize` | wrong grant type | Use Authorization Code with PKCE |
| `invalid_request / "invalid resource"` at `/token` | missing or mismatched `resource=` | Set `resource=https://<your-mcp-host>/mcp` |
| Regular MCP Client node cannot list tools | wrong transport or endpoint | Use Streamable HTTP and the `/mcp` URL |
| AI Agent MCP Client Tool asks for `SSE Endpoint` | documented n8n sub-node transport mismatch | Use the regular MCP Client node path or a bridge |
| Tools list omits writes | `CAPSULE_MCP_READONLY=1` is enabled | working as intended; disable only for reviewed write workflows |

## Security notes

Every n8n caller that completes OAuth against one capsulemcp
deployment uses the same configured `CAPSULE_API_TOKEN` against
Capsule. capsulemcp does not multiplex per-n8n-user Capsule
identities. For separate trust domains, run separate capsulemcp
deployments with separate Capsule tokens.

For unattended n8n automation, prefer:

- `CAPSULE_MCP_READONLY=1`
- a read-scoped Capsule token
- a narrow n8n workflow that calls specific tools with reviewed inputs
- separate deployments for write-capable automation
