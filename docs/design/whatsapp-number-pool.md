# WhatsApp number pool: one chat per conversation

Oct 15, 2026 · Dennis Chia

## Summary

Give each customer conversation its own WhatsApp chat on the owner's phone by sending from a pool of numbers and routing replies by (receiving number, owner phone). The pool defaults to one number, which is today's behaviour; a merchant who adds numbers gets separate chats.

**Problem.** Every agent message reaches the owner from the same business number, so all customers' conversations mix in one chat. Today the owner must swipe to reply on the right message; a plain reply works only when one customer is waiting.

**Goals**

- One chat per open conversation, for up to N concurrent conversations, where N is the number of numbers in the pool.
- Exact reply routing with no quoting, codes or guessing inside a pooled chat.
- Graceful fallback to today's flat behaviour when the owner has more than N open.
- No change for merchants who keep a single number.

**Non-goals**

- More than one owner phone per merchant (teams share the business number through linked devices).
- Messaging customers directly; only the owner is ever written to.
- Telegram or other channels (tracked separately).

## Background

The current connector (`src/connectors/whatsapp.ts`) is a flat Communication connector on the Meta Cloud API. It sends from one `WHATSAPP_PHONE_NUMBER_ID` to `OWNER_PHONE` and binds replies in three ways:

1. A quoted reply carries `context.id`, which maps back to the conversation.
2. A plain reply goes to the single conversation awaiting the owner.
3. With several waiting, the owner gets one hint to swipe to reply, and the reply is not routed.

Outbound needs nothing new: `leave_message` arrives at the gateway API and becomes one Graph API call. Inbound is where routing happens: Meta delivers the owner's replies to `/webhooks/whatsapp`.

**Research findings** (October 2026)

- No product found lets an owner reply per customer from their own WhatsApp. Products that need separation move the owner to Slack threads, Telegram topics or a vendor inbox.
- WhatsApp exposes no threads or topics through the Cloud API. The Groups API needs Official Business Account status, caps groups at 8 members and joins by invite link only.
- One sender per conversation (number pooling) is the standard answer on SMS, for example Twilio Proxy. The number itself is the thread id.

## Design

A conversation holds one pool number for its life, and each number holds at most one open conversation. The owner is the only recipient, so concurrent conversations are capped at the pool size N.

**Routing key.** Meta's inbound webhook carries `metadata.phone_number_id` (the number the owner wrote to) and `from` (the owner). The pair (number, owner phone) maps to exactly one open conversation.

**Lifecycle**

1. **Assign.** On `leave_message`, pick a pool number with no open conversation. Prefer the number the owner messaged most recently, since its 24-hour window is likeliest open.
2. **Send.** Send from that number. Free-form text goes inside the window; outside it, the approved template.
3. **Reply.** The owner types in that chat. The webhook looks up (number, owner) and passes the reply to the conversation, as today.
4. **Release.** On owner `close`, agent close or expiry, the number is free again.
5. **Reuse.** Before the next conversation on that number, send a divider such as "New customer: Raj, haircut" so earlier messages are not mistaken for this one.

**Inbound resolution order**

1. (receiving number, owner phone) → open conversation on that number.
2. Quoted `context.id` → conversation (needed in the overflow chat).
3. Exactly one conversation awaiting the owner in that chat → it.
4. Otherwise send the "Which customer?" buttons, one per waiting conversation, carrying conversation ids. Never guess.

**Overflow.** When N conversations are already open, the new one goes to the most-used number in flat mode, which is today's behaviour on that one chat. Nothing fails; separation degrades only past N.

## Configuration

- `WHATSAPP_PHONE_NUMBER_ID` accepts a comma-separated list. One id (the default) is exactly today's behaviour.
- All numbers must be on the same WhatsApp Business Account, so they share the access token, app secret, webhook and approved template.
- `npm run init` gets an optional step to add more numbers. Setup otherwise stays as in `docs/connectors/whatsapp.md`.
- The owner should save each number as a contact ("Sam's Barbers 1", "Sam's Barbers 2", ...) so the chats are easy to tell apart.

