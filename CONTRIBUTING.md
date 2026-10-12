# Contributing

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). AI-assisted contributions follow the [AI policy](AI_POLICY.md).

Just open a pull request. For anything larger than a small fix, open an issue first so we can agree on the approach; we do not assign issues, link yours in the PR.

## Dev setup

Needs Node >= 22.13 and npm.

```bash
git clone https://github.com/mudroom-ai/gateway.git && cd gateway
npm ci
cp config.example.json config.json   # then edit it
npm run dev         # watch mode on src/server.ts
npm test            # vitest
npm run typecheck
npm run build
```

Secrets and switches are env vars: [docs/configuration.md](docs/configuration.md). `npm run init` runs the setup wizard (needs `npm run build` first).

## Tests

Tests use vitest. They run against scripted fakes of the platform, never live APIs. From [CLAUDE.md](CLAUDE.md): connector tests cover "the behaviour that changed, against a scripted fake of the platform (never the live API). Every `ConnectorError` code the connector can throw has a test."

Keep tests light: cover the behaviour you changed.

Conventions:

- Example phone numbers in docs and tests use `+1 202 555 0199`. Square rejects fake numbering ranges.
- Errors share one shape across every HTTP route. Connectors throw `ConnectorError` and never shape HTTP responses themselves.

## Adding or changing a connector

A connector change is not done until the checklist in [docs/connectors/README.md](docs/connectors/README.md) passes: docs, tests, use cases, onboarding. [CLAUDE.md](CLAUDE.md) has the short version. A new connector starts from [docs/connectors/_template.md](docs/connectors/_template.md).

`test/connectors-dx.test.ts` checks the mechanical parts and fails `npm test` when something is missing. Do not weaken it to make a change pass; finish the checklist.

## Pull requests

- One change per PR.
- Fill in the PR template.
- CI must pass: `npm run typecheck`, `npm test`, and `sh -n` plus `shellcheck -S error` on `install.sh`. Run the first two locally.
- Update the docs in the same PR as the behaviour they describe.
- Contributions are licensed under Apache-2.0, the same as the project ([LICENSE](LICENSE)).

## External PRs: what to expect

There is one maintainer. Reviews can take days to a couple of weeks. We may close PRs that are out of scope, add long-term maintenance burden, or go stale; you can reopen them. Keep changes focused, run tests locally and respond to review.

## Bugs

Open a GitHub issue with the version, connector, and steps to reproduce. For questions, see [SUPPORT.md](SUPPORT.md). Security issues do not go in issues; see [SECURITY.md](SECURITY.md).
