# Connectors

A connector is the gateway's adapter to one outside system. There are three modules, each with its contract in `src/connectors/types.ts`:

- **Store** (`BookingConnector`): a booking platform that returns ready-made slots, sets prices, and books, cancels and reschedules itself (Square, GlossGenius).
- **Calendar** (`CalendarConnector`): a plain calendar that only knows busy intervals and events. The gateway's own slot engine and rules build slots and prices on top (`calendar.ts` adapts it to a BookingConnector) (Google).
- **Communication** (`CommunicationConnector`): how the merchant hears from the gateway. It is not a booking system: it sits beside whichever one is configured. Every channel gets one short notice per agent booking, cancel and reschedule; those failures are logged, never thrown, so a channel can never change a booking's outcome. A thread-capable channel (Slack) also carries agent messages and the owner's typed replies; its thread methods throw `channel_*` codes so the core can queue or refuse.

The checklist below applies to all three modules; for a Communication connector, the booking items (idempotency, `slot_unavailable`, cancel/reschedule) are covered by the core booking tests rather than the connector's own, and its tests instead cover every `channel_*` code and, for a thread-capable channel, the inbound path (ack only after the reply is stored, ignored message kinds, reconnect).

## Registry

| Name | Module | Source | Doc | Tests | Status |
|---|---|---|---|---|---|
| `google` | Calendar (`CalendarConnector`) | `src/connectors/google.ts` | [google.md](google.md) | `test/google.test.ts` | Stable |
| `square` | Store (`BookingConnector`) | `src/connectors/square.ts` (+ `square-oauth.ts`) | [square.md](square.md) | `test/square.test.ts`, `test/square-oauth.test.ts` | Stable |
| `glossgenius` | Store (`BookingConnector`, shadow mode) | `src/connectors/glossgenius.ts` | [glossgenius.md](glossgenius.md) | `test/glossgenius.test.ts` | Experimental |
| `twilio` | Communication (`CommunicationConnector`, notify only) | `src/connectors/twilio.ts` (messages in `src/notify/owner.ts`) | [twilio.md](twilio.md) | `test/twilio.test.ts`, `test/owner.test.ts` | Experimental |
| `slack` | Communication (`CommunicationConnector`, notify + two-way thread) | `src/connectors/slack.ts` (+ `slack-socket.ts`) | [slack.md](slack.md) | `test/slack.test.ts` | Experimental |

The README's *Connectors* table links each doc; this file is the full registry.

## Definition of done for a connector change

Every pull request that adds a connector or changes one must tick all of these. `test/connectors-dx.test.ts` enforces the mechanical items; the rest are reviewed by hand.

### 1. Documentation

- [ ] `docs/connectors/<name>.md` exists and has these headings, in this order: **Overview, Prerequisites, Setup, Use cases, Limitations, Errors, Env vars, Tests**.
- [ ] The README's *Connectors* table has a row linking `docs/connectors/<name>.md`.
- [ ] `docs/deploy.md` mentions anything a host needs (inbound URLs, token renewal, secrets).
- [ ] Every env var the connector reads is in the `docs/configuration.md` env table and in the doc's *Env vars* section.

### 2. Tests

- [ ] `test/<name>.test.ts` exists and runs against a scripted fake of the platform (route table or fake HTTP), never the live API.
- [ ] Every `ConnectorError` code the connector can throw has at least one test that triggers it.
- [ ] Idempotency: booking twice with the same `event_id` / `idempotency_key` creates one appointment.
- [ ] `slot_unavailable` on a slot taken between quote and book.
- [ ] Cancel of an already-cancelled booking is a no-op; reschedule keeps the `booking_id`.
- [ ] `checkAccess` failure paths produce a fix hint a merchant can act on.

### 3. Use cases

- [ ] The doc's *Use cases* section says what an agent can do end to end through this connector (find slots, quote, book, cancel, reschedule) and what it cannot (for example variable-priced services, payments).
- [ ] Anything the agent must know is also in `llms.txt` (`src/adapters/agents.ts`), for example "this merchant needs a phone number".

### 4. Onboarding

- [ ] `npm run init` can configure the connector interactively and non-interactively; `npm run init -- --help` names it.
- [ ] The wizard writes the env vars to `.env` and runs `checkAccess` before finishing.
- [ ] The gateway's startup message says which env vars select this connector when none is configured.
- [ ] A merchant with no developer can follow the *Setup* section alone. Steps name the exact menu labels of the platform.

## Adding a connector

1. Implement it in `src/connectors/<name>.ts` behind `BookingConnector` (Store), `CalendarConnector` + `CalendarBookingConnector` (Calendar) or `CommunicationConnector` (Communication).
2. Wire selection in `src/server.ts` and the env schema in `src/config.ts`.
3. Add it to `src/cli/init.ts` (interactive choice, flags, `--help`); a Communication connector goes in the owner-channel step, `src/cli/init-channel.ts`, which the *Book appointments and message me* goal runs; give it an entry in `CHANNEL_GUIDES` (a booking system: `SETUP_GUIDES` in `init.ts`) so the wizard can show its setup steps and link its doc.
4. Copy `_template.md` to `docs/connectors/<name>.md` and fill every section.
5. Add the README table row, the registry row above, the env vars to `docs/configuration.md`, and `test/<name>.test.ts`.
6. Add `<name>` to `CONNECTORS` in `test/connectors-dx.test.ts` and run `npm test`.
