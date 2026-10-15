# Deploying gateway

One gateway process serves one merchant. It needs:

- a **persistent volume** for the SQLite file (quotes, bookings, idempotency keys, booking log, message threads and their read tokens, the owner outbox), and
- **exactly one replica**.

Both rules matter for correctness, not just tidiness:

- If the container is replaced without a volume, the SQLite file is lost. Open quotes disappear, and a client that retries `book` with the same idempotency key after a crash can no longer be matched to the event it already created. Worse for the merchant: agents remember booking ids and thread ids across sessions. When the file is gone, a cancel or reschedule for a real appointment answers `unknown_booking`, a poll for an open thread answers `unknown_thread`, and the agent tells the customer the business is down. (Seen in a live test: a redeploy without a volume left an appointment orphaned in Square.)
- Two replicas means two SQLite files and two processes that don't see each other's pending bookings. Retries can land on the other replica, and two agents can double-book the same slot. Don't autoscale, don't run blue/green with overlap, and set "max instances = 1" on platforms that have it. A brief stop-then-start during deploys is fine.

Sections:

1. [Google Calendar setup](#1-google-calendar-setup) (service account, share step, caveats; [Square](#1d-square-instead-of-google) and [GlossGenius](#1e-glossgenius-shadow-mode) variants)
2. [Run with Docker](#2-run-with-docker)
3. [Expose it over HTTPS with a tunnel](#3-expose-it-over-https-with-cloudflared)
4. [Hosting on a platform](#4-hosting-on-a-platform)
5. [Operations](#5-operations)
6. [Unsafe calendar sources](#6-unsafe-calendar-sources-delayed-feed-schedulers)
7. [Demo mode (public agent playground)](#7-demo-mode-public-agent-playground)

## 1. Google Calendar setup

The gateway reads free/busy and creates events with a **Google service account**. A service account key doesn't expire the way a testing-mode OAuth refresh token does (7 days). The merchant shares their calendar with the service account's email address.

### 1a. Self-hoster: create the service account and key

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **IAM & Admin → Service accounts → Create service account.** Any name works, for example `gateway`. It needs no project roles.
4. Open the service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. This is a secret. Don't commit it (`.gitignore` already ignores `service-account*.json`), and don't bake it into the image (`.dockerignore` excludes it).
5. Note the service account email, for example `gateway@my-project.iam.gserviceaccount.com`.

### 1b. Merchant: share the calendar

The merchant (the calendar owner) does this once:

1. Google Calendar on the web → hover the calendar → **⋮ → Settings and sharing**.
2. **Share with specific people or groups → Add people and groups →** paste the service account email.
3. Permission: **Make changes to events.** ("See all event details" is not enough, because `book` inserts events.)
4. Under **Integrate calendar**, copy the **Calendar ID**. For a personal primary calendar it's the owner's Gmail address. For other calendars it looks like `abc123@group.calendar.google.com`.

### 1c. Env vars

| Var | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The **contents** of the key file. Compact it to one line: `jq -c . key.json`. Best for Docker and platforms (secret store) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | The **path** to the key file, instead of `_JSON`. Handy outside Docker; `npm run init` writes this one. If both are set, `_JSON` wins and a warning is logged |
| `GOOGLE_CALENDAR_ID` | The Calendar ID from step 1b.4 |

Outside Docker, `npm run init` asks for the key path and Calendar ID, writes them to `.env` (mode 600; `npm start` loads it), checks access, and can optionally create and immediately delete a test event to prove write access.

If the key or calendar ID is unset, the gateway **exits at startup** with a message saying which variables to set. Every booking lands in a real calendar, demo mode included ([§7](#7-demo-mode-public-agent-playground)).

At startup the gateway checks calendar access and **exits with a fix message** if the calendar isn't shared or the key is bad, for example: `Share calendar "..." with gateway@... ("Make changes to events") and check GOOGLE_CALENDAR_ID.`

### Caveats

- **Google Workspace external sharing.** On a Workspace account (a business domain, not `@gmail.com`), the admin may block sharing calendars outside the domain. The service account's `*.iam.gserviceaccount.com` address counts as external. Fix: the Workspace admin allows external sharing with "Share all information, and outsiders can change calendars" (**Admin console → Apps → Google Workspace → Calendar → Sharing settings → External sharing options for primary calendars**), or the merchant uses a calendar where that's allowed. Changes can take a while to apply.
- **Org policy blocks key creation.** Newer Google Cloud organizations enforce `iam.disableServiceAccountKeyCreation`, so step 1a.4 fails with "Service account key creation is disabled". Fix: an org policy admin overrides that constraint for this project (**IAM & Admin → Organization policies**). Or create the project under a personal account with no organization.
- **Key hygiene.** Anyone with the key can edit the shared calendar. Keep it in your platform's secret store, rotate it by creating a new key and deleting the old one, and remove the share if you shut the gateway down.

## 1d. Square instead of Google

If the merchant books through Square Appointments, skip Google. Run `npm run init` on a machine with a browser, choose *Square Appointments*, and copy the `SQUARE_*` lines it writes to `.env` into your platform's variables (`SQUARE_ACCESS_TOKEN`, `SQUARE_REFRESH_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENV`, `SQUARE_APP_ID`, `SQUARE_APP_SECRET`). The OAuth redirect goes to `http://localhost:3099/callback` on that machine, so the Redirect URL registered in the Square Developer Console must be exactly that; the server itself never needs an inbound URL. With the refresh token, app id and secret present, the gateway renews the 30-day access token at startup and before it expires. See [connectors/square.md](connectors/square.md) for scopes and what changes in Square mode. The startup check verifies the token, the location and that at least one bookable fixed-price service exists.

## 1e. GlossGenius (shadow mode)

If the merchant books through GlossGenius, set up the Google Calendar share as in §1 (agent bookings are written there), then run `npm run init` and choose *GlossGenius*, or set `GLOSSGENIUS_BOOKING_URL` plus the `GOOGLE_*` vars, and optionally `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `OWNER_PHONE` for the owner text ([§1f](#1f-owner-sms-any-booking-system)). No inbound URL and no token renewal. The host needs **outbound HTTPS** to `*.glossgenius.com` (the booking page), `api.glossgenius.com` (services and availability) and `www.googleapis.com`/`oauth2.googleapis.com`; an egress allowlist that blocks any of these makes the startup check fail. The startup check reads the booking page and the calendar. See [connectors/glossgenius.md](connectors/glossgenius.md).

`/api/cancel` and `/api/reschedule` are not behind the per-contact guard that `/api/book` has; they need a 96-bit random `booking_id` plus the matching contact, and the per-IP limit still applies.

## 1f. Owner SMS (any booking system)

With any of the booking systems above, the merchant can get a text per agent booking, cancel and reschedule: pick *Book appointments and message me* in `npm run init` and choose *Twilio SMS* at the owner-channel step, or set all four of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `OWNER_PHONE` (a partial set stops startup). Keep the Auth Token in your platform's secret store. The host then needs **outbound HTTPS** to `api.twilio.com`; if an egress allowlist blocks it, bookings still succeed and each failed text is logged. See [connectors/twilio.md](connectors/twilio.md).

## 1g. WhatsApp owner channel (any booking system)

With any of the booking systems above, the merchant can get agent messages and booking notices on their own WhatsApp and answer by swipe-replying: pick *Book appointments and message me* in `npm run init` and choose *WhatsApp* at the owner-channel step, or set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `OWNER_PHONE` (optionally `WHATSAPP_TEMPLATE`). Unlike Slack it **needs an inbound URL**: Meta delivers the owner's replies to `https://<public host>/webhooks/whatsapp` (outside `/api`, no API key; each delivery is checked against `WHATSAPP_APP_SECRET`), so the gateway's public host must be in `ALLOWED_HOSTS` and `PUBLIC_URL` should be set so the wizard prints the right callback URL. The host needs **outbound HTTPS** to `graph.facebook.com`. Meta retries a delivery the gateway did not answer with 2xx for days, so a stop-then-start deploy loses no replies. The startup check reads the sending number with the token. See [connectors/whatsapp.md](connectors/whatsapp.md).

## 1h. Slack owner channel (any booking system)

With any of the booking systems above, the merchant can get agent messages and booking notices in a Slack channel and answer by typing in the thread: pick *Book appointments and message me* in `npm run init` and keep *Slack* at the owner-channel step, or set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_CHANNEL_ID` (optionally `SLACK_OWNER_USER_IDS`). It uses **Socket Mode**: the gateway opens an outbound WebSocket to Slack, so it needs **no inbound URL**, no tunnel route and no request signing secret. The host needs **outbound HTTPS and WSS** to `slack.com` and `wss-primary.slack.com` (Slack may hand out other `*.slack.com` hosts). Keep both tokens in your platform's secret store. Replies typed while the gateway is down or reconnecting are fetched when it reconnects, so a stop-then-start deploy loses none. The startup check verifies the bot token, the channel membership and the app token. See [connectors/slack.md](connectors/slack.md).

## 2. Run with Docker

Build the image:

```bash
docker build -t gateway .
```

The image runs `node dist/server.js` as the `node` user with these defaults:

| Var | Default in image | Meaning |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen on all interfaces inside the container |
| `PORT` | `3000` | |
| `CONFIG_PATH` | `/config/config.json` | Merchant config. The image runs with `NODE_ENV=production`, so if nothing is mounted there the server exits with a hint (the `config.example.json` fallback applies only outside production) |
| `DB_PATH` | `/data/gateway.sqlite` | SQLite file. `/data` **must be a persistent volume**, even for a test deployment that real agents will talk to |
| `ALLOWED_HOSTS` | unset | Comma list of public hostnames allowed in the `Host` header (see below) |
| `BOOKING_ENABLED` | from config (`booking_enabled`) | Kill switch. `false` makes `book` return `booking_disabled` |
| `API_KEYS` | unset | Optional comma list of bearer keys. Routes stay public. A valid key gets higher rate limits and an invalid key gets 401. When unset, the `Authorization` header is ignored |
| `TRUST_PROXY` | `loopback` | Which proxies may tell the gateway the caller's IP. See [Client IPs and `TRUST_PROXY`](#client-ips-and-trust_proxy). With Docker + cloudflared on the host use `uniquelocal` |
| `TRUST_PROXY_DEBUG` | unset | `true` logs how each anonymous caller's IP was resolved |

Run it:

```bash
cp config.example.json config.json   # then edit for the business
jq -c . service-account.json > /tmp/sa.min.json

docker volume create gateway-data

docker run -d --name gateway --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v gateway-data:/data \
  -v "$PWD/config.json":/config/config.json:ro \
  -e GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /tmp/sa.min.json)" \
  -e GOOGLE_CALENDAR_ID="owner@example.com" \
  -e ALLOWED_HOSTS="gateway.example.com,localhost,127.0.0.1" \
  gateway

curl -s localhost:3000/healthz        # {"ok":true}
docker logs gateway             # "[gateway] <name> listening on http://0.0.0.0:3000 (/api, /llms.txt)"
```

Notes:

- `-p 127.0.0.1:3000:3000` publishes the port on loopback only. The tunnel (section 3) is the public entrance.
- **`ALLOWED_HOSTS`** turns on `Host` header validation (DNS-rebinding protection). Put your public or tunnel hostname in it, plus `localhost,127.0.0.1` if you also call it locally. Requests with any other `Host` get rejected. If you leave it unset, the container accepts any `Host`, which is acceptable only behind a tunnel or proxy you control.
- If the volume's owner isn't `node` (uid 1000), for example with a bind mount, run `chown 1000:1000 <dir>` once. Otherwise SQLite can't create the file.
- Don't run two containers on the same volume (see "exactly one replica" above).
- Set `TRUST_PROXY` (next section). With the default, every tunnel caller looks like the Docker bridge address and shares one per-IP bucket.

Without Docker the same env vars work with `npm run build && npm start`, which also loads `.env` from the working directory if it exists (variables already set in the shell win). Note `HOST` defaults to `127.0.0.1` there. The Docker image runs `node dist/server.js` directly and never reads `.env`.

### Client IPs and `TRUST_PROXY`

Anonymous callers are rate limited per IP (`per_ip_per_min`; IPv6 per /64). Behind a tunnel or platform proxy, the TCP peer is the proxy, so the gateway has to read the caller's IP from `X-Forwarded-For` (or cloudflared's `CF-Connecting-IP`), and must only believe those headers from a proxy you trust. If it trusts too little, all callers share the proxy's bucket and one noisy agent gets everyone a 429. If it trusts too much, a caller can fake the header and dodge its limit.

Per-IP limits are a coarse guard, not the main one. In our tests, cloud agents such as Meta's Muse and Grok sent each request of a single booking from a different egress IP, so one agent never stays in one bucket. The per-contact limits (`per_contact_per_hour`, `max_open_bookings_per_contact`) and bearer keys are what actually bound a busy or abusive agent.

`TRUST_PROXY` uses [Express "trust proxy"](https://expressjs.com/en/guide/behind-proxies.html) semantics:

- a list of IPs, CIDRs or the names `loopback`, `linklocal`, `uniquelocal` (private ranges): trust peers at those addresses. `CF-Connecting-IP` is ignored unless you also set `TRUST_CF_CONNECTING_IP=true`, which is only safe when the trusted peer is cloudflared or Cloudflare (they overwrite the header). Behind nginx or Caddy, leave it off: they pass a caller's own `CF-Connecting-IP` straight through. `X-Forwarded-For` alone is enough for cloudflared.
- a number `N`: trust the nearest `N` hops, whatever their address. `CF-Connecting-IP` is ignored, since a PaaS proxy passes it through from the caller.
- `false`: trust nothing. The client IP is the TCP peer.
- `true` is rejected, because it would trust a caller-supplied `X-Forwarded-For`.

The startup log prints the effective value, for example `[gateway] trust proxy: loopback (...)`.

| Setup | `TRUST_PROXY` |
|---|---|
| Laptop + cloudflared (`npm start`, `HOST=127.0.0.1`) | `loopback` (the default, nothing to set) |
| Docker + cloudflared on the host (`-p 127.0.0.1:3000:3000`) | `uniquelocal`. Inside the container cloudflared's connection arrives from the Docker bridge (often `172.17.0.1`; Docker Desktop uses another private address). To pin it, put the exact `peer=` from the debug log here instead. Keep the port published on `127.0.0.1` only |
| Railway | `2`, **verified** on Railway. Railway's edge sends `X-Forwarded-For: <client>, <edge>` and drops any `X-Forwarded-For` the caller sent, so `1` would make every Railway edge node look like a separate caller |
| Fly.io | Probably `1` (Fly's proxy appends the client IP to `X-Forwarded-For`), **not verified**. Check it with the debug log below |

If you put Cloudflare's proxy (orange cloud) in front of a platform, that adds one hop.

**Check the value.** Start with `TRUST_PROXY_DEBUG=true`, then from a machine whose public IP you know (`curl -s https://ifconfig.me`) send a request with a fake header:

```bash
curl -s -H 'X-Forwarded-For: 203.0.113.99' https://<your-host>/api/services >/dev/null
```

The log shows `client ip: peer=... x-forwarded-for=... cf-connecting-ip=... -> <ip>`. The value is right when `<ip>` is your real public IP. If it's `203.0.113.99`, you trust too many hops (lower the number). If it's a proxy or private address, you trust too few (raise the number, or add the `peer=` address). Turn the debug log off afterwards.

## 3. Expose it over HTTPS with cloudflared

Cloud agents (Muse, Grok) can't reach `localhost`. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives the gateway a public HTTPS URL without opening ports. Install it with `brew install cloudflared` or a package from Cloudflare's docs.

### Quick tunnel (demo, no account)

```bash
cloudflared tunnel --url http://localhost:3000
# prints: https://<random-words>.trycloudflare.com
```

The hostname is random and changes on every run. cloudflared forwards the public `Host` header, so the gateway must allow that hostname:

1. Start cloudflared first and copy the hostname.
2. Start the gateway with `ALLOWED_HOSTS=<random-words>.trycloudflare.com,localhost,127.0.0.1`. With Docker, recreate the container with that `-e ALLOWED_HOSTS=...`. Without Docker: set `ALLOWED_HOSTS=...` in `.env` and restart `npm start` (or run `ALLOWED_HOSTS=... npm start`). The Next steps that `npm run init` prints already use this tunnel-first order, so a single `npm start` suffices.
3. Check: `curl -s https://<random-words>.trycloudflare.com/healthz`

A gateway running outside Docker with the default `HOST=127.0.0.1` and no `ALLOWED_HOSTS` only accepts `Host: localhost|127.0.0.1|[::1]`, so tunnel requests fail until you set `ALLOWED_HOSTS`.

Quick tunnels are for demos. They have no uptime guarantee, and the URL dies with the process. They also don't work for ChatGPT or Claude.ai: ChatGPT refuses `trycloudflare.com` links, so for those agents host the gateway on a real domain.

### Named tunnel (stable hostname)

You need a Cloudflare account with a domain on it:

```bash
cloudflared tunnel login
cloudflared tunnel create gateway
cloudflared tunnel route dns gateway gateway.example.com
cloudflared tunnel run --url http://localhost:3000 gateway
```

Set `ALLOWED_HOSTS=gateway.example.com,localhost,127.0.0.1`. To run it as a service, see `cloudflared service install` in Cloudflare's docs.

Agents then find the API at `https://gateway.example.com/llms.txt` (and `/openapi.json`). Nothing is installed on the agent side; the routes are public like a booking page, with rate limits, the per-contact open-booking cap, the booking log and `BOOKING_ENABLED` as the guardrails.

If agents can't reach it:

- `curl https://<your-host>/healthz` should return `{"ok":true}`.
- If you get 400 `invalid_request` with "Host not allowed", add the hostname to `ALLOWED_HOSTS`.
- Check `docker logs gateway` for the startup calendar check.
- Run the HTTP smoke test in [agents.md](agents.md#smoke-test-over-http) against the public URL.

## 4. Hosting on a platform

Any container host works if it gives you **a persistent volume and a hard cap of one instance**. In platform terms:

- Mount a volume at `/data` (or set `DB_PATH` to a file on the volume).
- If the platform mounts volumes owned by root, the image's `node` user can't write to it and SQLite fails to create its file. Either run the container as root (on Railway: `RAILWAY_RUN_UID=0`) or have the platform mount it as uid 1000. The startup log warns if `DB_PATH` isn't on a volume at all.
- Railway (verified): `railway volume add --mount-path /data`, then `railway variables --set RAILWAY_RUN_UID=0`, then redeploy. The startup warning about the container filesystem disappears once the volume is mounted.
- Set instances/replicas to 1 and turn autoscaling off. Use a "recreate"/stop-first deploy strategy if the platform offers one, so the old and new containers never write the SQLite file at the same time.
- Put `GOOGLE_SERVICE_ACCOUNT_JSON` in the platform's secret store, not in the config file or the image.
- Provide `config.json` by mounting it at `/config/config.json`, or put it on the volume and set `CONFIG_PATH=/data/config.json`.
- Set `ALLOWED_HOSTS` to the platform's public hostname.
- Set `TRUST_PROXY` to the platform proxy's hop count and verify it (see [Client IPs and `TRUST_PROXY`](#client-ips-and-trust_proxy)). The default `loopback` makes every caller share one rate-limit bucket.
- Health check path: `GET /healthz`.

Serverless/scale-to-zero platforms that may run several instances, or that give each instance its own ephemeral disk, are **not** suitable.

## 5. Operations

- **Kill switch:** set `BOOKING_ENABLED=false` and restart. `book` then returns `booking_disabled`, while `find_slots` and `quote` keep working.
- **Backups:** the SQLite file runs in WAL mode, so `gateway.sqlite` alone isn't a consistent copy while the gateway runs. Stop the container, then archive the whole volume: `docker run --rm -v gateway-data:/data -v "$PWD":/backup busybox tar czf /backup/gateway-$(date +%F).tgz -C /data .`. Start the container again afterwards.
- **Upgrades:** `docker build`, `docker stop gateway && docker rm gateway`, then the same `docker run`. The volume keeps quotes, bookings, idempotency keys and message threads.
- **Concurrency:** `book` calls for the same customer contact run one at a time in-process, so the open-booking cap holds under concurrent requests. Quotes don't hold slots. With one process, two agents booking overlapping slots at the same instant can still both succeed (a per-merchant lock to guard concurrent `book` calls is planned). This is another reason to never add a second replica.

## 6. Unsafe calendar sources: delayed-feed schedulers

The gateway is only as correct as the busy times in the Google Calendar it reads. **Don't point it at a calendar that a booking tool fills through a delayed iCal/ICS feed.**

**GlossGenius** is the known case. Its Google link is an iCal feed that can lag **up to 24 hours**. Events that the gateway writes to Google sync back only to the GlossGenius mobile app, and nothing confirms that they block GlossGenius online booking. A gateway on top of that calendar can double-book in both directions:

- A client books in GlossGenius, and the gateway still sees the time as free for hours.
- The gateway books, and GlossGenius keeps offering the slot online.

Treat any scheduler that syncs to Google by subscription feed rather than by direct two-way API the same way. A safe setup is one where Google Calendar **is** the source of truth: appointments are created there, or by a tool that writes to it immediately.

For a GlossGenius merchant, use the [GlossGenius connector](connectors/glossgenius.md) instead ([§1e](#1e-glossgenius-shadow-mode)): it reads availability straight from the booking page, writes agent bookings to a separate shared calendar, keeps a 48-hour minimum lead time and texts the merchant to add each booking to GlossGenius.

## 7. Demo mode (public agent playground)

Demo mode runs a gateway as a public playground: anyone can tell their own agent to book with a pretend business and watch what happened. The project's live one is [demo.mudroom.dev](https://demo.mudroom.dev). Never turn it on for a real business.

Turn it on with `"demo": true` in `config.json` or `DEMO_MODE=1` (the env var wins). With it off, nothing below happens. With it on:

- **`/` in a browser is the playground page**: the business name, one prompt to copy into an agent, counters (agents today and this week, bookings made, by vendor) and a feed of the last 10 agent requests. The page polls `GET /demo/feed` every 5 seconds. Agents fetching `/` without `Accept: text/html` still get the markdown instructions, and `/llms.txt` gains a short "This is a playground" section.
- **`GET /demo/feed`** is public JSON, rate-limited per IP like the discovery pages (`per_ip_per_min`). Each item is a vendor (`muse` or `grokbot`: the playground supports only Muse and GrokBot, and any caller not recognised as GrokBot counts as Muse), a request kind (`services`, `slots`, `quote`, `book`, `cancel`, `reschedule`, `message`), an outcome (`ok` or an error code) and a timestamp. It never carries names, phone numbers, emails, message text, ids or IPs.
- **Vendor counting** reads the user-agent, then an `X-Agent-Name` header that the playground's `llms.txt` asks agents to send. Agents that call from a code sandbox (Muse, GrokBot) send a plain `curl` user-agent, so GrokBot needs that header to be counted as GrokBot; everything else counts as Muse. Each `/api` request is stored in the `agent_requests` table (time, vendor, kind, outcome, and a visitor hash of IP plus user-agent under a salt kept only in memory and changed every UTC day, so agents can be counted per day but not traced). Rows older than 30 days are deleted.
- **Calendar events are titled `[demo] <service> - <name>`**, and every booking cancels itself **60 minutes after it was made**: the event is deleted and the booking marked cancelled. The schedule is the bookings table, so a restart loses nothing: the gateway checks at boot and then every minute.
- **Owner away**: when an owner thread gets no reply for **10 minutes**, the gateway stores and posts a templated owner reply ("Thanks, the human owner is away from the desk right now, this is a playground; your booking still goes through") so the agent is never left waiting. A real reply from Slack still comes through afterwards.
- **Extra caps**, on top of the normal limits: 10 bookings per IP per day, 30 bookings per vendor per hour, and 30 messages (new threads and follow-ups) per IP per day. Over a cap, the request gets `rate_limited` with `retry_after_s`. Cloud agents may share egress IPs, so the per-IP caps are deliberately loose.

Run a playground as its own service with its own calendar and its own Slack app. Slack Socket Mode spreads events across every connection that uses the same app token, so two gateways on one Slack app would each miss some owner replies.
