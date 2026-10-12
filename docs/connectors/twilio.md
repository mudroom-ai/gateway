# Twilio connector (owner SMS)

## Overview

A **Communication** connector, a `CommunicationConnector` with `notify` only (`src/connectors/twilio.ts`): how the merchant hears about agent bookings. It sits beside the Store or Calendar connector and works with **every booking system** (Google Calendar, Square, GlossGenius). When it is configured, the gateway sends the merchant one SMS through [Twilio](https://www.twilio.com) for each agent booking, cancel and reschedule.

It is **outbound only**: the gateway posts to Twilio's REST API and never reads replies. A text never decides whether a booking happens; the booking is already made (or cancelled, or moved) when the text goes out.

Why use it with each system:

- **GlossGenius (shadow mode):** the text is how the merchant learns to key the booking into GlossGenius by hand. Without it, those bookings only reach the log and the shared Google Calendar.
- **Google Calendar and Square:** the booking already lands in the merchant's own calendar or Square; the text is a heads-up that an AI agent made it.

## Prerequisites

- A [Twilio](https://www.twilio.com) account (a trial account works for testing).
- A Twilio phone number that can send SMS to the merchant's country.
- The account's **Account SID** and **Auth Token**.
- The merchant's mobile number in E.164 form, for example `+12025550199` (`+1 202 555 0199`).
- On a **trial account**, the merchant's mobile must be a verified caller ID, and every text starts with Twilio's trial prefix.
- The host needs outbound HTTPS to `api.twilio.com` ([deploy.md](../deploy.md)).

## Setup

1. **Sign in** to the [Twilio Console](https://console.twilio.com).
2. **Copy the credentials.** On the Console home page, under **Account Info**, copy the **Account SID** and the **Auth Token** (click **Show** to reveal it).
3. **Pick the sending number.** Go to **Phone Numbers → Manage → Active numbers** and note the number to send from. If the list is empty, use **Buy a number** and pick one with SMS capability.
4. **Trial accounts only:** go to **Phone Numbers → Manage → Verified Caller IDs**, click **Add a new Caller ID** and verify the merchant's mobile with the code Twilio sends.
5. **Run `npm run init`.** Pick *Book appointments and message me* at the first question. After you set up the booking system (Google, Square or GlossGenius), pick *Twilio SMS* at the "Owner channel" question, answer *Yes, I have these* to "Ready to connect?", then give the owner mobile number (for example `+1 202 555 0199`), the Account SID, the Auth Token and the Twilio number to send from. The wizard writes them to `.env` (mode 600). Pick *None* to skip; you can re-run the wizard later and it keeps your other answers.

Non-interactive, with any booking system (here Google Calendar):

```bash
npm run init -- --non-interactive --name "Sam's Barbers" --service "Haircut:45:15:40" \
  --google-key-file key.json --calendar-id agent-bookings@group.calendar.google.com \
  --owner-phone +12025550199 --twilio-sid AC... --twilio-token ... --twilio-from +12025550100
```

The four flags are all-or-nothing. Each falls back to the env var of the same name (see *Env vars*).

## Use cases

The merchant receives one text per agent action, in these formats:

- **Book:** `Agent booking: Jane Doe, Haircut, Fri Oct 9, 10:00 AM, $45.00. Booking b_1.`
- **Cancel:** `Agent cancelled: Jane Doe, Haircut, Fri Oct 9, 10:00 AM. Booking b_1.`
- **Reschedule:** `Agent rescheduled: Jane Doe, Haircut from Fri Oct 9, 10:00 AM to Sat Oct 10, 11:00 AM. Booking b_1.`

Times are in the merchant's `timezone` from `config.json`; prices in other currencies read `45.00 EUR`.

In GlossGenius shadow mode each text ends with a platform note: `Not in GlossGenius yet, please add it by hand.`, `Please remove it from GlossGenius.` or `Please move it in GlossGenius.` The merchant then adds, removes or moves the booking in GlossGenius ([glossgenius.md](glossgenius.md#setup)).

It cannot:

- **Read replies.** A reply to the text goes nowhere.
- **Confirm or decline** a booking. The booking is made before the text; to refuse it, the merchant cancels it with the customer.
- Hold a **two-way conversation** with the merchant or the customer, or text the customer.
- Text **more than one** number.

## Limitations

- **Cost.** Each text is a billable Twilio SMS on the merchant's or self-hoster's account.
- **Carrier filtering.** US carriers filter application-to-person SMS from unregistered numbers. A US long-code number needs **A2P 10DLC** registration in the Twilio Console (**Messaging → Regulatory Compliance**), or texts may be delayed or dropped. Other countries have their own sender rules.
- **One recipient.** `OWNER_PHONE` is a single number.
- **Slack wins.** When the `SLACK_*` vars are also set, the gateway uses Slack ([slack.md](slack.md)) for owner messages, ignores these four and logs a warning at startup.
- **Delivery failures are only logged.** If Twilio rejects or times out (10 seconds), the gateway writes a warning to its log and does not retry.
- **Never blocks a booking.** A failed text never fails, delays past the timeout, or undoes a book, cancel or reschedule.
- Messages are cut at 1500 characters.

## Errors

This connector throws no `ConnectorError`; agents never see an error from it.

- **Partial config fails startup.** Setting some but not all of the four vars stops the gateway (and `npm run init`) with: `Owner SMS is partly configured: set TWILIO_AUTH_TOKEN, TWILIO_FROM too, or unset all of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, OWNER_PHONE to log owner notices instead`, naming whichever are missing. Fix: set the missing ones or remove all four.
- **Delivery failures** are logged, with the phone masked to its last four digits: `[gateway] owner SMS to ***0199 failed (401): Authenticate` (HTTP status plus Twilio's own message), or `... failed: timed out after 10000 ms` / `... failed: network error: ...`. Common causes: a wrong Auth Token (401), an unverified destination on a trial account (21608), or a sending number without SMS capability.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | unset | Twilio Account SID (Console → **Account Info**). |
| `TWILIO_AUTH_TOKEN` | unset | Twilio Auth Token (Console → **Account Info**). Secret. |
| `TWILIO_FROM` | unset | The Twilio number texts come from, E.164 (e.g. `+12025550100`). |
| `OWNER_PHONE` | unset | The merchant's mobile, E.164 (e.g. `+12025550199`). |

Set all four or none. With none, no texts are sent; GlossGenius shadow mode writes the notice to the log instead, Google and Square send nothing.

## Tests

`test/twilio.test.ts` runs the channel against a scripted fake `fetch` (never the live Twilio API): the request shape (URL with the Account SID, Basic auth, form body with `To`, `From`, `Body`), the 1500-character cut, phone masking, logging instead of throwing on a non-2xx (with Twilio's message) and on network errors, and the all-or-nothing env rule with the error naming the missing vars. The message formats are covered in `test/owner.test.ts`, the texts sent on book, cancel and reschedule by the core booking tests, and `test/init.test.ts` covers the wizard's Twilio flags and prompt with Google, Square and GlossGenius.
