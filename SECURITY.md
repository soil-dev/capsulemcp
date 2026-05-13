# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Two private channels:

- **Email**: `anton@deadbeef.mx` — PGP-encrypted is welcome but not required.
- **GitHub Security Advisories**: open a private advisory at
  <https://github.com/soil-dev/capsulemcp/security/advisories/new>. Only
  maintainers can see it until disclosure.

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
  HTTP+OAuth entry (`dist/http.js`).
- The auth and rate-limit code paths in `src/auth/` and `src/http/`.
- The Capsule API client in `src/capsule/`.
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

Security fixes land on `master` and are tagged as a patch release
(`vX.Y.Z+1`). Pre-1.0 we don't backport to older minor versions —
upgrade is the supported path. After 1.0, the most recent two minor
lines will receive patch backports for security-class issues.
