# GlossGenius connector

## Overview

A **BookingConnector** in **shadow mode** (`src/connectors/glossgenius.ts`; the owner SMS is the [Twilio connector](twilio.md)). GlossGenius is a scheduler for salons, estheticians and other beauty businesses. It has no public API, so the gateway never writes into it:

- **Reads** come from the merchant's public GlossGenius booking page: the same services, prices and open times a customer sees, with no login and no tokens to manage.
- **Writes** go to a Google Calendar the merchant shares with the gateway. Each agent booking also sends the merchant one text message through the [Twilio owner channel](twilio.md) (or a log line when Twilio is not set up), and the merchant keys the booking into GlossGenius by hand.

GlossGenius sets the prices (`pricesServices = true`): quotes carry the booking page's price, and the discounts in `config.json` are ignored. Slots start at least `GLOSSGENIUS_MIN_LEAD_HOURS` ahead (default 48), so the merchant has time to add the booking before anyone else can take that time in GlossGenius. Cancel and reschedule act on the gateway's own calendar event and text the merchant too.

**Unofficial.** This connector is not affiliated with or endorsed by GlossGenius. It sends the same unauthenticated requests the public booking page makes, and only reads. It can break without notice when GlossGenius changes its site. Merchants are responsible for checking that this use is allowed under their GlossGenius terms.

