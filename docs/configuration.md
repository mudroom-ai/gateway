# Configuration

Merchant data lives in `config.json`; secrets and switches come from environment variables. `npm run init` writes both. `npm start` loads `.env` if present (`node --env-file-if-exists`).

## config.json

Start from [`config.example.json`](../config.example.json). Fields:

| Field | Meaning |
|---|---|
| `merchant_id`, `name` | Identifier and display name (the name shows up in `llms.txt` and the booking page) |
| `timezone`, `currency` | IANA time zone and ISO currency for every time and price the gateway returns |
| `services[]` | `id`, `name`, optional `description`, `duration_min`, optional `buffer_min` (default 0, added after the appointment), `price_cents` |
| `ask_services[]` | Services the business offers but agents cannot book (no fixed price or duration): `id` (lowercase letters, digits and hyphens, up to 64), `name` (up to 80 characters), optional `price_note` (up to 60, the price in your own words, for example `from $80`). Plain single-line text: no backticks, angle brackets or markdown links (`](`). At most 50, default none; an `id` may not repeat one in `services[]`. Agents see them in `/llms.txt` and `GET /api/services` and can message you about one ([agents.md](agents.md#ask-the-owner-services)) |
| `hours` | Weekly opening windows per day (`mon` … `sun`), each a list of `{start, end}` in local time; an empty list means closed |
| `default_buffer_min` | Padding added after every busy interval already in the calendar before slots are searched; stacks with the service's `buffer_min` |
| `blackout_days[]` | Dates (`YYYY-MM-DD`) with no slots |
| `discounts[]` | `id`, `label`, `pct`, and any of `days_of_week`, `starts_within_hours`, `time_of_day` as conditions; all matching discounts apply |
| `max_total_discount_pct` | Cap on the combined discount |
| `floor_cents` | Lowest price a quote may reach |
| `quote_ttl_min` | How long a `quote_id` stays bookable |
| `limits` | `max_window_days` (default 14), `max_flexibility_min` (default 240), `connector_timeout_ms`, `per_ip_per_min`, `per_key_per_min`, `per_contact_per_hour`, `max_open_bookings_per_contact`, `max_messages_per_hour` (default 30, merchant-wide cap on new `leave_message` threads and follow-ups), `max_open_threads_per_contact` (default 3), `thread_close_after_reply_hours` (default 24, a thread the owner answered closes this long after the owner's last reply when the agent sends nothing more), `thread_close_unanswered_days` (default 7, a thread still waiting for the owner closes this long after the last agent message), `thread_wait_max_seconds` (default 25, 0 to 240, longest hold for `GET /api/threads/:id?wait=N`; 0 turns long-polling off), `max_waiting_requests` (default 200, held `get_thread` requests across all threads; over it a request answers at once) |
| `booking_enabled` | Default for the `book` kill switch (overridden by `BOOKING_ENABLED`) |
| `demo` | Default `false`. `true` turns the gateway into a public agent playground (overridden by `DEMO_MODE`); see [deploy.md §7](deploy.md#7-demo-mode-public-agent-playground). Leave it off for a real business |

In Square and GlossGenius mode `services`, `hours` and `discounts` are ignored (the platform's services, prices and open times are used); keep `name`, `timezone`, `currency` and `limits`. See [connectors/square.md](connectors/square.md) and [connectors/glossgenius.md](connectors/glossgenius.md).

`ask_services` applies with every booking system. If an entry's `id` is also the id of a bookable service from the platform, the bookable one wins and the entry is not shown.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `ALLOWED_HOSTS` | unset | Comma list of public/tunnel hostnames accepted in `Host`. **Required behind a tunnel** when `HOST` is loopback |
| `PUBLIC_URL` | unset | Public base URL (for example `https://gateway.example.com`) written into `/`, `llms.txt`, `openapi.json` and `robots.txt` when the gateway runs behind a tunnel or proxy whose `Host` header is not the public one |
| `CONFIG_PATH` | `config.json` | Falls back to `config.example.json` if missing, only when `NODE_ENV` is not `production`; in production (the Docker image) the server exits with a hint |
| `DB_PATH` | `gateway.sqlite` | SQLite file (quotes, bookings, idempotency keys, log, message threads, owner outbox). Must be on persistent storage: agents keep booking and thread ids across sessions |
| `BOOKING_ENABLED` | config value | Kill switch for `book` |
| `DEMO_MODE` | config `demo` (`false`) | `1`/`true` runs the public agent playground: the playground page at `/`, `GET /demo/feed`, `[demo]` event titles, bookings that cancel themselves after 60 minutes, a templated owner reply after 10 minutes without one, and extra booking and message caps. See [deploy.md §7](deploy.md#7-demo-mode-public-agent-playground) |
| `API_KEYS` | unset | Optional comma list of bearer keys (higher limits; when set, any other `Authorization` value gets 401; when unset the header is ignored) |
| `TRUST_CF_CONNECTING_IP` | `false` | Also honor `CF-Connecting-IP` from trusted peers. Only when the trusted proxy is cloudflared/Cloudflare |
| `TRUST_PROXY` | `loopback` | Which peers may set the client IP (`X-Forwarded-For`/`CF-Connecting-IP`) for per-IP limits: hop count, IP/CIDR list, or `false`. **Set it behind Docker or a PaaS**, see [deploy.md](deploy.md#client-ips-and-trust_proxy) |
| `TRUST_PROXY_DEBUG` | `false` | Log how each anonymous caller's IP was resolved, to check `TRUST_PROXY` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | unset | Service account key **contents** (one line: `jq -c . key.json`) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | unset | **Path** to the key file instead (what `npm run init` writes). If both are set, `_JSON` wins and a warning is logged |
| `GOOGLE_CALENDAR_ID` | unset | The merchant's calendar ID |
| `SQUARE_ACCESS_TOKEN` | unset | Square access token (buyer-level scopes). When set, Square is the booking system and the `GOOGLE_*` vars are ignored |
| `SQUARE_LOCATION_ID` | unset | The Square location to book at |
| `SQUARE_ENV` | `production` | `sandbox` for a Square sandbox test account |
| `SQUARE_REFRESH_TOKEN`, `SQUARE_APP_ID`, `SQUARE_APP_SECRET` | unset | Written by `npm run init`. With all three set the gateway renews the 30-day access token itself; without them it expires and `npm run init` must be run again |
| `GLOSSGENIUS_BOOKING_URL` | unset | GlossGenius shadow mode: the merchant's public booking page (`https://yourname.glossgenius.com`). Needs the `GOOGLE_*` vars too, where agent bookings are written. See [connectors/glossgenius.md](connectors/glossgenius.md) |
| `GLOSSGENIUS_MIN_LEAD_HOURS` | `48` | GlossGenius mode: no slot starts sooner than this many hours from now. Whole number, at least 1 |
| `TWILIO_ACCOUNT_SID` | unset | Owner SMS, any booking system: Twilio Account SID. See [connectors/twilio.md](connectors/twilio.md) |
| `TWILIO_AUTH_TOKEN` | unset | Owner SMS: Twilio Auth Token |
| `TWILIO_FROM` | unset | Owner SMS: the Twilio number it is sent from (E.164, e.g. `+12025550199`) |
| `OWNER_PHONE` | unset | Owner SMS: the merchant's mobile (E.164). Set all four `TWILIO_*`/`OWNER_PHONE` or none; with none, no texts are sent (GlossGenius mode logs the notice instead); a partial set stops startup |
| `SLACK_BOT_TOKEN` | unset | Slack owner channel, any booking system: Bot User OAuth Token (`xoxb-...`). See [connectors/slack.md](connectors/slack.md) |
| `SLACK_APP_TOKEN` | unset | Slack: app-level token (`xapp-...`) with `connections:write`, for Socket Mode |
| `SLACK_CHANNEL_ID` | unset | Slack: the channel (`C...`) the app is invited to. Set all three `SLACK_*` above or none; a partial set, or the two tokens swapped, stops startup |
| `SLACK_OWNER_USER_IDS` | unset | Slack: optional comma list of user ids (`U...`) whose thread replies count as the owner's. Unset means anyone in the channel |
| `MESSAGES_ENABLED` | `true` | Kill switch for `leave_message`, `get_thread` and `follow_up`. Only matters when an owner channel (Slack or Twilio) is configured; with none, or with only the GlossGenius log fallback, those routes are not offered at all. `false` answers them with `messages_disabled` |

The Slack owner channel (the first three `SLACK_*` vars) works with every booking system and wins over Twilio when both are set, because only Slack carries the owner's replies back to agents ([connectors/slack.md](connectors/slack.md)).

The owner SMS (the four `TWILIO_*`/`OWNER_PHONE` vars) works with every booking system: with it set, the merchant gets one text per agent booking, cancel and reschedule ([connectors/twilio.md](connectors/twilio.md)).

The booking system is selected by env vars, in this order: `SQUARE_ACCESS_TOKEN` set means Square; else `GLOSSGENIUS_BOOKING_URL` set means GlossGenius shadow mode (with the `GOOGLE_*` vars); else the `GOOGLE_*` vars alone mean Google Calendar. With none, the gateway exits at startup and says which to set.
