# WhatsApp connector (owner messages over Meta's Cloud API)

## Overview

A **Communication** connector, a `CommunicationConnector` with every thread member (`src/connectors/whatsapp.ts`), like [Slack](slack.md): how the merchant hears from agents and answers them. It sits beside the Store or Calendar connector and works with **every booking system** (Google Calendar, Square, GlossGenius). Agent messages (`leave_message` and follow-ups) and booking notices arrive as WhatsApp messages on the owner's own phone, sent through the [WhatsApp Business Platform Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api), and the owner answers by typing a WhatsApp reply, which Meta delivers to Mudroom's webhook and Mudroom passes back to the agent (`get_thread`).

WhatsApp has no threads, so with one number the connector is **flat**: every customer shares one chat, the owner binds a reply to a question by **swiping to reply** on it (WhatsApp's quote), and a plain reply with no quote goes to the one conversation that is waiting for the owner. There are no codes to type.

With more than one number (a **pool**, see [Add more numbers](#add-more-numbers-one-chat-per-customer)), each customer conversation gets its own chat on the owner's phone, and the owner just types in it.

Like every Communication connector it never decides whether a booking happens; a failed notice is logged, never thrown.

## Prerequisites

- A [Meta for Developers](https://developers.facebook.com) account and a Meta app with the **WhatsApp** product added. Creating one takes minutes; it comes with a **test number** that can message up to 5 numbers you register, with no business verification and no template approval.
- The owner's phone with WhatsApp on it, as the one recipient (`OWNER_PHONE`).
- A **public HTTPS URL** for Mudroom ([deploy.md](../deploy.md)): Meta delivers the owner's replies to `https://<your host>/webhooks/whatsapp`. Slack needs no inbound URL; WhatsApp does. Put the public hostname in `ALLOWED_HOSTS` and set `PUBLIC_URL`.
- The host needs outbound HTTPS to `graph.facebook.com`.
- For a real business number later: Meta **business verification**, a phone number not already on a personal WhatsApp, a permanent **System User** access token, and one approved **utility template** (see *Limitations*).

## Setup

1. **Create the app.** Sign in at [developers.facebook.com/apps](https://developers.facebook.com/apps), click **Create app**, choose **Business** as the use case, name it and create it. Under **Add products**, click **Set up** on **WhatsApp**; pick or create a Meta Business Account when asked.
2. **Register the owner's phone as a recipient.** Open **WhatsApp → API Setup**. Under **To**, click **Manage phone number list**, add the owner's number and enter the code WhatsApp sends to it. (The test number can message up to 5 such numbers.)
3. **Copy the Phone number ID and a token.** On the same page copy the **Phone number ID** (a long number under the test number, not the phone number itself) and the **Temporary access token** (valid 24 hours; fine for a first test). For a token that does not expire, create a **System User** under **Business Settings → Users → System users**, assign it the app with full control and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. **Copy the App Secret.** Go to **App settings → Basic**, click **Show** next to **App Secret**. It signs every webhook delivery.
5. **Run `npm run init`.** Pick *Book appointments and message me* at the first question. After the booking system, pick *WhatsApp* at the "Owner channel" question, answer *Yes, I have these*, then give the owner's number (for example `+1 202 555 0199`), the Phone number ID, the access token and the App Secret; leave the template blank for now. The wizard writes them to `.env` (mode 600), generates `WHATSAPP_VERIFY_TOKEN`, checks the token against the number and prints the **Callback URL** and **Verify token** to paste into Meta.
6. **Start Mudroom** at its public URL (`npm start`, or deploy), then in the Meta app open **WhatsApp → Configuration**, click **Edit** under **Webhook**, paste the Callback URL (`https://<your host>/webhooks/whatsapp`) and the Verify token, and click **Verify and save**. Then click **Manage** under **Webhook fields** and **Subscribe** to `messages`. Meta calls Mudroom during *Verify and save*, so it must be running first.
7. **Open the 24-hour window.** From the owner's phone, send any message (for example "hi") to the test number shown under **From**. WhatsApp only lets a business send free-form text to a number that has messaged it in the last 24 hours; each message the owner sends restarts the clock. Without that, the first agent message needs a template (see *Limitations*).

Non-interactive, with any booking system (here Square):

```bash
npm run init -- --non-interactive --name "Sam's Barbers" --square \
  --owner-phone +12025550199 --whatsapp-token EAAx... --whatsapp-phone-id 123456789012345 \
  --whatsapp-app-secret 0123abcd... [--whatsapp-template agent_message:en_US]
```

Token, Phone number ID and App Secret are all-or-nothing (with `--owner-phone`); `--whatsapp-verify-token` is generated when omitted and kept on later runs. Each falls back to the env var of the same name (see *Env vars*).

### Add more numbers (one chat per customer)

With one number, every customer's conversation lands in the same chat. Add more business numbers and Mudroom sends each new conversation from a number that is free, so each customer gets their own chat.

1. **Use the same WhatsApp Business Account.** Every number must be on the account that holds the first one. They then share the access token, the App Secret, the webhook and the template, so there is nothing else to set. One webhook and the `messages` field cover every number.
2. **Add each number.** In **WhatsApp → API Setup**, click **Add phone number** (or use **WhatsApp Manager → Phone numbers**). Each number needs its own SIM or landline that is not on a personal WhatsApp, the verification code Meta sends to it by SMS or voice call, and Meta's review of its display name.
3. **Copy each Phone number ID** from **WhatsApp → API Setup** (pick the number under **From**).
4. **List them, comma-separated, primary first.** Give the list to `npm run init` at the Phone number ID question, or with `--whatsapp-phone-id 123456789012345,234567890123456,345678901234567`, or set `WHATSAPP_PHONE_NUMBER_ID` to it. The first is the primary: booking notices come from it. The startup check reads every number.
5. **Save each number as a contact** on the owner's phone with a number in the name: "Sam's Barbers 1", "Sam's Barbers 2", and so on. Every chat shows the business name, so the numbers are how the owner tells them apart.
6. **Open each 24-hour window.** Send "hi" to each number from the owner's phone, as in step 7.

We recommend 3 numbers to start. That gives three customers their own chat at once, and each extra number has a cost (see *Limitations*).

## Use cases

Through this connector an agent can:

- **Leave a message** for the owner (`leave_message`): it arrives on the owner's WhatsApp as one message with the customer's name and contact, the service, the text, and how to reply.
- **Get the owner's reply** (`get_thread`, long-poll): the owner swipes to reply on the message (or sends a plain reply when only one customer is waiting) and types an answer; Mudroom stores it and the agent's held `get_thread` returns it. The owner's message gets a ✅ reaction once stored.
- **Follow up** (`follow_up`): the agent's follow-up arrives as a new WhatsApp message; the owner can quote it or the original, both reach the same conversation.
- **Talk to each customer in their own chat** (with more than one number): each new conversation goes to a free number. Its first message says "Reply in this chat; it is only about this customer." When the number had an earlier customer, the first message says "This chat is now about <name>. Messages above are about another customer."
- **Reply without swiping**, in a chat that has only one open conversation:
  - A fresh chat (a number never used, or idle for 30 days) takes plain replies as soon as the agent's message has arrived.
  - A reused chat takes plain replies once the owner has read the new customer's message (WhatsApp's read receipt), swiped to reply on it, or picked it from the buttons. Until then the buttons ask, so a reply meant for the customer above never reaches the new one.
- **Pick the customer from buttons.** When Mudroom cannot be sure which customer a plain reply is for (a chat shared by several customers, or a reused chat the owner has not read yet), it answers in that chat with "Which customer?" and one button per customer there (a list for 4 to 10; above 10, the swipe-to-reply hint). One tap sends the reply to that customer. The question survives a restart and stays open for 24 hours; a tap after that, or on an unknown question, gets "Please send that reply again."
- **Quote to be exact.** A swipe-to-reply always goes to the quoted conversation, in any chat, reused or shared.
- **Close**: the owner types `close`, `closed` or `done` alone (quoting the conversation, or plain when one is waiting) to end it; a close notice from a booking arrives as a message.
- **Hear about bookings**: one WhatsApp message per agent booking, cancel and reschedule, in the same formats as [Twilio](twilio.md#use-cases); in GlossGenius shadow mode with the "add it by hand" note.

It cannot:

- Carry **images, voice notes or documents** from the owner: those get one "text only" reply and are not passed on. Reactions from the owner are ignored.
- Message **more than one** owner, or let anyone but `OWNER_PHONE` answer: messages from other numbers are dropped silently (logged once an hour per sender) and never answered, so the number cannot be used to spam strangers.
- Bind a reply **by quote to a message older than about 7 days**: WhatsApp then sends no quote, and the reply counts as plain.
- Guess at a quote it cannot place. A quote of a Mudroom notice, or of a follow-up sent before Mudroom last restarted, gets one reply asking the owner to quote the agent's own message instead; it is never routed to whichever customer happens to be waiting.
- **Message the customer.** Only the owner is ever written to.

## Limitations

- **24-hour window.** WhatsApp lets a business send free-form text only within 24 hours of the owner's last message to the number. Outside it, the connector sends the approved template named in `WHATSAPP_TEMPLATE` with the message text (newlines flattened) as its one `{{1}}` parameter; with no template it refuses the message with `channel_rejected` and a hint, and the agent sees delivery `failed`. For a test number, the owner just messages the number first. For production, create a **utility** template in **WhatsApp Manager → Message templates** with a body like `New message for {{1}}` (one parameter, no header or buttons) and set `WHATSAPP_TEMPLATE=<name>:<language>`; approval usually takes minutes to hours.
- **Needs a public URL.** Meta delivers replies over HTTPS to `/webhooks/whatsapp`. A Mudroom server on `localhost` without a tunnel gets no replies.
- **No catch-up read.** The Cloud API has no message history, so the connector cannot fetch replies it missed. It does not need to: Meta retries each delivery Mudroom did not answer with 2xx for up to 7 days, and Mudroom answers 500 when it cannot store a reply. A stop-then-start deploy loses nothing.
- **Duplicates after a lost answer.** There is no way to ask Meta whether a message was already sent, so a send whose answer was lost (timeout, crash) may be sent twice on the retry. Slack avoids this through message metadata; WhatsApp cannot.
- **Test number limits.** Up to 5 recipients, a fixed sender name, and the temporary token expires after 24 hours (use a System User token to keep it running). The test number is one number; a pool needs real numbers added to the account.
- **At most one separate chat per number.** With N numbers, at most N customers have their own chat at once. The next conversation shares the busiest chat (ties go to the primary), and there the owner swipes to reply or picks from the buttons.
- **When a number is reused.** A number is free again 60 seconds after its conversation closes, and only once its last messages (such as a close notice) have gone out. Mudroom picks a never-used number first, then the one idle longest.
- **Read receipts off.** If the owner has turned off read receipts in WhatsApp, Mudroom never learns the new customer's message was read, so the first plain reply in a reused chat asks which customer. One tap, or a swipe to reply, confirms the chat; later plain replies go straight through.
- **Cost of a pool.** Each extra number costs whatever its SIM or line costs. Each number has its own 24-hour window, so the first message on a number the owner has not written to in 24 hours goes out as the paid template. Preferring never-used and idle numbers keeps customers apart but sends more templates than reusing a busy number would; Mudroom favours separation.
- **Numbers per business account.** Meta's cap is unverified. Vendors report about 2 before business verification and 20 to 25 after.
- **Removing a number.** If a conversation is still open on a number you take out of the list, startup logs a warning and that conversation's messages go out from the primary.
- **Cost.** Messages within the window are free on the test number; on a production number Meta bills per conversation, and marketing templates always.
- **Slack wins.** When the `SLACK_*` vars are also set, Mudroom uses Slack and ignores the `WHATSAPP_*` vars with a warning at startup; WhatsApp in turn wins over Twilio.
- Messages are cut at 4096 characters (Meta's limit); the template parameter at 1000.

## Errors

The thread methods (`openThread`, `postToThread`) throw `ConnectorError`; `notify` and `acknowledge` only log. The agent sees them as the thread's `delivery` and the `leave_message` error codes described in [agents.md](../agents.md) and [errors.md](../errors.md).

| Code | When | What happens |
|---|---|---|
| `channel_unavailable` | Meta answered 429 or 5xx, one of its temporary error codes (1, 2, 4, 368, 80007, 130429, 131048, 131056), a timeout (10 s) or a network error | The core queues the message and retries; `retry_after_s` is 30 (300 for a temporary block, code 368) |
| `channel_auth_failed` | Meta answered 401/403, code 190 (token invalid or expired) or 10 / 200–299 (missing permission) | Permanent: Mudroom logs the hint (`WHATSAPP_ACCESS_TOKEN is invalid or expired: generate a new one ...`); at startup `checkAccess` exits with it |
| `channel_rejected` | Any other Meta refusal: the owner's number is not a test recipient (131030), free-form text outside the 24-hour window with no template (131047), a template that does not exist (132001) or has the wrong parameters (132000, 132012), a body Meta would not accept | Permanent for that message: `delivery` is `failed`, the agent is told so and keeps the customer's contact |

Webhook deliveries never raise errors toward agents. A wrong `hub.verify_token` on the handshake answers 403 and logs `WhatsApp webhook handshake refused: hub.verify_token does not match WHATSAPP_VERIFY_TOKEN`; a delivery with a bad or missing `X-Hub-Signature-256` answers 401 and logs `bad X-Hub-Signature-256 (is WHATSAPP_APP_SECRET the app's App Secret?)` and is not read; a reply the core could not store answers 500 so Meta sends it again.

- **Partial config fails startup.** Setting some but not all of the five vars stops Mudroom (and `npm run init`) with `WhatsApp is partly configured: set WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN too, or unset all of ...`, naming whichever are missing. A phone number in `WHATSAPP_PHONE_NUMBER_ID`, alone or in the list, is refused with a hint to copy the Phone number ID instead (`WHATSAPP_PHONE_NUMBER_ID must be numeric Phone number IDs from Meta app > WhatsApp > API Setup, not phone numbers ("+1 202 555 0199")`).
- **Startup check** (`checkAccess`) reads every sending number with the token; one failing number fails the check. Common failures: an expired temporary token (190), a Phone number ID from another app (100 / 33), a token without the WhatsApp permissions (10).

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | unset | Cloud API access token: the temporary one from **WhatsApp → API Setup** (24 hours) or a System User token. Secret. |
| `WHATSAPP_PHONE_NUMBER_ID` | unset | Phone number ID of the sending number (digits, from **API Setup**), not the number itself. One or more, comma-separated, for one chat per customer (`123456789012345,234567890123456`); spaces and repeats are dropped. The first is the primary: booking notices come from it. |
| `WHATSAPP_APP_SECRET` | unset | The Meta app's App Secret (**App settings → Basic**); signs every webhook delivery. Secret. |
| `WHATSAPP_VERIFY_TOKEN` | unset | Token Meta echoes when verifying the webhook URL. `npm run init` generates it; paste it into **WhatsApp → Configuration → Webhook**. |
| `WHATSAPP_TEMPLATE` | unset | Optional: approved utility template with one `{{1}}` body parameter, as `name` or `name:lang` (default `en_US`), for messages outside the 24-hour window. |
| `OWNER_PHONE` | unset | The owner's WhatsApp number with country code, e.g. `+12025550199`. Shared with [Twilio](twilio.md). |

Set the first four plus `OWNER_PHONE`, or none of the `WHATSAPP_*` vars. The webhook path is fixed: `/webhooks/whatsapp`.

## Tests

`test/whatsapp.test.ts` runs the channel against a scripted fake `fetch` (never the live Graph API) and calls the webhook handler directly with hand-signed bodies: the send shapes (text, template, reaction) and the Bearer header, the 4096 cut, the 24-hour window fallback to the template with flattened text and the `channel_rejected` hint without one, every `channel_*` code (expired token, missing permission, a recipient not on the list, 5xx/429/temporary codes/timeout/network), `checkAccess`, the handshake (right and wrong verify token), rejected and tampered signatures, a quoted reply mapping to the opener (also when the owner quotes a follow-up), a plain reply, a quote of a message nobody knows, strangers dropped without an answer, non-text messages and reactions, one notice for a rejected reply, 500 on a storage failure, 200 for status updates and other numbers, and the all-or-nothing env rule. The flat-channel behaviour of the core (opener wording, no mirror, the swipe hint) is in `test/messages.test.ts`; the webhook mount outside `/api` with the raw body in `test/http.test.ts`; the wizard's WhatsApp flags, generated verify token and printed callback URL in `test/init.test.ts`, with the comma list written normalised, a non-numeric element refused and one access check per number.

The number pool has its own tests: `test/wa-pool-store.test.ts` covers assignment (never-used first, the 60-second hold, an unsent message blocking reuse, overflow) and the stored "Which customer?" questions; pool cases in `test/whatsapp.test.ts` cover the routing rules (fresh and reused chats, read receipts, quotes, button taps) and the sending number for replies, notices and reactions; `test/messages.test.ts` covers the buttons' choices; `test/whatsapp-pool.e2e.test.ts` runs two numbers end to end against the real store.
