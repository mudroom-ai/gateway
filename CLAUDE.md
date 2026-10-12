# gateway: working rules

## Connector developer-experience rule

A connector is any file under `src/connectors/` that implements one of the connector interfaces in `src/connectors/types.ts`. The current list is the registry table in `docs/connectors/README.md`.

**Whenever a connector is added or its behaviour changes, the change is not done until the connector checklist in `docs/connectors/README.md` passes.** That means, in the same change:

1. **Documentation**: `docs/connectors/<name>.md` is current and has every required heading (Overview, Prerequisites, Setup, Use cases, Limitations, Errors, Env vars, Tests). The README's *Connectors* table links it, and every env var it reads is in `docs/configuration.md`.
2. **Tests**: `test/<name>.test.ts` covers the behaviour that changed, against a scripted fake of the platform (never the live API). Every `ConnectorError` code the connector can throw has a test.
3. **Use cases**: the doc's *Use cases* section lists what an agent can do through this connector end to end (find, quote, book, cancel, reschedule) and what it cannot.
4. **Onboarding**: `npm run init` (`src/cli/init.ts`) can set the connector up, its `--help` text names it, and the startup check (`checkAccess`) prints a fix hint a merchant can act on.

`test/connectors-dx.test.ts` checks the mechanical parts of this list and fails `npm test` when a connector is missing a doc, a heading, a test file, a README link, an init mention, a registry row or an env var in `docs/configuration.md`. Do not weaken that test to make a change pass; finish the checklist instead.

New connector: copy `docs/connectors/_template.md` to `docs/connectors/<name>.md`, add the row to the registry table in `docs/connectors/README.md`, and add `<name>` to `CONNECTORS` in `test/connectors-dx.test.ts`.

## Other conventions

- Example phone numbers in docs and tests use `+1 202 555 0199` (a real area code with a reserved 555-01xx number) because Square rejects fake numbering ranges.
- Errors share one shape across every HTTP route; connectors throw `ConnectorError` and never shape HTTP responses themselves.