## Data model and code changes

Two new tables, both durable: a lost assignment means a misrouted reply, so they must survive restarts and redeploys.

| Table | Key | Columns | Purpose |
| --- | --- | --- | --- |
| `wa_assignments` | (`number_id`, `owner_phone`) where status = open | `merchant_id`, `thread_id`, `status` (open, released), `opened_at`, `released_at` | Routes replies; at most one open row per key |
| `wa_windows` | (`number_id`, `owner_phone`) | `last_inbound_at` | Decides free-form text versus template |

The existing message id → thread map stays, for quotes in the overflow chat.

**Changes by file**

- `src/config.ts`: parse the number list. The all-or-nothing rule still applies.
- `src/connectors/whatsapp.ts`:
  - `openThread` assigns a number and sends from it.
  - `postToThread` sends from the thread's number.
  - The webhook resolves in the order in Design.
  - `checkAccess` runs for every pool number.
- `src/messages.ts`: the several-waiting hint becomes interactive buttons carrying thread ids; the core is unchanged otherwise.
- `src/cli/init.ts`: optional extra numbers.
- Store: the two tables, with a unique index on open assignments to prevent double-assignment under concurrent `leave_message` calls.
- Tests:
  - Pool of 1 must pass the existing `test/whatsapp.test.ts` unchanged.
  - New cases: assignment, release and reuse with divider, overflow, per-number windows, and button routing.

## Risks, limits and costs

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 24-hour window is per (number, owner) | First message on a cold number needs a paid template | Assign the warmest free number; utility templates are cheap |
| Chat names show the business, not the customer | Owner sees the business name N times | Owner saves numbered contacts; customer name first in every message |
| Numbers per business account | Vendors report about 2 before verification and 20 to 25 after; Meta's figure is unverified | A pool of 3 to 5 is enough for most owners |
| Number provisioning | Each number needs its own SIM or landline, a verification code and display-name review | One-off setup per number, documented in the connector guide |
| Stale assignment after a crash | Reply routed to a closed conversation | Durable store; release only on an explicit close or expiry event |
| Quote window | Quotes of messages older than about 7 days arrive without context (unverified for Meta) | Pooled chats do not rely on quotes |

**Cost.** The merchant pays for each extra number plus Meta's per-message fees for templates; replies inside the window are free. Merchants on one number pay nothing new.

## Alternatives considered

| Option | Separate chats | Owner stays in WhatsApp | Why not chosen |
| --- | --- | --- | --- |
| Quote routing only (today) | No | Yes | Plain replies stall when several customers wait; kept as fallback |
| "Which customer?" buttons | No | Yes | Two-step reply; adopted as the fallback, not the main path |
| Reference tags such as #A3 | No | Yes | Owners forget to type them; clutters every message |
| LLM guesses the conversation | No | Yes | A wrong guess leaks a reply to another customer |
| Groups API, one group per conversation | Yes | Yes | Needs Official Business Account status; invite link per conversation; 8 members max |
| Telegram private-chat topics | Yes | No | Strong option for owners willing to switch; separate connector |
| Slack threads | Yes | No | Already supported |

## Rollout and open questions

Each step ships on its own, and behaviour is unchanged until a merchant adds numbers.

1. **Pool abstraction, N = 1.** Introduce the number list and the two tables; existing tests pass unchanged.
2. **"Which customer?" buttons.** Replace the several-waiting hint. This helps every merchant, pooled or not.
3. **Multi-number pool.** Assignment, release, divider, per-number windows and overflow.
4. **Docs and init.** Number setup in `docs/connectors/whatsapp.md` and the `npm run init` step.

**Open questions**

- [ ] Recommended pool size in the docs: 3 or 5?
- [ ] Expiry for an idle assignment: 24 hours, 7 days, or tied to the thread's existing close rules?
- [ ] Confirm Meta's current cap on numbers per business account.
