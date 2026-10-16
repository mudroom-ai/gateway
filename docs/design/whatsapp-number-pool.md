# WhatsApp number pool: one chat per conversation

Oct 15, 2026 · Dennis Chia

## Summary

Give each customer conversation its own WhatsApp chat on the owner's phone by sending from a pool of numbers and routing replies by (receiving number, owner phone). The pool defaults to one number, which is today's behaviour; a merchant who adds numbers gets separate chats.

**Problem.** Every agent message reaches the owner from the same business number, so all customers' conversations mix in one chat. Today the owner must swipe to reply on the right message; a plain reply works only when one customer is waiting.

**Goals**

- One chat per open conversation, for up to N concurrent conversations, where N is the number of numbers in the pool.
- Exact reply routing with no quoting, codes or guessing inside a pooled chat once the owner has seen its opener; a "Which customer?" picker otherwise.
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

A conversation holds one pool number for its life. While the pool has a free number, each number holds at most one open conversation. The owner is the only recipient, so separate chats are capped at the pool size N.

**Routing key.** Meta's inbound webhook carries `metadata.phone_number_id` (the number the owner wrote to) and `from` (the owner). The pair (number, owner phone) names a chat, not a conversation. It identifies one conversation only when that chat has exactly one open conversation and the owner has seen its opener. Two cases break the pair on its own:

- **Reuse.** A chat on a reused number still shows the earlier customer's messages. A plain reply typed before the owner saw the new opener may answer the earlier customer.
- **Overflow.** Past N, a chat holds several open conversations.

So a plain reply routes by number only when the assignment is *active*:

- **Fresh number** (never carried a conversation to this owner): the reply was sent at least 5 s after Meta accepted the opener.
- **Reused number:** before sending the reply, the owner read the opener (Meta `read` status on the opener or a later message in that conversation), quoted a message of it, or picked it in the picker.

**Lifecycle**

1. **Assign.** On `leave_message`, pick a free number. A number is free when it has no open conversation, its last one closed at least 60 s ago, and nothing of it is left in the outbox, so a late close notice never lands after the next opener. Prefer a never-used number, then the one released longest ago, then the one the owner wrote to most recently (its 24-hour window is likeliest open).
2. **Send.** Send from that number. Free-form text goes inside the window; outside it, the approved template.
3. **Reply.** The owner types in that chat. The webhook resolves the conversation as below and passes the reply to it, as today.
4. **Release.** When the conversation closes (owner `close`, agent close or the existing thread expiry), the number is free again after the hold above.
5. **Reuse.** A reused number's opener starts with "This chat is now about <customer>. Messages above are about another customer." A number stays reused for good, even after its old conversations are purged, because the chat still shows them.

**Inbound resolution order**

1. **Quoted `context.id`** → that conversation. A quote is exact, so it comes first. A quote the gateway cannot place gets a notice to swipe to reply on the agent's message, and never falls through to number routing.
2. **Plain reply, one open conversation in this chat, assignment active** → that conversation.
3. **Otherwise** the reply is handed to the core scoped to this chat's open conversations. The core never auto-matches a scoped reply; it asks "Which customer?" in the same chat:
   - 3 or fewer choices: reply buttons, one per conversation.
   - 4 to 10: a list message (Meta allows at most 3 buttons and 10 list rows).
   - More than 10, or Meta refuses the picker: the flat hint to swipe to reply on each customer's message, so every conversation stays reachable by quote.

   The reply waiting for a tap is stored, so a restart between the question and the tap loses nothing, and a tap Meta redelivers is replayed and deduplicated by the core. A pick also confirms the assignment, so later plain replies in that chat go straight through.

Never guess. A single number (N = 1) uses step 1, then the core's existing match to the one conversation awaiting the owner, then the picker.

**Overflow.** When no number is free, the new conversation goes to the chat with the most open conversations, which is today's flat behaviour on that one chat. Its opener keeps the flat text. Replies there resolve by quote or the picker, never by number alone. Nothing fails; separation degrades only past N.

## Configuration