Pick this connector when the merchant runs their book in GlossGenius. Do not instead point the plain Google connector at a calendar that GlossGenius fills through its iCal feed; that feed lags up to 24 hours ([deploy.md §6](../deploy.md#6-unsafe-calendar-sources-delayed-feed-schedulers)).

## Prerequisites

- Merchant: a GlossGenius account with **online booking turned on** and at least one service with a **fixed, visible price**.
- Merchant: a Google Calendar they can share. A new, empty calendar just for agent bookings works well. Self-hoster: a Google service account key, exactly as for the [Google connector](google.md#prerequisites).
- Optional but recommended, for the text message: what the [Twilio connector](twilio.md#prerequisites) needs (a Twilio account, an SMS-capable number, the merchant's mobile).
- The host needs outbound HTTPS to `*.glossgenius.com`, `api.glossgenius.com`, `www.googleapis.com` and (with SMS) `api.twilio.com`.

## Setup

1. **Find your booking page link.** In the GlossGenius app go to **Online Booking** and tap **Share booking link** (on the web: **Online Booking → Booking site**). Copy the link; it looks like `https://yourname.glossgenius.com`. Open it in a private browser window and check that your services and open times show without logging in.
2. **Share a Google Calendar** with the gateway's service account (*Make changes to events*) and copy its **Calendar ID**. Steps 1 to 5 of the [Google connector setup](google.md#setup) cover this; skip the services and hours, which come from GlossGenius here.
3. **Optional: texts.** Get the Twilio Account SID, Auth Token and sending number as in [twilio.md Setup](twilio.md#setup) steps 1 to 4.
4. **Run `npm run init`**, choose *GlossGenius (shadow mode: reads your booking page, writes to Google Calendar)*, paste the booking page link, the key path and the Calendar ID, then pick *Slack* or *Twilio SMS* at the "Owner channel" question (for Twilio, give your mobile, for example `+1 202 555 0199`, and the three Twilio values), or *None* to have bookings logged only. GlossGenius gets this question whichever goal you picked at the start. The wizard writes `.env` (mode 600), reads the booking page, checks the calendar share and lists the services agents will see.

Non-interactive:

```bash
npm run init -- --non-interactive --name "Luna Studio" --timezone America/New_York \
  --glossgenius-url https://yourname.glossgenius.com \
  --google-key-file key.json --calendar-id agent-bookings@group.calendar.google.com \
  --owner-phone +12025550199 --twilio-sid AC... --twilio-token ... --twilio-from +12025550199
```

The Twilio flags are all-or-nothing and may be left out ([twilio.md](twilio.md) has the details). Every flag falls back to the env var of the same name (see *Env vars*).

**After each text:** add the booking to GlossGenius (client, service, time); the text ends with "Not in GlossGenius yet, please add it by hand." For a cancel or reschedule text, remove or move it there.

## Use cases

An agent can, end to end:

- **List services** from the booking page, with duration and GlossGenius's price.
- **Find slots** that the booking page offers, at least `GLOSSGENIUS_MIN_LEAD_HOURS` ahead, minus anything already in the shared Google Calendar (the gateway's earlier bookings, or time the merchant blocks there).
- **Quote** a slot at GlossGenius's price. Config discounts are ignored.
- **Book** with a name and a phone or email. The gateway re-reads the booking page to confirm the slot is still offered, writes the event to Google Calendar and texts the merchant. Retries with the same `idempotency_key` create one event.
- **Cancel**: deletes the calendar event and texts the merchant. Cancelling an already-cancelled booking is a no-op.
- **Reschedule**: re-checks the new slot, moves the calendar event, texts the merchant; the `booking_id` stays the same.

It cannot:

- **Write into GlossGenius.** The merchant adds, moves and removes the booking there by hand after the text.
- Take **deposits or payments**, or apply a GlossGenius cancellation fee.
- Book services with a **variable price** ("from $X") or a **hidden price**; they are skipped with a startup warning.
- Pick a **staff member**: the slot is whatever the booking page offers for "any provider".
- Join a **waitlist** or book add-ons.

## Limitations

- **Unofficial read.** The connector reads the public booking page and the API behind it, which GlossGenius may change without notice. When the page no longer looks as expected, the connector fails closed: no slots, and errors whose message says `connector_drift`. If GlossGenius blocks the read, the message says `blocked_by_vendor`.
- **Minimum lead time.** Slots start at least 48 hours out by default (`GLOSSGENIUS_MIN_LEAD_HOURS`). The booking page is read up to 5 minutes stale, and the merchant needs time to key the booking in; a shorter lead raises the chance that a GlossGenius client takes the same time first.
- **Texts are one-way.** Replies to the SMS are not read in this version. To refuse an agent booking, the merchant cancels it with the customer directly.
- **One location.** Only the first location on the booking page is used.
- Without Slack or Twilio, the merchant only learns about agent bookings from the gateway's log and the Google Calendar, and agents cannot leave a message: the message routes are not offered, because nobody would read them.

## Errors

| Code | When | Agent action |
|---|---|---|
| `calendar_unavailable` | GlossGenius timed out or returned 429/5xx (`GlossGenius unavailable ...`, `GlossGenius unreachable ...`); refused the read (`GlossGenius refused the request (blocked_by_vendor): ...`); or the page changed (`GlossGenius response changed shape (connector_drift): ...`). Also Google Calendar outages. | Retry after `retry_after_s` (default 30). Drift and blocks need the merchant or the self-hoster. |
| `calendar_auth_failed` | At startup: `Could not read the GlossGenius booking page at <url> (...)`, or the Google Calendar share or key is wrong (Google's own fix hint). | Not retryable. Merchant checks `GLOSSGENIUS_BOOKING_URL` opens in a browser, or fixes the calendar share. |
| `slot_unavailable` | `The slot is no longer offered` (the fresh booking page read no longer lists it) or `The slot was just taken` (the Google Calendar has an event there). | Use `alternatives` or search again. |
| `already_exists` | The calendar already has the event for this booking (a retry). Handled inside the connector and treated as booked; agents do not see it. | None. |

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `GLOSSGENIUS_BOOKING_URL` | unset | The merchant's public booking page, e.g. `https://yourname.glossgenius.com`. Selects this connector (unless Square is configured). |
| `GLOSSGENIUS_MIN_LEAD_HOURS` | `48` | Slots closer than this many hours are never offered. Whole number, at least 1. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_SERVICE_ACCOUNT_FILE` | unset | Service account key (contents or path) for the calendar that holds agent bookings. Required. |
| `GOOGLE_CALENDAR_ID` | unset | That calendar's ID. Required. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OWNER_PHONE` | unset | Optional owner SMS, described in [twilio.md](twilio.md#env-vars). All four or none; with none, notices go to the log. |

## Tests

`test/glossgenius.test.ts` runs the connector against a scripted fake of GlossGenius (a route table over `fetch` that serves a booking page and the services and availability endpoints, and logs every call) and the in-memory fake calendar: identifier extraction from the page, skipped variable and hidden prices, month-by-month availability with caching, the lead-time and busy-time filters, booking with the fresh re-check (nothing written to GlossGenius), idempotent retries through `already_exists`, `slot_unavailable` when the page no longer offers the slot, cancel (including the already-cancelled no-op), reschedule (new event, same `booking_id`, old event deleted after), the owner notices and swallowed notice failures, `calendar_unavailable` for network errors, 5xx with `Retry-After`, `blocked_by_vendor` (403 after one re-mint, challenge pages) and `connector_drift`, and the `calendar_auth_failed` fix hint from `checkAccess`. `test/twilio.test.ts` and `test/owner.test.ts` cover the SMS itself ([twilio.md](twilio.md#tests)). `test/init.test.ts` covers the wizard's GlossGenius path. Nothing calls the live GlossGenius or Twilio APIs.
