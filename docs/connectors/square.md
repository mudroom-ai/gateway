# Square Appointments connector

## Overview

A **BookingConnector** (`src/connectors/square.ts`, OAuth helpers in `square-oauth.ts`). The gateway sits in front of Square Appointments: services and prices come from Square's catalog, availability from Square's search, and bookings are created, moved and cancelled in Square. The rules engine is bypassed (`pricesServices = true`) and quotes carry Square's price.

It uses **buyer-level** access, which works on Square's free plan: it does what a customer could do through the merchant's own Square booking page, attaches each booking to a Square customer record, and never touches payments.

## Prerequisites

- Merchant: Square Appointments with each bookable service set to **bookable online**, a **fixed price**, and at least one bookable team member.
- Self-hoster: a Square application in the [Developer Console](https://developer.squareup.com/console/en/apps) with the OAuth **Redirect URL** set to `http://localhost:3099/callback` (Production for a real seller, Sandbox for a test account), plus its **Application ID** and **Application secret**.
- A machine with a browser for the one-time OAuth flow. The server itself never needs an inbound URL.

## Setup

1. In the Square Developer Console create an application. On its **OAuth** page set the Redirect URL above and copy the Application ID and secret.
2. Run `npm run init`, pick *Book appointments* at the first question, choose *Square Appointments*, answer *Yes, I have these*, paste the ID and secret. The wizard opens Square's authorisation page; sign in as the seller and click **Allow**. It asks only for `APPOINTMENTS_READ`, `APPOINTMENTS_WRITE`, `APPOINTMENTS_BUSINESS_SETTINGS_READ`, `CUSTOMERS_READ`, `CUSTOMERS_WRITE`, `ITEMS_READ`, `MERCHANT_PROFILE_READ`.
3. Pick the location. The wizard writes `SQUARE_ACCESS_TOKEN`, `SQUARE_REFRESH_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENV`, `SQUARE_APP_ID` and `SQUARE_APP_SECRET` to `.env` and runs the access check (token, location, at least one bookable fixed-price service).

Non-interactive: `npm run init -- --square` with `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` and optionally the refresh trio in the environment.

**Do not use the dashboard's personal access token.** It carries `APPOINTMENTS_ALL_WRITE`, which makes every call seller-level, and Square then refuses writes unless the merchant pays for Appointments Plus. In the sandbox, create a second test account and authorise it through the wizard; open that account in the same browser first or the consent page renders blank.

Hosting notes: [deploy.md §1d](../deploy.md#1d-square-instead-of-google).

## Use cases

An agent can, end to end:

- **List services** from Square's catalog (bookable, fixed-price variations) with duration and price.
- **Find slots** that Square itself offers (the connector widens the query to Square's 24-hour minimum and filters back).
- **Quote** a slot at Square's price. Config discounts are ignored.
- **Book** with a name and a **phone number** (Square requires one). Each booking creates its own Square customer. Retries with the same `idempotency_key` are passed through to Square.
- **Cancel** within the merchant's Square cancellation policy; already-cancelled bookings are a no-op.
- **Reschedule** the start time with the same team member; the `booking_id` stays the same.

It cannot:

- Book services with a **variable price** (skipped with a startup warning) or a **no-show fee** (Square refuses at booking time).
- Take payments or deposits.
- Match an existing Square customer by phone or email, because the gateway cannot verify contacts. Merge duplicates in Square.
- Change the team member on reschedule (buyer-level apps may move the start only).

## Limitations

- Customers **must give a phone number**; email alone is refused. `llms.txt` tells agents.
- Square validates contacts against real numbering plans and mail domains. Reserved ranges (UK `07700 900xxx`) and `example.com` are rejected. Docs and tests use `+1 202 555 0199`.
- Cancel and reschedule outside the merchant's policy window are refused by Square.
- The access token lives 30 days. Without `SQUARE_REFRESH_TOKEN`, `SQUARE_APP_ID` and `SQUARE_APP_SECRET` the gateway cannot renew it and `npm run init` must be run again.

## Errors

| Code | When | Agent action |
|---|---|---|
| `calendar_auth_failed` | 401/403 from Square, location not found, or no bookable fixed-price service at startup | Not retryable. Merchant re-runs `npm run init` or fixes the catalog. |
| `calendar_unavailable` | Timeout, network error, 429 or 5xx | Retry after `retry_after_s` (default 5). |
| `slot_unavailable` | The start is no longer offered, or Square reports the slot taken | Use `alternatives` or search again. |
| `invalid_customer` | No phone given, or Square rejected the phone or email | Ask the customer for a valid phone (9 to 16 digits with country code) or email. |
| `cancel_forbidden` | Square's cancellation policy refuses, or the booking was already cancelled in Square | Tell the customer to contact the merchant. |
| `unknown_booking` | Square has no booking with that id | Check the `booking_id`. |

## Env vars

| Var | Meaning |
|---|---|
| `SQUARE_ACCESS_TOKEN` | Buyer-level access token. When set, Square is the booking system and `GOOGLE_*` is ignored. |
| `SQUARE_LOCATION_ID` | The location to book at. |
| `SQUARE_ENV` | `production` (default) or `sandbox`. |
| `SQUARE_REFRESH_TOKEN`, `SQUARE_APP_ID`, `SQUARE_APP_SECRET` | Written by `npm run init`. With all three the gateway renews the 30-day access token itself. |

## Tests

`test/square.test.ts` scripts Square with a route table and logs every call: service listing, 24-hour availability widening, booking (customer creation, slot re-check, idempotency key pass-through), `slot_unavailable` and `invalid_customer`, cancel with the current version and the already-cancelled no-op, reschedule keeping the id, 401/403 and 5xx mapping, phone normalisation. `test/square-oauth.test.ts` covers the authorise link and scopes, code exchange, token refresh timing, the callback listener's state check, and HTML escaping on the callback page. `test/init.test.ts` covers the wizard's Square path.
