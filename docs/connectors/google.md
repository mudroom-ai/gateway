# Google Calendar connector

## Overview

A **CalendarConnector** (`src/connectors/google.ts`). It reads free/busy and creates, fetches and deletes events in one Google Calendar through a **service account**. The gateway's own slot engine and rules engine build the slots and prices (`config.json` services, hours, discounts), so Google only supplies busy time and stores the bookings. `calendar.ts` adapts it to the BookingConnector contract the core operations use.

Pick this connector when the merchant's Google Calendar is the source of truth for their time. Do not use it when a scheduler syncs into Google through a delayed feed (GlossGenius is the known case): the gateway can then double-book in both directions. See [deploy.md §6](../deploy.md#6-unsafe-calendar-sources-delayed-feed-schedulers).

## Prerequisites

- Self-hoster: a Google Cloud project with the **Google Calendar API** enabled and permission to create a service account key. Newer organizations block key creation (`iam.disableServiceAccountKeyCreation`); an org policy admin must override it, or use a project under a personal account.
- Merchant: a Google Calendar they can share. On Google Workspace the admin must allow external sharing with "Share all information, and outsiders can change calendars".
- At least one service in `config.json` (the gateway refuses to start with none in Google mode).

## Setup

1. Google Cloud console → **APIs & Services → Library** → enable **Google Calendar API**.
2. **IAM & Admin → Service accounts → Create service account** (any name, no project roles).
3. Open it → **Keys → Add key → Create new key → JSON**. Keep the file secret; `.gitignore` already ignores `service-account*.json`.
4. Merchant: Google Calendar on the web → hover the calendar → **⋮ → Settings and sharing → Share with specific people or groups → Add people and groups** → paste the service account email → permission **Make changes to events**.
5. Merchant: under **Integrate calendar**, copy the **Calendar ID** (the Gmail address for a primary calendar, `...@group.calendar.google.com` otherwise).
6. Run `npm run init`, pick *Book appointments* at the first question, choose *Google Calendar*, answer *Yes, I have these*, give the key path and Calendar ID. The wizard writes `.env` (mode 600), checks the share, and with `--write-test` creates and deletes a test event to prove write access.

Non-interactive: `npm run init -- --google-key-file key.json --calendar-id owner@example.com`.

Full walkthrough with caveats: [deploy.md §1](../deploy.md#1-google-calendar-setup).

## Use cases

An agent can, end to end:

- **Find slots** for a service inside a window up to 14 days, priced by the merchant's rules (hours, buffers, blackout days, discounts, price floor).
- **Quote** one slot and get a `quote_id` that holds the price until `expires_at`.
- **Book** a quote with a name plus phone or email. The gateway re-checks free/busy, inserts an event with a deterministic id, and retries with the same `idempotency_key` return the same booking.
- **Cancel** with `booking_id` plus the contact. The event is deleted; a missing event counts as cancelled.
- **Reschedule** to a fresh quote for the same service; the `booking_id` stays the same.

It cannot:

- Take payments, deposits or no-show fees.
- See or change events the merchant created by hand beyond treating them as busy.
- Book across more than one calendar or team member; one gateway serves one calendar.

## Limitations

- Quotes do not hold slots. Two agents booking the same slot at the same moment can both pass the free/busy re-check (a per-merchant lock is planned).
- Google's free/busy can lag a just-inserted event by a few seconds.
- **Delayed-feed schedulers are unsafe sources.** The gateway trusts the busy times in Google Calendar. If the merchant's real booking system syncs to Google through a delayed iCal feed (GlossGenius is the known case, with lag up to 24 hours), the gateway can double-book in both directions. Use it only where Google Calendar is the source of truth. See [deploy.md §6](../deploy.md#6-unsafe-calendar-sources-delayed-feed-schedulers).
- Workspace external-sharing settings can take a while to apply after the admin changes them.

## Errors

| Code | When | Agent action |
|---|---|---|
| `calendar_auth_failed` | Key is not valid JSON, cannot sign a JWT, Google rejects it, or the calendar is not shared with *Make changes to events* | Not retryable. The message carries a share hint for the merchant. |
| `calendar_unavailable` | Timeout, network error, 429 or 5xx after one retry | Retry after `retry_after_s`. |
| `already_exists` | Insert hit an event with the same deterministic id (409) | Treat the booking as created; the core maps this to the existing booking. |
| `slot_unavailable` | Free/busy re-check at booking time found the slot taken (`calendar.ts`) | Use the `alternatives` in the error or search again. |

## Env vars

| Var | Meaning |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Key file **contents** on one line (`jq -c . key.json`). Best for Docker and secret stores. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | **Path** to the key file instead. `npm run init` writes this one. If both are set, `_JSON` wins and a warning is logged. |
| `GOOGLE_CALENDAR_ID` | The merchant's Calendar ID. |

When `SQUARE_ACCESS_TOKEN` is set, Square wins and these are ignored.

## Tests

`test/google.test.ts` drives the connector through a fake HTTP implementation (no network): free/busy timeouts and 5xx with one retry, 409 on insert mapped to `already_exists` without retry. The core operations are tested against the in-memory calendar in `test/helpers/fake-calendar.ts` (`book`, `cancel`, `slots`, `volume`). `test/init.test.ts` covers the wizard's Google path.
