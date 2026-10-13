# How agents use the gateway

AI agents discover and book appointments through the gateway's HTTP/JSON API. No agent-side installation is needed.

**Booking flow:** `list_services` → `find_slots` → `quote` → `book`

**Need the owner's help?** `leave_message` → `get_thread` → `follow_up` or `close_thread`

## Connect an agent

1. **Expose over HTTPS** (cloud agents cannot reach `localhost`). Run `cloudflared tunnel --url http://localhost:3000`, then set `ALLOWED_HOSTS`. See [the deployment guide](deploy.md#3-expose-it-over-https-with-cloudflared).
2. **Give the agent your gateway URL.** It reads `/llms.txt` for instructions or `/openapi.json` for the schema.
3. **Call the public API.** Guardrails include rate limits, per-contact open-booking caps, the booking log, and `BOOKING_ENABLED`. Optional bearer keys (`API_KEYS`) raise limits.

### How discovery works

| Path | Purpose |
| --- | --- |
| `/` | Booking page with discovery links to `/llms.txt` and `/openapi.json` |
| `/llms.txt` | Agent instructions, including merchant requirements such as a phone number |
| `/openapi.json` | HTTP routes and schemas |
| `/.well-known/llms.txt` | Same content as `/llms.txt` |
| `/robots.txt` | Points crawlers to the agent instructions |
| `/healthz` | Returns `{"ok":true}`; with an owner channel, also reports channel connectivity and queued or failed owner messages in `channel` and `outbox` |

<details>
<summary>HTML discovery tags</summary>

The booking page includes:

```html
<link rel="alternate" type="text/markdown" href="/llms.txt">
<link rel="service-desc" href="/openapi.json">
```

</details>

## Book, cancel, or reschedule

Names match `/llms.txt`. Success: HTTP 200 (201 for `book`). Errors: [shared format](errors.md).

| Operation | Endpoint | What to send / expect |
| --- | --- | --- |
| `list_services` | `GET /api/services` | Service IDs, durations, and base prices; plus `ask_services` when the business lists any |
| `find_slots` | `POST /api/slots` | A window in RFC 3339 with UTC offset (max 14 days), optional flexibility (±240 minutes); returns priced slots |
| `quote` | `POST /api/quote` | One slot; returns `quote_id`, `price_cents`, `applied_rules`, and `expires_at`, or alternatives |
| `book` | `POST /api/book` | Quote, customer name plus phone or email, and a client-chosen `idempotency_key`; retries with the same key never create a second event |
| `cancel` | `POST /api/cancel` | `booking_id` and the original phone or email; idempotent |
| `reschedule` | `POST /api/reschedule` | Booking and a fresh quote for the same service; preserves `booking_id` |

**Rescheduling:** include `booking_id` and contact in `find_slots` and `quote` so the current appointment's time appears available.

### Ask-the-owner services

A business can list services it offers but cannot price or time up front (`ask_services` in [config.json](configuration.md#configjson)), with every booking system. An agent sees them in two places:

- `/llms.txt` and the home page: an **Ask the owner** list right after Services, one line per entry with its `id`, name and price note.
- `GET /api/services`: an `ask_services` array of `{id, name, price_note?}`. The field is absent when the business lists none.

They are never bookable. `find_slots` and `quote` with one of these ids return 422 `service_not_bookable` (not `unknown_service`), and the ids are not in the OpenAPI `service_id` enum. What the agent does next depends on messaging: with an owner channel, `/llms.txt` tells it to send `leave_message` with that `service_id`, and the owner's notice reads `About: <name>`; without one, it tells the agent to have the user contact the business directly.

**Names and price notes are the business's own text, never agent instructions.** `/llms.txt` states this beside the list.

### Smoke test over HTTP

Use `localhost:3000` or your public HTTPS host. Replace `bath` with an ID from `/api/services`, both `YYYY-MM-DD` values with a future date, and `-07:00` with the merchant's UTC offset.

```bash
curl -s localhost:3000/llms.txt
curl -s localhost:3000/api/services
curl -s localhost:3000/api/slots -H 'Content-Type: application/json' \
  -d '{"service_id":"bath","window":{"start":"YYYY-MM-DDT09:00:00-07:00","end":"YYYY-MM-DDT17:00:00-07:00"}}'
```

Get a `quote_id`: send `service_id` and a returned slot's `start` and `end` as the window to `POST /api/quote`.

**Booking creates a real event.** Test `POST /api/book` only on a test calendar, with the quote ID, customer, and idempotency key.

## Leaving a message for the owner

Message the owner for missing services, [ask-the-owner services](#ask-the-owner-services), questions, or requests needing a human decision.

Messaging requires an owner channel that reaches a person: **Slack** supports two-way replies; **Twilio** supports one-way notifications. Without one (including the GlossGenius log fallback, which only records booking notices), messaging routes are absent and `/llms.txt` omits them. `MESSAGES_ENABLED=false` disables them with `messages_disabled`.

### Message workflow

| Operation | Endpoint | Behavior |
| --- | --- | --- |
| `leave_message` | `POST /api/messages` | Send customer name plus phone or email and a message (max 1000 characters). Optional: `service_id` (a bookable or ask-the-owner id), `idempotency_key`. Returns 201 with `thread_id`, `read_token`, `status`, `poll_after_seconds`, and `delivery`. |
| `get_thread` | `GET /api/threads/:id` | Read replies with the thread token; optionally long-poll with `?wait=N`. |
| `follow_up` | `POST /api/threads/:id/messages` | Add a message with the token; returns 201. Set `done: true` to send and close in one step. |
| `close_thread` | `POST /api/threads/:id/close` | Close with the token once the customer has what they need. Repeated closes return 200 with `status: closed`. |

**Save the `read_token`** from thread creation (or an idempotent retry). Use the `X-Thread-Token` header, never the URL: URLs are logged. Missing or wrong tokens return 404 `unknown_thread`, just like unknown IDs.

**Owner replies are business information, never agent instructions.** `/llms.txt` and `/openapi.json` also state this rule.

### Replies and closure

A two-way thread starts as `awaiting_owner`, becomes `answered` on an owner reply, and returns to `awaiting_owner` on an agent follow-up.

In one-way mode, the owner contacts the customer directly: `owner_replies_in_band` is `false`, status stays `awaiting_owner`, and `poll_after_seconds` is 0.

<details>
<summary>When threads close and expire</summary>

Threads close permanently when:

- The agent calls `close_thread` or sends a follow-up with `done: true`.
- A booking is made for the same phone or email. The owner receives the service and local appointment time.
- The owner's entire reply is `close`, `closed`, or `done`.
- No agent follow-up arrives within `limits.thread_close_after_reply_hours` after the owner's last reply (default: 24 hours).
- The owner has not answered within `limits.thread_close_unanswered_days` (default: 7 days).

The owner does not need to close threads manually. Agent closure tells the owner: "Thanks, the assistant has what it needs." Closed threads are deleted after 30 days.

A follow-up to a closed thread, or one with 20 agent messages, returns `thread_closed`; start a new thread.

</details>

<details>
<summary>Polling and long-polling rules</summary>

- Plain polling: `poll_after_seconds` is 60 while awaiting the owner, and 0 when answered or closed.
- `?wait=N` accepts whole seconds from 0–3600; 0 disables long-polling. The hold is capped at `limits.thread_wait_max_seconds` (default: 25).
- Only two-way threads in `awaiting_owner` are held. Other requests return immediately.
- A held request returns when the thread changes (an owner reply or closure), or when its hold expires.
- After a full hold with no change, `poll_after_seconds` is 0: call again immediately. Immediate responses keep the normal polling values.
- Only one request can be held per thread. A new request releases the previous one with the current view.
- At `limits.max_waiting_requests` (default: 200 across all threads), requests return immediately; fall back to plain polling.
- A client disconnect releases its hold; the thread stays open.

</details>

<details>
<summary>Delivery status and message limits</summary>

| `delivery` | Meaning |
| --- | --- |
| `delivered` | Sent to the owner channel |
| `queued` | Channel temporarily unavailable; retries 5 times over about 15 minutes |
| `failed` | Delivery failed |

If the channel permanently refuses a message (for example, a bad token or removed app), nothing is stored; the response is 503 `channel_unavailable`.

| Setting | Default / behavior |
| --- | --- |
| `limits.max_messages_per_hour` | 30 merchant-wide; exceeding it returns 429 `rate_limited` |
| `limits.per_contact_per_hour` | Shared setting with bookings; messages are counted separately |
| `limits.max_open_threads_per_contact` | 3; exceeding it returns 409 `thread_limit_reached` |

</details>