- `WHATSAPP_PHONE_NUMBER_ID` accepts a comma-separated list; the first is the primary (notices, conversations from before the pool). One id (the default) is today's behaviour.
- All numbers must be on the same WhatsApp Business Account, so they share the access token, app secret, webhook and approved template.
- A pool needs `WHATSAPP_TEMPLATE`, because a new number's first message is always outside the 24-hour window. It also needs the gateway's database, which `npm start` opens.
- `npm run init` gets an optional step to add more numbers. Setup otherwise stays as in `docs/connectors/whatsapp.md`.
- The owner should save each number as a contact ("Sam's Barbers 1", "Sam's Barbers 2", ...) so the chats are easy to tell apart.

## Data model and code changes

Four new tables, all durable: a lost assignment or pending question means a misrouted or lost reply, so they must survive restarts and redeploys.

| Table | Key | Columns | Purpose |
| --- | --- | --- | --- |
| `wa_threads` | `thread_id` | `number_id`, `owner_phone`, `reused`, `assigned_at_ms`, `accepted_at_ms`, `opener_wamid`, `opener_read_at_ms`, `confirmed_at_ms` | Which number a conversation sends from, and whether its assignment is active. Open and released are read from the thread's own state, so there is no `status` column |
| `wa_windows` | (`number_id`, `owner_phone`) | `last_inbound_ms` | Decides free-form text versus template |
| `wa_number_history` | (`number_id`, `owner_phone`) | `first_used_ms` | Keeps a number "reused" after its conversations are purged |
| `wa_pending` | `prompt_wamid` | `orig_wamid`, `text`, `number_id`, `allowed`, `expires_at_ms`, `consumed`, `chosen_ref` | Owner replies waiting for a "Which customer?" tap |

The existing message id → thread map stays, for quotes.

**Changes by file**

- `src/connectors/whatsapp-pool.ts`: parse the number list and define the store contract and the active-assignment check. The all-or-nothing env rule still applies.
- `src/connectors/whatsapp.ts`:
  - `openThread` assigns a number and sends from it.
  - `postToThread` sends from the thread's number.
  - The webhook resolves in the order in Design, records `read` statuses and replays picker taps.
  - `checkAccess` runs for every pool number.
- `src/messages.ts`: a reply scoped to a chat never auto-matches; the several-waiting hint becomes the "Which customer?" picker carrying thread ids. The core is unchanged otherwise.
- `src/cli/init.ts`: optional extra numbers.
- Store: the four tables. Assignment runs in one transaction, so concurrent `leave_message` calls never take the same free number.
- Tests:
  - Pool of 1 must pass the existing `test/whatsapp.test.ts` unchanged.
  - New cases: assignment, release hold and reuse, the read-receipt gate, overflow, per-number windows, buttons and list, and a restart between the picker and the tap.

## Risks, limits and costs

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 24-hour window is per (number, owner) | First message on a cold number needs a paid template | Assign the warmest free number; utility templates are cheap |
| Chat names show the business, not the customer | Owner sees the business name N times | Owner saves numbered contacts; customer name first in every message |
| Numbers per business account | Vendors report about 2 before verification and 20 to 25 after; Meta's figure is unverified | A pool of 3 to 5 is enough for most owners |
| Number provisioning | Each number needs its own SIM or landline, a verification code and display-name review | One-off setup per number, documented in the connector guide |
| Stale assignment after a crash | Reply routed to a closed conversation | Durable store; release only on an explicit close or expiry event, after a 60 s hold with the outbox drained |
| Owner has read receipts off | No `read` status, so a reused chat cannot be confirmed by reading | The first plain reply there gets the picker; a pick or quote confirms the chat for later replies |
| Close and booking notices bypass the outbox | A notice that fails transiently is dropped; only the 60 s hold keeps it ahead of a reused number's next opener | Hold is longer than the send timeout; route notices through the outbox later |
| Quote window | Quotes of messages older than about 7 days arrive without context (unverified for Meta) | Active pooled chats do not rely on quotes; an unplaceable quote gets a notice, never a guess |

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

1. **Pool abstraction, N = 1.** Introduce the number list and the pool tables; existing tests pass unchanged.
2. **"Which customer?" picker.** Replace the several-waiting hint with buttons or a list. This helps every merchant, pooled or not.
3. **Multi-number pool.** Assignment, release hold, reuse notice and read-receipt gate, per-number windows and overflow.
4. **Docs and init.** Number setup in `docs/connectors/whatsapp.md` and the `npm run init` step.

**Open questions**

- [x] Recommended pool size in the docs: 3.
- [x] Expiry for an idle assignment: tied to the thread's existing close rules.
- [ ] Confirm Meta's current cap on numbers per business account.
