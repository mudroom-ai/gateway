# Security policy

A gateway process holds credentials for a merchant's business: Google service-account keys, Square OAuth tokens, Slack and Twilio tokens. It also exposes a public booking API that can create and cancel real appointments. A vulnerability here can reach all of that, so reports matter.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: <https://github.com/mudroom-ai/gateway/security/advisories/new>.

Do not post vulnerabilities in public issues or pull requests. Include the version or commit, the connector involved, and steps to reproduce.

## What to expect

- We acknowledge a report within 3 business days.
- Fix timelines are best-effort, and we will keep you updated.
- We credit reporters in the advisory if you ask.
- There is no bug bounty.

## Supported versions

Only the latest release gets fixes.

## Scope

Self-hosted deployments are the operator's responsibility: the host, the reverse proxy or tunnel, secrets storage and access to `.env`. For hardening (`ALLOWED_HOSTS`, `TRUST_PROXY`, rate limits, `API_KEYS` bearer keys) see [docs/deploy.md](docs/deploy.md).

A bug in the gateway's own code is in scope, for example auth or rate-limit bypass, leaking a token, booking or cancelling without the right contact, or injection through a connector.

Test only against your own deployment, never someone else's live gateway: it books real appointments.
