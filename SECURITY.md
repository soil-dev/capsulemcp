# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Two private channels:

- **GitHub private vulnerability reporting** (preferred): open a private
  advisory at
  <https://github.com/soil-dev/capsulemcp/security/advisories/new>. Only
  maintainers can see it until disclosure.
- **Email**: `anton@deadbeef.mx`.

When you report, please include:

- A short description of the issue and the impact you believe it has.
- The version (tag or commit SHA) you observed it on.
- Reproduction steps — minimal proof-of-concept code or a description
  of the request sequence is ideal.
- Whether you believe the report needs embargoed handling.

We'll acknowledge within **3 business days**, aim to confirm or rule
out within **14 days**, and coordinate disclosure with you before any
public fix lands. If you don't hear back in 3 business days, please
re-send — mail filters happen.

## Scope

In scope:

- The capsulemcp server itself — stdio entry (`dist/index.js`) and
  HTTP+OAuth entry (`dist/http.js`), including the unauthenticated
  `GET /health` page.
- The auth and rate-limit code paths in `src/auth/` and `src/http/`.
- The Capsule API client in `src/capsule/`.
- Tool registration and gating in `src/server/` (read-only mode, tiers,
  confirm-gated destructive tools) and the MCP Tasks store in
  `src/tasks/` (one client reading or cancelling another's task is a
  data-exposure bug).
- The release pipeline (`.github/workflows/publish.yml`): anything that
  could get unreviewed code published under the `capsulemcp` name.
- Anything that could exfiltrate a user's `CAPSULE_API_TOKEN`,
  bypass `CAPSULE_MCP_READONLY=1`, or sign tokens the server would
  accept.

Out of scope:

- Capsule CRM's own service — please report to Capsule directly via
  <https://capsulecrm.com>.
- Claude / the MCP protocol layer — please report to Anthropic /
  the MCP working group as appropriate.
- Vulnerabilities in transitive dependencies that don't have a
  reachable code path here. `npm audit --audit-level=high` runs on
  every PR; advisories on that path are already handled there.

## Versioning of fixes

Security fixes land on `master` and ship in the next release — a patch
release when nothing else is pending. Only the latest release line is
supported; there are no backports to older minor versions, so upgrading
is the supported path.

## Release integrity

Releases after v2.4.0 are published to npm only from this repository's
[`publish.yml`](.github/workflows/publish.yml) GitHub Actions workflow,
dispatched on the release tag, through npm Trusted Publishing with
staged publishing: the workflow can only stage a version, and it goes
public when a maintainer approves it with 2FA. Each carries an npm
provenance attestation whose identity is
`https://github.com/soil-dev/capsulemcp`, workflow
`.github/workflows/publish.yml`, ref `refs/tags/vX.Y.Z`.
[INSTALL.md → Release integrity](INSTALL.md#release-integrity) shows a
one-line check. A newer version whose attestation names anything else —
or that has none — was not built by this repository: do not install it,
and report it through one of the channels above. (That is a policy the
maintainers keep, not something npm can enforce on its own: someone
holding the npm account could still publish by hand, which is exactly
what the identity check catches.)
