# Errors

Every route returns the same error body:

```json
{ "code": "slot_unavailable", "message": "...", "retryable": false, "retry_after_s": 30, "alternatives": [ { "slot": { "start": "...", "end": "..." }, "price_cents": 6500 } ] }
```

`retry_after_s` and `alternatives` (up to 3) appear only when they apply. Over HTTP the status matches the code and a `Retry-After` header is sent when `retry_after_s` is set. The list below is the contract: adding a code is fine, renaming one or changing its status or retryability is a breaking change (`src/errors.ts`).

## Codes

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `invalid_request` | 400 | no | Malformed arguments |
| `invalid_time` | 400 | no | A time without a UTC offset (RFC 3339 with offset is required) |
| `invalid_window` | 400 | no | Window over 14 days, flexibility over 240 min, or a start in the past |
| `invalid_customer` | 400 | no | Missing name, missing phone or email, or a contact the booking system rejected |
| `invalid_message` | 400 | no | `leave_message` / `follow_up`: message empty, over 1000 characters, or containing control characters |
| `unauthorized` | 401 | no | A bearer key was sent but is not in `API_KEYS` |
| `unknown_service` | 404 | no | No service with that id (`GET /api/services` lists them) |
| `unknown_quote` | 404 | no | No such `quote_id` |
| `unknown_booking` | 404 | no | No such `booking_id`, or the contact does not match the one it was booked with |
| `unknown_thread` | 404 | no | No such `thread_id`, or the `read_token` is missing or wrong (the body is identical in all three cases) |
| `already_booked` | 409 | no | The quote was already booked under a different `idempotency_key` |
| `slot_unavailable` | 409 | no | The slot was taken between quote and book; the quote is voided and alternatives are offered |
| `idempotency_conflict` | 409 | no | Same `idempotency_key`, different payload |
| `already_cancelled` | 409 | no | `reschedule` (or `find_slots`/`quote` with `booking_id`) on a booking that was cancelled; `cancel` itself is idempotent and returns success |
| `cancel_forbidden` | 409 | no | The appointment already started, or the merchant's cancellation window has passed |
| `thread_closed` | 409 | no | `follow_up` on a closed thread (closed by the agent, by a booking for the same contact, by the owner, or after going quiet), or a thread that reached 20 agent messages; call `leave_message` to start a new one. `close_thread` on a closed thread is not an error |
| `thread_limit_reached` | 409 | no | The contact has `max_open_threads_per_contact` open threads; closing one (`close_thread`, a booking, or the idle close) clears it |
| `message_in_progress` | 409 | yes | Same `idempotency_key` while the first request is still being delivered; retry with the same key to get its result |
| `contact_limit_reached` | 409 | no | The contact has `max_open_bookings_per_contact` open bookings; waiting does not clear it |
| `expired` | 410 | no | The quote's `expires_at` has passed; quote again |
| `no_slot` | 422 | no | No free slot in the window; `alternatives` may be included |
| `over_budget` | 422 | no | No slot at or under the agent's `max_price_cents` |
| `blocked_by_rule` | 422 | no | An owner rule (blackout, hours, floor) refuses the slot |
| `service_not_bookable` | 422 | no | `find_slots` / `quote` with the id of an ask-the-owner service (`ask_services` in `GET /api/services`): offered, but with no fixed price or duration to book. Send `leave_message` with that `service_id` when `/llms.txt` lists `POST /api/messages`; otherwise tell the user to contact the business |
| `rate_limited` | 429 | yes | Per-IP or per-key limit, a contact's hourly limit, or the merchant-wide `max_messages_per_hour`; wait `retry_after_s` |
| `calendar_unavailable` | 503 | yes | The booking system timed out or returned 5xx; wait `retry_after_s` |
| `calendar_auth_failed` | 503 | no | Credentials or calendar sharing are wrong; the message carries a fix hint for the merchant |
| `booking_disabled` | 503 | no | `BOOKING_ENABLED=false` kill switch |
| `messages_disabled` | 503 | no | `MESSAGES_ENABLED=false` kill switch for `leave_message`, `get_thread` and `follow_up` |
| `channel_unavailable` | 503 | no | The owner channel refused the message for good (bad token, app removed from the channel); nothing was stored. Tell the user the business cannot be reached this way. Brief channel outages are not errors: the message is queued and `delivery` is `"queued"` |
| `internal` | 500 | yes | Unexpected failure |

## Connector errors

Connectors never shape responses. They throw `ConnectorError` with one of these codes and the core maps it to the body above: `calendar_unavailable`, `calendar_auth_failed`, `slot_unavailable`, `cancel_forbidden`, `unknown_booking`, `invalid_customer`, and `already_exists` (an event with the same deterministic id already exists; the core treats the booking as created, so agents never see this code). Each connector doc has an *Errors* section with the platform-specific triggers: [connectors/google.md](connectors/google.md#errors), [connectors/square.md](connectors/square.md#errors).

Owner channels (the Communication module) throw three codes of their own, and the message core decides what the agent sees: `channel_unavailable` from the channel (429, 5xx, timeout) is transient, so the message is stored, queued and retried 5 times (30 s up to 8 min) and the agent gets 201 with `delivery: "queued"`; `channel_auth_failed` and `channel_rejected` are permanent, so nothing is stored and the agent gets 503 `channel_unavailable` with `retryable: false`.
