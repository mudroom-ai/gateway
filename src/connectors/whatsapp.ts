// WhatsApp owner channel (Communication module) over the Meta Cloud API: sends
// agent messages and booking notices to the owner's WhatsApp number, and reads
// the owner's typed replies from Meta's webhook (POST /webhooks/whatsapp, signed
// with the app secret). A CommunicationConnector with every thread member (see
// types.ts), so the gateway runs in two_way mode; `flat` because WhatsApp has no
// threads: a reply the owner swipes to quote carries the quoted message id
// (context.id), which maps back to the thread; a plain reply carries nothing and
// the core matches it to the one thread awaiting the owner.
//
// Number pool: WHATSAPP_PHONE_NUMBER_ID may list several numbers of the same
// business account (the first is the primary). With more than one, each new
// conversation is sent from its own number (assigned by the store, see
// whatsapp-pool.ts), so the owner sees one chat per customer, and a reply is
// routed by the number the owner wrote to. A quote still wins and is exact. A
// plain reply goes straight to that chat's one open thread only when the
// assignment is active (isActive); otherwise it is handed to the core scoped to
// that chat's open threads, and the core asks "Which customer?" (askWhichThread:
// reply buttons or a list) without ever guessing. The question is stored, so a
// tap after a restart still replays the owner's original text. Everything the
// channel writes in reply (notices, the question, reactions) goes out from the
// number the owner wrote to. A pool of one number behaves as before.
//
// 24-hour window: Meta accepts free-form text only within 24 hours of the
// owner's last message to the number (error 131047 otherwise). The channel
// tries text first and falls back to the approved template in WHATSAPP_TEMPLATE
// with the text as its one parameter; without a template it refuses with a hint.
//
// Durability: Meta retries a webhook delivery for days while the endpoint
// answers non-2xx, so a storage failure answers 500 and the message comes back;
// the core dedups on the message id. There is no history read, so findPosted is
// not implemented: a send whose answer was lost may go out twice.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ConnectorError,
  FLAT_REPLY_HINT,
  type InboundWebhookRequest,
  type InboundWebhookResponse,
  type OwnerInboundMessage,
  type OwnerMessageHandler,
  type ThreadCapableChannel,
  type ThreadChoice,
} from "./types.js";
import { isActive, parsePhoneNumberIds, PENDING_TTL_MS, type WaPending, type WhatsappPoolStore } from "./whatsapp-pool.js";

export const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";
const GRAPH = "https://graph.facebook.com";
const DEFAULT_GRAPH_VERSION = "v21.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_S = 30;
/** Meta's limit for a text body. */
const TEXT_MAX = 4096;
/** Template parameters are shorter and cannot hold newlines. */
const TEMPLATE_PARAM_MAX = 1000;
/** Outbound message ids remembered for quote lookups (opener or follow-up -> the thread's opener id). */
const REF_MAP_MAX = 2000;
const NOTICED_MAX = 500;
/** Meta's limits for interactive messages: reply buttons, then list rows. */
const BUTTONS_MAX = 3;
const BUTTON_TITLE_MAX = 20;
const BUTTON_ID_MAX = 256;
const LIST_ROWS_MAX = 10;
const ROW_TITLE_MAX = 24;
const ROW_DESC_MAX = 72;
const ROW_ID_MAX = 200;
const LIST_BUTTON = "Choose customer";
const LIST_SECTION = "Waiting customers";
/** How much of the owner's message the question repeats. */
const PICKER_QUOTE_MAX = 60;

/** Meta error codes that mean the token or app setup is wrong; retrying cannot help. */
const AUTH_CODES = new Set([190, 10]);
/** Meta-side hiccups and rate limits the core should queue and retry. */
const TRANSIENT_CODES = new Set([1, 2, 4, 368, 80007, 130429, 131048, 131056]);
/** Sent once when the owner quoted a message the gateway cannot tie to a conversation. */
export const UNKNOWN_QUOTE_NOTICE = "I could not tell which conversation this answers. Please swipe to reply on the agent's own message (the one that starts with \"New message\"), or send it without a quote when only one customer is waiting.";
/** Free-form text refused: the owner has not written to the number in the last 24 hours. */
export const WINDOW_CLOSED_CODE = 131047;
/** The opener's last line when the chat holds only this conversation (a pool number, not overflow). Replaces FLAT_REPLY_HINT. */
export const POOL_REPLY_HINT = "Reply in this chat; it is only about this customer. If the assistant does not come back, the customer's contact is above.";
/** The "Which customer?" question; the owner's message follows it. */
export const PICKER_PROMPT = "Which customer is this reply for?";
/** Instead of the question when it cannot be shown (more than 10 choices, or Meta refused it). Same words as the core's flat hint. */
export const PICKER_FALLBACK_HINT = "Several customers are waiting; please swipe to reply on the message for each.";
/** A tap that cannot be honoured (unknown or expired question, a choice it did not offer, another chat). */
export const TAP_AGAIN_NOTICE = "Please send that reply again.";

