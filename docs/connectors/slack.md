# Slack connector (owner channel with replies)

## Overview

A **Communication** connector: a `CommunicationConnector` with every thread member (`src/connectors/slack.ts`, Socket Mode client in `src/connectors/slack-socket.ts`). It works with **every booking system** (Google Calendar, Square, GlossGenius) and does two jobs in one Slack channel the merchant picks:

- **Booking notices.** One message per agent booking, cancel and reschedule, the same text the Twilio connector sends ([twilio.md](twilio.md#use-cases)).
- **Two-way threads.** When an agent leaves a message for the business (`leave_message`), the gateway posts it to the channel. The owner answers by **typing a reply in that message's thread**; the gateway stores the reply, adds a ✅ reaction so the owner knows it arrived, and the agent reads it with `get_thread`. The owner never has to end a conversation: the agent closes the thread when the customer has what they need, a booking by the same customer closes it, and an answered thread closes by itself after 24 quiet hours.

Inbound replies arrive over Slack **Socket Mode**: the gateway opens an outbound WebSocket to Slack, so it needs no public URL, no tunnel route and no signing secret. It uses Node's built-in `WebSocket`; there is no Slack SDK dependency.

Delivery survives restarts in both directions, with the six bot scopes from the manifest below:

- **Replies typed while the gateway was down are picked up.** Socket Mode does not replay events, so on every connect (start, redeploy, reconnect) the gateway reads the channel and each open thread since the last message it handled (`conversations.history`, `conversations.replies`) and treats what it finds like a live reply: stored once, ✅ added, the agent's `get_thread` answers.
- **A message is posted once.** Every agent message carries an invisible key as Slack message metadata. Before any retry (after a timeout, a Slack error or a crash mid-send) the gateway looks for that key in the channel and posts only if the message is not already there.

When both Slack and Twilio are configured, Slack wins (only it can carry replies) and the gateway logs a warning.

## Prerequisites

- A Slack workspace where the merchant (or whoever runs the gateway) may **create and install apps**.
- A channel for agent messages. A **private channel** with only the owner and the app is the safest choice (see *Limitations*).
- The host needs outbound HTTPS and WSS to `slack.com` and `*.slack.com` ([deploy.md](../deploy.md#1g-slack-owner-channel-any-booking-system)).
- Node >= 22.4 (built-in `WebSocket`); the gateway already requires 22.13.

## Setup

1. **Create the app from a manifest.** Go to [api.slack.com/apps](https://api.slack.com/apps), click **Create New App**, choose **From a manifest**, pick your workspace, select **JSON** and paste this. It sets the bot scopes, the event subscriptions and Socket Mode in one step:

   ```json
   {
     "display_information": {
       "name": "Agent desk",
       "description": "Messages from AI agents acting for customers"
     },
     "features": {
       "bot_user": { "display_name": "Agent desk", "always_online": true }
     },
     "oauth_config": {
       "scopes": {
         "bot": ["chat:write", "channels:history", "groups:history", "channels:read", "groups:read", "reactions:write"]
       }
     },
     "settings": {
       "event_subscriptions": { "bot_events": ["message.channels", "message.groups"] },
       "socket_mode_enabled": true,
       "org_deploy_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```

   Click **Next**, then **Create**. (No Request URL is needed: Socket Mode delivers events over an outbound websocket.)
2. **Generate the app-level token.** A manifest cannot create tokens. Open **Basic Information**, scroll to **App-Level Tokens**, click **Generate Token and Scopes**, name it `gateway`, add the scope `connections:write` and click **Generate**. Copy the token that starts with `xapp-`: this is `SLACK_APP_TOKEN`.
3. **Check the manifest took** (optional). **OAuth & Permissions** lists the six bot scopes, **Event Subscriptions** the two bot events, and **Socket Mode** is on. To build the app by hand instead, pick **Blank app** and set those three screens yourself.
4. **Install it.** Open **Install App** and click **Install to Workspace**, then **Allow**. Copy the **Bot User OAuth Token** that starts with `xoxb-`: this is `SLACK_BOT_TOKEN`. If you change scopes later, click **Reinstall to Workspace**.
5. **Invite the app to the channel.** In Slack, open the channel and type `/invite @Agent desk` (your app's name).
6. **Copy the channel ID.** Click the channel name at the top; at the bottom of the **About** tab, copy the **Channel ID** (starts with `C`): this is `SLACK_CHANNEL_ID`.
7. **Optional: owner user IDs.** To make only certain people's replies count, open each person's profile, click **⋮** and **Copy member ID** (starts with `U`). Comma-separate them in `SLACK_OWNER_USER_IDS`.
8. **Run `npm run init`.** Pick *Book appointments and message me* at the first question. After the booking system is connected, the "Owner channel" question has *Slack* selected; press Enter, answer *Yes, I have these* to "Ready to connect?" and paste the bot token, the app token, the channel ID and (optionally) the owner IDs. The wizard writes them to `.env` (mode 600) and runs the access check below.

Non-interactive, with any booking system (here Square from env):

```bash
npm run init -- --non-interactive --name "Sam's Barbers" --square \
  --slack-bot-token xoxb-... --slack-app-token xapp-... --slack-channel C0123ABCD \
  --slack-owner-ids U0123ABCD
```

The first three flags are all-or-nothing; each falls back to the env var of the same name (see *Env vars*). The access check (wizard and every `npm start`) calls `auth.test` (bot token), `conversations.info` (channel exists, app is a member, not archived) and `apps.connections.open` (app token and Socket Mode).

## Use cases

What an agent can do end to end through this channel:

- **Leave a message** for the business when it cannot book (a question, a request outside the services), and **check back** for the owner's typed answer with `get_thread`. Follow-ups from the agent land in the same Slack thread.
- **Get the answer after a redeploy.** A reply the owner typed while the gateway was stopped or reconnecting arrives when it is back; the agent keeps polling the same thread.
- **Get the owner's decision in plain words.** The owner types free text; there are no buttons, forms or reply codes.
- **Get the answer even when the owner posts in the channel instead of the thread.** If exactly one conversation is waiting for the owner, a new top-level message in the channel counts as its reply: it gets the ✅ and the gateway copies it into that thread ("Reply from the owner: ...") so the conversation reads in one place.
- Every agent **booking, cancel and reschedule** also posts a notice to the channel.
- **Close the thread when done.** The agent calls `close_thread` (or `follow_up` with `done: true`) once the customer has what they need, and the owner sees "Thanks, the assistant has what it needs." in the thread. When the agent books for the same phone or email, the customer's open threads close with a notice naming the service and local time.

What it cannot do:

- **Book, cancel or reschedule** anything: those go through the booking system; the channel only reports them.
- **Reach the customer.** Messages go to the merchant only.
- **Push the reply to the agent.** The agent has to poll `get_thread`; agents are told to ask the user to check back later.
- **Treat the owner's text as instructions.** Agents are told the reply is information from the business, not a command.

## Limitations

- **Replies during downtime arrive late, with three exceptions.** A reply typed while the gateway is stopped, restarting or reconnecting gets its ✅ when the gateway is back. Not picked up: a reply in a thread that closed before the gateway came back; a top-level message, unless exactly one conversation is waiting and no conversation has opened, closed, been answered or received a follow-up since about when it was typed (otherwise it might be the answer to another customer, so it is left alone and no hint is posted); and top-level messages in a channel with more than 2,000 messages since the gap began (thread replies are still fetched). If the catch-up read fails, the gateway retries every 30 seconds and `/healthz` shows `Slack catch-up failed` until it succeeds.
- **A retry never posts twice, and stops rather than guess.** If the gateway cannot check whether an earlier attempt reached Slack (a failed read, or more than 2,000 messages to look through), it does not post; only a message from this app's own bot counts as the earlier attempt; after the usual five retries the message is marked failed and the agent sees `delivery: "failed"`. Booking notices, the closing line and the copy of a top-level reply are sent once without this check.
- **Anyone in the channel counts as the owner** unless `SLACK_OWNER_USER_IDS` is set. Use a private channel with only the owner, or set the allowlist; with it set, a reply from someone else gets one notice in the thread and is not passed on.
- **Threads close without the owner.** The agent closes a thread, a booking for the same contact closes it, or it closes by itself: `limits.thread_close_after_reply_hours` (default 24) after the owner's last reply with no agent follow-up, or `limits.thread_close_unanswered_days` (default 7) while still waiting for the owner. A reply typed in a closed thread gets one notice that the agent will not see it. If an owner types `close`, `closed` or `done` as the whole reply, the thread closes quietly.
- **Top-level messages count only when one conversation is waiting.** The opener asks the owner to reply in the thread. A top-level message counts as the reply only while exactly one thread is waiting for the owner. With several waiting, the gateway posts "Several customers are waiting; please reply in the thread for each." in the channel (at most once a minute) and ignores the message; with none waiting, it ignores the message silently. A top-level message from someone outside `SLACK_OWNER_USER_IDS` is ignored silently. Edits, deleted messages and files without text are always ignored.
- **One channel per gateway.**
- **Plain text only.** Every message is escaped (`&`, `<`, `>`) before it is posted, so text from customers or agents cannot ping `@channel`, fake a mention or make a link; link previews are off.
- **No retry for notices.** A failed booking notice is logged, never retried; agent messages that hit a temporary Slack failure are queued and retried by the core.
- Slack's own limits apply: about one message per second per channel, and very long messages are refused (`msg_too_long`).

## Errors

Thread methods (`openThread`, `postToThread`) throw these `ConnectorError` codes; the core turns them into the shared error body. `notify` and the ✅ reaction never throw: failures are logged.

| Code | When | What happens |
|---|---|---|
| `channel_unavailable` | Slack answers HTTP 429 (uses `Retry-After`), 5xx, times out (10 s), or returns `fatal_error`, `internal_error`, `ratelimited`, `service_unavailable`, `request_timeout`. | Transient: the core stores the message and queues the send; the agent gets `delivery: "queued"`. `retry_after_s` is set (30 s when Slack gives none). |
| `channel_auth_failed` | `invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`, `not_in_channel`, `channel_not_found`, `is_archived`, `missing_scope`, `no_permission`; also a bad app token at `apps.connections.open`. | Permanent: nothing is stored and the agent is told the business cannot be reached. The message carries the fix below. |
| `channel_rejected` | Any other `ok:false` error (for example `msg_too_long`), or a response without JSON. | Permanent, not retried. |

Fix hints (startup check, wizard and logs):

- `SLACK_BOT_TOKEN is wrong or revoked: copy the Bot User OAuth Token (xoxb-...) from OAuth & Permissions in your Slack app`
- `invite the app to the channel (type /invite @<your app> in it), then check SLACK_CHANNEL_ID is that channel's ID (C...)`
- `the channel in SLACK_CHANNEL_ID is archived: unarchive it or pick another channel`
- `the bot token lacks a scope (<scope>): add it under OAuth & Permissions, then click Reinstall to Workspace`
- `SLACK_APP_TOKEN must be an app-level token (xapp-...) with the connections:write scope, and Socket Mode must be turned on in your Slack app`

Startup also stops with a plain error when only some of the three required vars are set (`Slack is partly configured: set SLACK_APP_TOKEN, SLACK_CHANNEL_ID too, ...`) or when a token has the wrong prefix (the two tokens swapped). At startup a setup error (`channel_auth_failed`) stops the gateway with the hint above and exit code 1; a Slack outage (`channel_unavailable`) only logs a warning, the gateway boots, and the socket keeps reconnecting. A bad app token at runtime stops the Socket Mode client (no retry loop) and shows in `status()`; a dropped connection reconnects on its own with backoff from 1 s to 60 s.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | unset | Bot User OAuth Token, `xoxb-...` (**OAuth & Permissions**). Secret. |
| `SLACK_APP_TOKEN` | unset | App-level token with `connections:write`, `xapp-...` (**Basic Information → App-Level Tokens**). Secret. |
| `SLACK_CHANNEL_ID` | unset | The channel the app is invited to, `C...` (channel **About** tab). |
| `SLACK_OWNER_USER_IDS` | unset | Optional comma list of member IDs (`U...`) whose replies count as the owner's. Unset means anyone in the channel. |

Set the first three or none. With Slack set, the `TWILIO_*`/`OWNER_PHONE` vars are ignored. `MESSAGES_ENABLED=false` (see [configuration.md](../configuration.md)) turns off `leave_message` and the thread routes while keeping booking notices.

## Tests

`test/slack.test.ts` runs the connector against a scripted fake `fetch` for the Web API and an in-process fake Socket Mode server (a `WebSocket` constructor injected through the options), never the live Slack API. It covers: `chat.postMessage` returning the `ts` as the thread handle and thread replies; the dedupe key sent as message metadata and `findPosted` reading it back from the channel or the thread with `include_all_metadata`, another app's message with the same key not counting, and a failed or too-large read throwing `channel_unavailable`; the catch-up on `hello` (missed thread replies and a top-level message handed to the core once each, oldest first, before `start()` resolves; the cursor moved by live events; a failed read retried and shown in `status()`; the stored cursor held at the start of the gap while catch-up is failing; a thread Slack no longer has skipped, any other thread read failure ending the pass with the cursor unmoved); escaping of `<!channel> <@U1> &` with unfurls off; 429 with `Retry-After`, 5xx, timeout and `internal_error` as `channel_unavailable`; `invalid_auth`, `not_in_channel`, `channel_not_found`, `is_archived` and `missing_scope` as `channel_auth_failed` with their hints; an unknown error as `channel_rejected`; `notify` and the reaction logging instead of throwing; the three `checkAccess` hints; `hello` before `start()` resolves; the envelope acked only after the reply handler resolves and never when it throws, with no ✅ unless the core calls `acknowledge`; Slack entities in the owner's text unescaped; messages with a subtype, a `bot_id` or another channel ignored, in a thread or top-level; a top-level human message passed to the core with no `provider_ref`; a stranger's top-level message ignored silently under the allowlist; the owner's text passed through unchanged (the core decides what it means); the owner allowlist notice once per thread; the closed-thread notice and the generic notice for other rejections; a transient first connect failure rejecting `start()` while reconnecting in the background; reconnect after a `disconnect` envelope; no retry on a bad app token; and the env rules of `createSlackChannel`. `test/messages.test.ts` covers the core side of delivery (a timed-out send found on the retry and not posted again, a follow-up left mid-send by a crash looked up in its thread, a retry that posts when nothing is found, a lookup that keeps failing ending in `failed` with nothing posted) and of top-level messages (one fetched after a gap accepted only when no thread changed since it was typed, a queued opener reaching the channel counting as a change) against a fake channel: one waiting thread accepts, acknowledges and mirrors it; several waiting post one hint a minute and store nothing; none waiting ignores it; redelivery is deduped. `test/init.test.ts` covers the wizard's Slack flags, partial set, interactive step and `--help`.