/** The fix a merchant can act on, per Meta error code. Exported for the docs and the init wizard. */
export function whatsappHint(code: number, message = ""): string {
  if (code === 190) return "WHATSAPP_ACCESS_TOKEN is invalid or expired: generate a new one (Meta app > WhatsApp > API Setup for a 24-hour test token, or a System User token under Business Settings for a permanent one)";
  if (code === 10 || (code >= 200 && code <= 299)) return "the token lacks permission: it needs whatsapp_business_messaging and whatsapp_business_management, and the app must have access to this WhatsApp Business Account";
  if (code === 33 || code === 100) return "WHATSAPP_PHONE_NUMBER_ID is wrong or the token cannot see it: copy the Phone number ID from Meta app > WhatsApp > API Setup";
  if (code === 131030) return "the owner's number is not a recipient of this test number: add it under Meta app > WhatsApp > API Setup > To";
  if (code === WINDOW_CLOSED_CODE) return "the owner has not messaged this number in the last 24 hours: ask them to send it any message, or set WHATSAPP_TEMPLATE to an approved utility template with one {{1}} body parameter";
  if (code === 132001) return "WHATSAPP_TEMPLATE names a template that does not exist for that language: check the name and language under WhatsApp Manager > Message templates";
  if (code === 132000 || code === 132012) return "WHATSAPP_TEMPLATE must have exactly one body parameter {{1}} and no header or button parameters";
  return `WhatsApp refused the request (${code}${message ? `: ${message}` : ""})`;
}

/** Digits only, the form Meta uses for `to` and `from`: "+1 202 555 0199" -> "12025550199". */
export function waNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Masks all but the last 4 digits for logs. */
function mask(digits: string): string {
  return digits.length <= 4 ? "****" : `***${digits.slice(-4)}`;
}

/** Template parameters cannot hold newlines, tabs or more than 4 spaces in a row. */
export function templateParam(text: string): string {
  return text.trim().replace(/\s*\r?\n+\s*/g, " · ").replace(/[\t ]+/g, " ").slice(0, TEMPLATE_PARAM_MAX);
}

/** One line of at most `max` code points (a surrogate pair is never split), ending in "…" when cut. */
export function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  return max <= 1 ? chars.slice(0, Math.max(max, 0)).join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** Titles cut to `max` and unique: the ones that collide after cutting get their position appended. */
export function distinctTitles(raw: string[], max: number): string[] {
  const withIndex = (t: string, i: number) => {
    const suffix = ` #${i + 1}`;
    return `${clipLine(t, max - suffix.length)}${suffix}`.trim();
  };
  const cut = raw.map((t, i) => clipLine(t, max) || `Customer ${i + 1}`);
  const seen = new Map<string, number>();
  for (const t of cut) seen.set(t, (seen.get(t) ?? 0) + 1);
  const out = cut.map((t, i) => ((seen.get(t) ?? 0) > 1 ? withIndex(t, i) : t));
  return new Set(out).size === out.length ? out : raw.map(withIndex);
}

/**
 * The opener as sent from a pool number. A chat that holds only this conversation says so instead of asking for a swipe;
 * a reused one first says the messages above are someone else's. An overflow chat (other threads open) keeps the flat text.
 */
export function poolOpenerText(text: string, o: { reused: boolean; shared: boolean; customer?: string | undefined }): string {
  if (o.shared) return text;
  const body = text.replace(FLAT_REPLY_HINT, () => POOL_REPLY_HINT);
  if (!o.reused) return body;
  const who = clipLine(o.customer ?? "", 60) || "a new customer";
  return `This chat is now about ${who}. Messages above are about another customer.\n\n${body}`;
}

export interface WhatsappOwnerOptions {
  /** System-user or temporary access token for the Cloud API. */
  accessToken: string;
  /** The sender's Phone number ID (not the phone number itself): a pool of one. Ignored when `phoneNumberIds` is set. */
  phoneNumberId?: string;
  /** The pool, as parsePhoneNumberIds returns it; the first is the primary (notices, threads from before the pool). More than one needs `store`. */
  phoneNumberIds?: string[];
  /** The Meta app's App Secret, which signs every webhook delivery. */
  appSecret: string;
  /** Echoed by Meta in the webhook handshake. */
  verifyToken: string;
  /** The owner's number (E.164 or digits); the only sender whose messages count. */
  ownerPhone: string;
  /** Approved utility template with one body parameter, for messages outside the 24-hour window. */
  template?: { name: string; language: string } | undefined;
  /** Number assignments and stored "Which customer?" questions. Required for a pool; with one number it only enables the question. */
  store?: WhatsappPoolStore | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (m: string) => void;
  graphVersion?: string;
  /** Server clock (epoch ms), for acceptance times and question expiry. */
  now?: () => number;
}

export type WhatsappChannel = ThreadCapableChannel & Required<Pick<ThreadCapableChannel, "acknowledge" | "checkAccess" | "status" | "webhook" | "flat">>;

type GraphError = { message?: unknown; code?: unknown; error_subcode?: unknown; error_data?: { details?: unknown } };
type InboundMessage = {
  id?: unknown;
  from?: unknown;
  timestamp?: unknown;
  type?: unknown;
  text?: { body?: unknown };
  context?: { id?: unknown };
  interactive?: { type?: unknown; button_reply?: { id?: unknown }; list_reply?: { id?: unknown } };
};
type InboundStatus = { id?: unknown; status?: unknown; timestamp?: unknown; recipient_id?: unknown };
type Outcome = Awaited<ReturnType<OwnerMessageHandler>>;

/** `name` or `name:lang` from WHATSAPP_TEMPLATE. */
export function parseTemplate(spec: string | undefined): { name: string; language: string } | undefined {
  const s = spec?.trim();
  if (!s) return undefined;
  const [name, language] = s.split(":");
  if (!name?.trim()) return undefined;
  return { name: name.trim(), language: language?.trim() || "en_US" };
}

/** Meta's timestamp (whole seconds, as a string) in ms, or undefined. */
function metaMs(ts: unknown): number | undefined {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

export function whatsappOwnerChannel(opts: WhatsappOwnerOptions): WhatsappChannel {
  const ids = opts.phoneNumberIds?.length ? opts.phoneNumberIds : opts.phoneNumberId ? [opts.phoneNumberId] : [];
  const primary = ids[0];
  if (primary === undefined) throw new Error("WhatsApp channel needs at least one Phone number ID");
  const pooled = ids.length > 1;
  const store = opts.store;
  if (pooled && !store) throw new Error(`WHATSAPP_PHONE_NUMBER_ID lists ${ids.length} numbers, but the number pool needs the gateway's database, which this process did not open`);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const now = opts.now ?? (() => Date.now());
  const base = `${GRAPH}/${opts.graphVersion ?? DEFAULT_GRAPH_VERSION}`;
  const owner = waNumber(opts.ownerPhone);
  const ownerMasked = mask(owner);
  let handler: OwnerMessageHandler | undefined;
  let started = false;
  let lastError: string | undefined;
  /** Every message id this channel sent -> the opener id of its thread, so a quote of a follow-up finds the thread. */
  const refs = new Map<string, string>();
  /** Inbound message ids already answered with a notice (Meta redelivers). */
  const noticed = new Set<string>();
  /** Senders already logged this hour, so a stranger cannot fill the log. */
  const strangers = new Map<string, number>();
  /** The number each owner message being handled right now came in on (askWhichThread answers from it); emptied when its delivery ends. */
  const inflight = new Map<string, { number_id: string; n: number }>();
  /** Numbers already warned about (an open thread on a number no longer in the pool). */
  const warnedNumbers = new Set<string>();
  let orphansChecked = false;

  function remember(wamid: string, ref: string): void {
    refs.set(wamid, ref);
    if (refs.size > REF_MAP_MAX) refs.delete(refs.keys().next().value!);
  }

  async function graph(path: string, init: { method: "GET" } | { method: "POST"; body: Record<string, unknown> }): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${opts.accessToken}`, ...(init.method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error | undefined;
      const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : `network error: ${err?.message ?? e}`;
      throw new ConnectorError("channel_unavailable", `WhatsApp ${why}`, { retry_after_s: DEFAULT_RETRY_S, cause: e });
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok) return {};
    }
    if (res.ok && !body.error) return body;
    const error = (body.error ?? {}) as GraphError;
    const code = typeof error.code === "number" ? error.code : -1;
    const detail = typeof error.error_data?.details === "string" ? error.error_data.details : typeof error.message === "string" ? error.message : `http ${res.status}`;
    if (res.status === 429 || res.status >= 500 || TRANSIENT_CODES.has(code)) {
      throw new ConnectorError("channel_unavailable", `WhatsApp ${code}: ${detail}`, { retry_after_s: code === 368 ? 300 : DEFAULT_RETRY_S });
    }
    if (res.status === 401 || res.status === 403 || AUTH_CODES.has(code) || (code >= 200 && code <= 299)) {
      throw new ConnectorError("channel_auth_failed", `WhatsApp ${code}: ${whatsappHint(code, detail)}`);
    }
    throw new ConnectorError("channel_rejected", `WhatsApp ${code}: ${whatsappHint(code, detail)}`, { cause: error });
  }

  /** One message to the owner, sent from the pool number `from`. */
  async function sendMessage(from: string, payload: Record<string, unknown>): Promise<string> {
    const r = await graph(`${encodeURIComponent(from)}/messages`, { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: owner, ...payload } });
    const id = (r.messages as Array<{ id?: unknown }> | undefined)?.[0]?.id;
    if (typeof id !== "string") throw new ConnectorError("channel_rejected", "WhatsApp send returned no message id");
    return id;
  }

  /** Free-form text, or the template with the text as its parameter when the 24-hour window is closed. */
  async function sendText(text: string, from: string = primary!): Promise<string> {
    const body = text.slice(0, TEXT_MAX);
    try {
      const id = await sendMessage(from, { type: "text", text: { preview_url: false, body } });
      lastError = undefined;
      return id;
    } catch (e) {
      const code = ((e as ConnectorError)?.cause as GraphError | undefined)?.code;
      if (code !== WINDOW_CLOSED_CODE || !opts.template) throw e;
      const id = await sendMessage(from, {
        type: "template",
        template: { name: opts.template.name, language: { code: opts.template.language }, components: [{ type: "body", parameters: [{ type: "text", text: templateParam(text) }] }] },
      });
      lastError = undefined;
      return id;
    }
  }

  const isTransient = (e: unknown) => e instanceof ConnectorError && e.code === "channel_unavailable";

  /**
   * One notice per inbound message, from the number it came in on. Failures are logged; with `retryTransient` a transient
   * one throws instead (the delivery answers 500 and the notice is tried again).
   */
  async function noticeOnce(key: string, text: string, from: string, o: { retryTransient?: boolean } = {}): Promise<void> {
    if (noticed.has(key)) return;
    noticed.add(key);
    if (noticed.size > NOTICED_MAX) noticed.delete(noticed.values().next().value!);
    try {
      await sendText(text, from);
    } catch (e) {
      if (o.retryTransient && isTransient(e)) {
        noticed.delete(key);
        throw e;
      }
      warn(`[gateway] WhatsApp notice to ${ownerMasked} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  function rejectionNotice(reason: string): string {
    if (reason === "thread_closed") return "That conversation is closed, so the agent will not see this reply.";
    return `This reply was not passed to the agent (${reason}).`;
  }

  function signatureOk(req: InboundWebhookRequest): boolean {
    const header = req.headers["x-hub-signature-256"] ?? "";
    const given = header.startsWith("sha256=") ? header.slice(7) : "";
    const expected = createHmac("sha256", opts.appSecret).update(req.rawBody).digest("hex");
    return given.length === expected.length && timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  }

  /** The pool number a thread sends from: its assigned one, else the primary (no row: from before the pool; a number removed from the env). */
  function numberForRef(ref: string): string {
    if (!pooled || !ref) return primary!;
    const n = store!.waNumberForRef(ref);
    if (n === null) return primary!;
    if (ids.includes(n)) return n;
    if (!warnedNumbers.has(n)) {
      warnedNumbers.add(n);
      warn(`[gateway] WhatsApp number ${mask(n)} is no longer in WHATSAPP_PHONE_NUMBER_ID; its conversations now send from the primary number`);
    }
    return primary!;
  }

  /** Once: open threads on numbers no longer in the pool. Never fails the caller. */
  function warnOrphans(): void {
    if (orphansChecked || !store) return;
    orphansChecked = true;
    try {
      const orphans = store.waOrphanNumbers(ids, owner).filter((n) => !warnedNumbers.has(n));
      for (const n of orphans) warnedNumbers.add(n);
      if (orphans.length) {
        warn(
          `[gateway] WhatsApp numbers ${orphans.map(mask).join(", ")} still have open conversations but are no longer in WHATSAPP_PHONE_NUMBER_ID; those conversations now send from the primary number, and replies typed in the old chats are not read`,
        );
      }
    } catch (e) {
      warn(`[gateway] WhatsApp pool check failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** The owner quoted or picked this thread in chat `at`: record it, so later plain replies there route (reused numbers). Best effort. */
  function confirmOn(at: string, ref: string, atMs: number): void {
    try {
      const t = store!.waOpenOn({ number_id: at, owner_phone: owner, is_primary: at === primary }).find((x) => x.provider_ref === ref);
      if (t) store!.waConfirm(t.thread_id, atMs);
    } catch (e) {
      // Fails closed: the next plain reply goes to the question instead of straight through.
      warn(`[gateway] WhatsApp could not record the owner's choice: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Runs the handler with the receiving number known to askWhichThread for this message. */
  async function within<T>(msgId: string, at: string, fn: () => Promise<T>): Promise<T> {
    const cur = inflight.get(msgId);
    inflight.set(msgId, { number_id: at, n: (cur?.n ?? 0) + 1 });
    try {
      return await fn();
    } finally {
      const after = inflight.get(msgId);
      if (after && after.n > 1) after.n -= 1;
      else inflight.delete(msgId);
    }
  }

  /** A tap on a "Which customer?" button or list row: replay the stored original with the chosen thread. */
  async function onTap(id: string, from: string, m: InboundMessage, at: string): Promise<void> {
    const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
    const chosen = typeof reply?.id === "string" ? reply.id : "";
    const prompt = typeof m.context?.id === "string" ? m.context.id : "";
    if (!chosen || !prompt) return noticeOnce(id, TAP_AGAIN_NOTICE, at);
    const tapMs = metaMs(m.timestamp) ?? now();
    // A redelivered tap gets the same pending back (the core dedups on the original's id), so a reply the core failed to
    // store is replayed; another choice after the first is ignored, and anything else cannot be honoured: never guess.
    const r = store!.waTakePending({ prompt_wamid: prompt, chosen_ref: chosen, number_id: at, now_ms: now() });
    if (!r.ok) {
      if (r.reason !== "consumed") await noticeOnce(id, TAP_AGAIN_NOTICE, at);
      return;
    }
    const pending = r.pending;
    const outcome = await handler!({
      provider_ref: chosen,
      provider_msg_id: pending.orig_wamid,
      user_id: from,
      text: pending.text,
      ...(pending.sent_at_ms !== null ? { sent_at_ms: pending.sent_at_ms } : {}),
    });
    if (outcome === "accepted" && pooled) confirmOn(at, chosen, tapMs);
    if (outcome.startsWith("rejected:")) await noticeOnce(id, rejectionNotice(outcome.slice("rejected:".length)), at);
  }

  /** One inbound message (on pool number `at`) through the core. Throws when the core could not store it, so the delivery answers 500 and Meta retries. */
  async function onMessage(m: InboundMessage, at: string): Promise<void> {
    const id = typeof m.id === "string" ? m.id : "";
    const from = typeof m.from === "string" ? waNumber(m.from) : "";
    if (!id || !from) return;
    if (from !== owner) {
      const t = Date.now();
      if ((strangers.get(from) ?? 0) < t - 3_600_000) {
        strangers.set(from, t);
        warn(`[gateway] WhatsApp message from ${mask(from)} ignored: not the owner's number`);
      }
      return;
    }
    const type = typeof m.type === "string" ? m.type : "";
    if (type === "reaction") return;
    const sent_at_ms = metaMs(m.timestamp);
    // The owner wrote to this number, so its 24-hour window is open (the store prefers warm numbers).
    if (pooled) store!.waTouchWindow(at, owner, sent_at_ms ?? now());
    const tap = type === "interactive" && (m.interactive?.type === "button_reply" || m.interactive?.type === "list_reply");
    if (tap && store) {
      if (handler) await onTap(id, from, m, at);
      return;
    }
    if (type !== "text") {
      await noticeOnce(id, "Only text messages reach the agent. Please type your reply.", at);
      return;
    }
    if (!handler) return;
    const h = handler;
    const text = typeof m.text?.body === "string" ? m.text.body : "";
    const quoted = typeof m.context?.id === "string" ? m.context.id : undefined;
    const base = { provider_msg_id: id, user_id: from, text, ...(sent_at_ms !== undefined ? { sent_at_ms } : {}) };
    let outcome: Outcome;
    if (quoted) {
      // A quote of something this channel sent, or (after a restart) of an opener the core still knows by its id.
      const ref = refs.get(quoted) ?? quoted;
      outcome = await within(id, at, () => h({ ...base, provider_ref: ref }));
      // A quote the core cannot place (a notice, a follow-up from before a restart) is never guessed at: the owner
      // named a conversation, and the one thread waiting now may be another customer's.
      if (outcome === "ignored" && !refs.has(quoted)) await noticeOnce(id, UNKNOWN_QUOTE_NOTICE, at);
      if (outcome === "accepted" && pooled) confirmOn(at, ref, sent_at_ms ?? now());
    } else if (pooled) {
      // A plain reply in a pooled chat: straight to the chat's one open thread when that assignment is active, else the
      // core asks which of this chat's threads it answers. Never the core's matching over every thread.
      const open = store!.waOpenOn({ number_id: at, owner_phone: owner, is_primary: at === primary });
      const only = open.length === 1 ? open[0]! : undefined;
      if (only && isActive(only, sent_at_ms)) {
        outcome = await within(id, at, () => h({ ...base, provider_ref: only.provider_ref! }));
      } else {
        const scope = open.map((t) => t.provider_ref).filter((r): r is string => typeof r === "string" && r !== "");
        if (scope.length === 0) return; // nothing waiting in this chat (or its opener is still in flight)
        outcome = await within(id, at, () => h({ ...base, scope_refs: scope }));
      }
    } else {
      // A plain reply: the core matches it to the one thread awaiting the owner.
      outcome = await within(id, at, () => h(base));
    }
    if (outcome.startsWith("rejected:")) await noticeOnce(id, rejectionNotice(outcome.slice("rejected:".length)), at);
  }

  /** A delivery status. Only `read` matters: the owner saw a reused chat's opener, which confirms the assignment. */
  function onStatus(s: InboundStatus): void {
    if (s?.status !== "read" || typeof s.id !== "string") return;
    if (typeof s.recipient_id === "string" && waNumber(s.recipient_id) !== owner) return;
    const at = metaMs(s.timestamp);
    // WhatsApp may report only the newest message read; a follow-up read means its thread's opener above it was read too.
    if (at !== undefined) store!.waMarkRead(refs.get(s.id) ?? s.id, at);
  }

  /** The pool number a delivery is for, or null to skip it (another number on the same Meta app). */
  function receivingNumber(pnid: unknown): string | null {
    if (typeof pnid === "string") return ids.includes(pnid) ? pnid : null;
    return pooled ? null : primary!; // a pool routes by number and cannot guess one
  }

  async function handle(req: InboundWebhookRequest): Promise<InboundWebhookResponse> {
    if (req.method === "GET") {
      if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === opts.verifyToken && typeof req.query["hub.challenge"] === "string") {
        return { status: 200, body: req.query["hub.challenge"] };
      }
      warn("[gateway] WhatsApp webhook handshake refused: hub.verify_token does not match WHATSAPP_VERIFY_TOKEN");
      return { status: 403, body: "verify token mismatch" };
    }
    if (req.method !== "POST") return { status: 405, body: "method not allowed" };
    if (!signatureOk(req)) {
      warn("[gateway] WhatsApp webhook delivery refused: bad X-Hub-Signature-256 (is WHATSAPP_APP_SECRET the app's App Secret?)");
      return { status: 401, body: "bad signature" };
    }
    let body: { object?: unknown; entry?: unknown };
    try {
      body = JSON.parse(req.rawBody.toString("utf8")) as typeof body;
    } catch {
      return { status: 400, body: "not JSON" };
    }
    if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return { status: 200, body: "ignored" };
    for (const entry of body.entry as Array<{ changes?: unknown }>) {
      if (!Array.isArray(entry?.changes)) continue;
      for (const change of entry.changes as Array<{ field?: unknown; value?: { metadata?: { phone_number_id?: unknown }; messages?: unknown; statuses?: unknown } }>) {
        if (change?.field !== "messages") continue;
        // One Meta app can serve several numbers; only deliveries for this pool's count.
        const at = receivingNumber(change.value?.metadata?.phone_number_id);
        if (at === null) continue;
        const statuses = pooled && Array.isArray(change.value?.statuses) ? (change.value!.statuses as InboundStatus[]) : [];
        const messages = Array.isArray(change.value?.messages) ? (change.value!.messages as InboundMessage[]) : [];
        try {
          for (const s of statuses) onStatus(s);
          for (const m of messages) await onMessage(m, at);
        } catch (e) {
          // Not stored: answer 500 so Meta delivers it again.
          lastError = `inbound: ${(e as Error)?.message ?? e}`;
          warn(`[gateway] WhatsApp inbound not stored, asking Meta to retry: ${lastError}`);
          return { status: 500, body: "not stored" };
        }
      }
    }
    return { status: 200, body: "ok" };
  }

  /** The interactive message for the question: reply buttons for up to 3 choices, else a list. */
  function pickerPayload(ownerText: string, choices: ThreadChoice[]): Record<string, unknown> {
    const quote = clipLine(ownerText, PICKER_QUOTE_MAX);
    const body = { text: quote ? `${PICKER_PROMPT}\n\n"${quote}"` : PICKER_PROMPT };
    if (choices.length <= BUTTONS_MAX) {
      const titles = distinctTitles(choices.map((c) => c.title), BUTTON_TITLE_MAX);
      return {
        type: "interactive",
        interactive: { type: "button", body, action: { buttons: choices.map((c, i) => ({ type: "reply", reply: { id: c.provider_ref, title: titles[i] } })) } },
      };
    }
    const titles = distinctTitles(choices.map((c) => c.title), ROW_TITLE_MAX);
    const rows = choices.map((c, i) => {
      const description = c.detail ? clipLine(c.detail, ROW_DESC_MAX) : "";
      return { id: c.provider_ref, title: titles[i], ...(description ? { description } : {}) };
    });
    return { type: "interactive", interactive: { type: "list", body, action: { button: LIST_BUTTON, sections: [{ title: LIST_SECTION, rows }] } } };
  }

  const channel: WhatsappChannel = {
    flat: true,
    webhook: { path: WHATSAPP_WEBHOOK_PATH, handle },
    async notify(message) {
      try {
        await sendText(message);
      } catch (e) {
        lastError = (e as Error)?.message ?? String(e);
        warn(`[gateway] owner WhatsApp to ${ownerMasked} failed: ${lastError}`);
      }
    },
    async openThread(opener) {
      if (!pooled) {
        const id = await trackSend(() => sendText(opener.text));
        remember(id, id);
        return { provider_ref: id };
      }
      const a = store!.waAssign({ thread_id: opener.thread_id, owner_phone: owner, pool: ids, now_ms: now() });
      const from = ids.includes(a.number_id) ? a.number_id : primary!;
      // Overflow: other conversations are open in this chat, so it stays a flat chat (swipe to reply).
      const shared = store!.waOpenOn({ number_id: from, owner_phone: owner, is_primary: from === primary }).some((t) => t.thread_id !== opener.thread_id);
      const id = await trackSend(() => sendText(poolOpenerText(opener.text, { reused: a.reused, shared, customer: opener.customer_name }), from));
      store!.waMarkAccepted(opener.thread_id, id, now());
      remember(id, id);
      return { provider_ref: id };
    },
    async postToThread(ref, text) {
      const from = numberForRef(ref);
      const id = await trackSend(() => sendText(text, from));
      remember(id, ref);
    },
    onOwnerMessage(h) {
      handler = h;
    },
    async acknowledge(ref, msgId) {
      try {
        await sendMessage(numberForRef(ref), { type: "reaction", reaction: { message_id: msgId, emoji: "✅" } });
      } catch (e) {
        warn(`[gateway] WhatsApp reaction on ${msgId} failed: ${(e as Error)?.message ?? e}`);
      }
    },
    async start() {
      warnOrphans();
      started = true;
    },
    async stop() {
      started = false;
    },
    async checkAccess() {
      for (const pnid of ids) {
        let r: Record<string, unknown>;
        try {
          r = await graph(`${encodeURIComponent(pnid)}?fields=display_phone_number,verified_name`, { method: "GET" });
        } catch (e) {
          if (!pooled || !(e instanceof ConnectorError)) throw e;
          throw new ConnectorError(e.code, `${e.message} (Phone number ID ${pnid})`, { retry_after_s: e.retry_after_s, cause: e.cause });
        }
        if (typeof r.id !== "string") throw new ConnectorError("channel_auth_failed", `WhatsApp: ${whatsappHint(33)}${pooled ? ` (Phone number ID ${pnid})` : ""}`);
      }
      warnOrphans();
    },
    status() {
      return lastError ? { connected: started, last_error: lastError } : { connected: started };
    },
  };

  if (store) {
    // Only with a store: the question is kept there until the owner taps, so a restart in between loses nothing.
    channel.askWhichThread = async (m: OwnerInboundMessage, choices: ThreadChoice[]) => {
      const at = inflight.get(m.provider_msg_id)?.number_id ?? (pooled ? undefined : primary!);
      if (at === undefined) throw new ConnectorError("channel_rejected", "WhatsApp askWhichThread: no webhook delivery in progress for this message");
      if (choices.length === 0 || store.waHasPending(m.provider_msg_id)) return; // a redelivery: asked already
      const idMax = choices.length <= BUTTONS_MAX ? BUTTON_ID_MAX : ROW_ID_MAX;
      const fits = choices.length <= LIST_ROWS_MAX && choices.every((c) => c.provider_ref.length <= idMax);
      if (!fits) return noticeOnce(`hint:${m.provider_msg_id}`, PICKER_FALLBACK_HINT, at, { retryTransient: true });
      let prompt: string;
      try {
        prompt = await sendMessage(at, pickerPayload(m.text, choices));
        lastError = undefined;
      } catch (e) {
        // Transient: throw, so the delivery answers 500 and Meta brings the message back. Refused for good (the 24-hour
        // window, a bad payload): the plain hint, which can still fall back to the template.
        if (!(e instanceof ConnectorError) || isTransient(e)) {
          lastError = (e as Error)?.message ?? String(e);
          throw e;
        }
        warn(`[gateway] WhatsApp "Which customer?" refused, sending the hint instead: ${e.message}`);
        return noticeOnce(`hint:${m.provider_msg_id}`, PICKER_FALLBACK_HINT, at, { retryTransient: true });
      }
      store.waPutPending({
        prompt_wamid: prompt,
        orig_wamid: m.provider_msg_id,
        text: m.text,
        sent_at_ms: m.sent_at_ms ?? null,
        number_id: at,
        allowed: choices.map((c) => c.provider_ref),
        expires_at_ms: now() + PENDING_TTL_MS,
      });
    };
  }

  async function trackSend(send: () => Promise<string>): Promise<string> {
    try {
      return await send();
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
      throw e;
    }
  }

  return channel;
}

export interface WhatsappSettings {
  whatsapp_access_token?: string | undefined;
  whatsapp_phone_number_id?: string | undefined;
  whatsapp_app_secret?: string | undefined;
  whatsapp_verify_token?: string | undefined;
  whatsapp_template?: string | undefined;
  owner_phone?: string | undefined;
}

export const WHATSAPP_REQUIRED_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "OWNER_PHONE"] as const;

/**
 * WhatsApp channel when the five required settings are set, undefined when none
 * of the WHATSAPP_* ones are (OWNER_PHONE alone belongs to Twilio), and an Error
 * naming the missing env vars when only some are. WHATSAPP_PHONE_NUMBER_ID may
 * list several numbers (the pool); that needs `opts.store`, and without one this
 * throws, so the gateway never runs a pool it cannot route.
 */
export const WHATSAPP_POOL_TEMPLATE_ERROR =
  "WHATSAPP_PHONE_NUMBER_ID lists several numbers (a number pool), which needs WHATSAPP_TEMPLATE: the first message on a number the owner has not written to in 24 hours can only be an approved template";

export function createWhatsappChannel(
  settings: WhatsappSettings,
  opts: Omit<WhatsappOwnerOptions, "accessToken" | "phoneNumberId" | "phoneNumberIds" | "appSecret" | "verifyToken" | "ownerPhone" | "template"> = {},
): WhatsappChannel | undefined {
  const fields: Array<[keyof WhatsappSettings, (typeof WHATSAPP_REQUIRED_ENV)[number]]> = [
    ["whatsapp_access_token", "WHATSAPP_ACCESS_TOKEN"],
    ["whatsapp_phone_number_id", "WHATSAPP_PHONE_NUMBER_ID"],
    ["whatsapp_app_secret", "WHATSAPP_APP_SECRET"],
    ["whatsapp_verify_token", "WHATSAPP_VERIFY_TOKEN"],
    ["owner_phone", "OWNER_PHONE"],
  ];
  const missing = fields.filter(([k]) => !settings[k]?.trim()).map(([, env]) => env);
  const setWhatsapp = fields.filter(([k, env]) => env !== "OWNER_PHONE" && settings[k]?.trim());
  if (setWhatsapp.length === 0) return undefined;
  if (missing.length > 0) {
    throw new Error(`WhatsApp is partly configured: set ${missing.join(", ")} too, or unset all of ${WHATSAPP_REQUIRED_ENV.filter((v) => v !== "OWNER_PHONE").join(", ")}`);
  }
  if (!/^\d{5,}$/.test(waNumber(settings.owner_phone!))) throw new Error("OWNER_PHONE must be the owner's WhatsApp number with country code, e.g. +1 202 555 0199");
  const ids = parsePhoneNumberIds(settings.whatsapp_phone_number_id);
  const template = parseTemplate(settings.whatsapp_template);
  // A number the owner has not written to in 24 hours (every new one) only takes the approved template.
  if (ids.length > 1 && !template) throw new Error(WHATSAPP_POOL_TEMPLATE_ERROR);
  if (ids.length > 1 && !opts.store) {
    throw new Error(`WHATSAPP_PHONE_NUMBER_ID lists ${ids.length} numbers (a number pool), which needs the gateway's database to route replies: start the gateway with npm start, or list one number`);
  }
  return whatsappOwnerChannel({
    ...opts,
    accessToken: settings.whatsapp_access_token!.trim(),
    phoneNumberIds: ids,
    appSecret: settings.whatsapp_app_secret!.trim(),
    verifyToken: settings.whatsapp_verify_token!.trim(),
    ownerPhone: settings.owner_phone!,
    template,
  });
}
