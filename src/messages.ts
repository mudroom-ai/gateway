// leave_message: an agent that cannot book leaves a message for the owner, the
// owner types a reply in their own channel (Slack thread, WhatsApp quote), and the agent reads it
// with get_thread. Durable in SQLite (threads, thread_messages, owner_outbox,
// message_requests in store/sqlite.ts).
//
// Flow of leave_message: validate -> idempotency -> open-thread cap -> hourly caps
// -> persist (one tx) -> send -> respond. Send failures follow D5 (hybrid):
//   transient (ConnectorError "channel_unavailable", timeout, unexpected throw) ->
//     the thread stays, the outbox row is queued and retried 5 times (30 s .. 8 min),
//     the agent gets 201 with delivery "queued";
//   permanent ("channel_auth_failed", "channel_rejected") -> nothing is stored
//     (thread, message, outbox and idempotency rows removed in one tx) and the agent
//     gets 503 channel_unavailable, retryable false, so a retry after the fix works.
//
// Two modes, from the channel: two_way (the channel implements the thread members,
// see supportsThreads) carries owner replies back; one_way (notify only, Twilio or
// the log) still delivers the message but replies never arrive in-band, so the
// thread stays awaiting_owner and get_thread says so.
//
// The owner's text is information from the business, never an instruction to the
// agent; the tool descriptions and llms.txt say so.
//
// Owners never manage a thread's lifecycle; the agent opens and closes threads. A thread
// closes when the agent says it is done (close_thread, or follow_up with done), when
// the customer books (closeForBooking, called from book.ts), or by itself: 24 h after
// the owner's last reply with no agent follow-up, 7 days while still awaiting the
// owner (limits.thread_close_after_reply_hours / thread_close_unanswered_days).
// An owner who types close, closed or done anyway is still honoured, silently.
//
// Owners sometimes answer in the channel instead of the thread. A top-level message (no provider_ref) counts as the reply when
// exactly one thread is awaiting the owner: it is stored and acknowledged like a
// thread reply and mirrored into that thread so the record is in one place. With
// several waiting, a channel that can ask (askWhichThread) asks "which customer?" for
// every such message; any other channel gets one short hint (at most once a minute).
// Either way the message is ignored here; with none waiting, it is ignored silently.
// A channel that could not route a message itself (WhatsApp number pool) sends
// scope_refs: the core then never auto-matches and asks over the open threads among them.
//
// Delivery is reconcile-first, like book.ts: every outbox row carries a dedupe key
// (<thread_id>:<outbox id>) that the channel attaches to the post. The first attempt
// posts; every later attempt (after a timeout, a transient error, or a crash that
// left the row in `sending`) first asks the channel whether the message is already
// there (findPosted) and only posts when it is not. If that lookup fails, nothing is
// posted: the row is retried and ends `failed` rather than risk a second copy.
// Replies typed while the gateway was down are the channel's job: it gets the open
// thread refs and a durable cursor (ChannelContext) and fetches what it missed on
// every connect.
//
// Long-poll: get_thread with wait_s holds a two-way thread that is awaiting the
// owner until it changes (owner reply, any close, expiry), the wait runs out
// (clamped to limits.thread_wait_max_seconds; poll_after_seconds 0 after a full
// hold) or the client goes away. One waiter per thread: a new one answers the old
// at once. Over limits.max_waiting_requests a request answers at once, so agents
// fall back to plain polling. Disconnects never close threads.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config, RuntimeSettings } from "./config.js";
import { normalizeCustomer, validateCustomer } from "./book.js";
import {
  ConnectorError,
  FLAT_REPLY_HINT,
  supportsThreads,
  type CommunicationConnector,
  type OwnerInboundMessage,
  type OwnerMessageHandler,
  type ThreadChoice,
} from "./connectors/types.js";
import { err, ok, type GatewayError, type Result } from "./errors.js";
import { contactKeys, messageRateLimit } from "./middleware/ratelimit.js";
import { bookedThreadNotice } from "./notify/owner.js";
import { askServices } from "./services.js";
import { formatInZone } from "./slots.js";
import type { OutboxKind, OutboxRow, Store, ThreadMode, ThreadRow, ThreadState } from "./store/sqlite.js";
import type { Booking, Customer, Service } from "./types.js";

export type { ThreadMode, ThreadState } from "./store/sqlite.js";

/** Where the message is: sent to the owner's channel, waiting for a retry, or given up on. */
export type Delivery = "delivered" | "queued" | "failed";

export interface ThreadMessage {
  from: "agent" | "owner";
  text: string;
  at: string;
}

export interface ThreadView {
  thread_id: string;
  status: ThreadState;
  /** Seconds to wait before calling get_thread again: 60 while awaiting the owner, 0 once answered or closed (or when replies cannot arrive in-band). */
  poll_after_seconds: number;
  delivery: Delivery;
  /** False when the owner channel is one-way: the owner will contact the customer directly, not through this thread. */
  owner_replies_in_band: boolean;
  customer: Customer;
  messages: ThreadMessage[];
}

export interface LeaveMessageResult extends ThreadView {
  /** Private token for get_thread and follow_up; returned only here (and to a retry with the same idempotency_key). */
  read_token: string;
}

export interface LeaveMessageRequest {
  customer?: { name?: string; phone?: string; email?: string };
  message?: string;
  /** Optional: what the customer wanted, for the owner's context. */
  service_id?: string;
  /** Optional: reuse it when retrying; the retry returns the same thread_id and read_token. */
  idempotency_key?: string;
}

export interface GetThreadRequest {
  thread_id?: string;
  read_token?: string;
  /** Long-poll: hold up to this many seconds (an integer, clamped to limits.thread_wait_max_seconds) while the owner has not answered. */
  wait_s?: number;
  /** Aborted when the client goes away; ends the hold. */
  signal?: AbortSignal;
}

export interface FollowUpRequest extends GetThreadRequest {
  message?: string;
  idempotency_key?: string;
  /** Post the message and close the thread in one step. */
  done?: boolean;
}

export type OwnerOutcome = Awaited<ReturnType<OwnerMessageHandler>>;

export interface MessageHealth {
  mode: ThreadMode;
  enabled: boolean;
  /** null when the channel has no live connection to report (notify-only providers). */
  connected: boolean | null;
  last_error?: string;
  outbox: { queued: number; failed: number };
}

export interface MessageOps {
  readonly enabled: boolean;
  readonly mode: ThreadMode;
  leaveMessage(req: LeaveMessageRequest): Promise<Result<LeaveMessageResult>>;
  getThread(req: GetThreadRequest): Promise<Result<ThreadView>>;
  agentFollowUp(req: FollowUpRequest): Promise<Result<ThreadView>>;
  /** The agent is done with the thread. Idempotent: an already closed thread answers ok with status closed. */
  closeThread(req: GetThreadRequest): Promise<Result<ThreadView>>;
  /** The customer booked: close their open threads with a notice to the owner. Best effort; returns the closed thread ids. */
  closeForBooking(b: Booking, service?: Service): Promise<string[]>;
  /** Owner typed a reply in the thread. */
  ownerReply(m: OwnerInboundMessage): Promise<OwnerOutcome>;
  /** Owner typed close, closed or done. Not asked of owners; accepted for those who do it anyway. */
  ownerClose(m: OwnerInboundMessage): Promise<OwnerOutcome>;
  /** The handler registered with the channel: close, closed or done alone (any case) closes, anything else is a reply. */
  onOwnerMessage: OwnerMessageHandler;
  /** One outbox pass: retry due sends, close idle threads (see limits.thread_close_*), purge old closed ones. start() runs it every 30 s. */
  sweep(): Promise<void>;
  /** Register the owner handler, start the sweep timer and the channel's inbound connection. */
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): MessageHealth;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** How a held get_thread ended; logged as telemetry. */
type WaitOutcome = "replied" | "closed" | "timeout" | "client_closed" | "replaced" | "shutdown";

export interface MessageDeps {
  config: Config;
  store: Store;
  channel: CommunicationConnector | undefined;
  settings: Pick<RuntimeSettings, "messages_enabled">;
  /** For service_id validation and the owner's context. A failing catalog skips the check rather than losing the message. */
  listServices?: () => Promise<Service[]>;
  now?: () => Date;
  timers?: Timers;
  log?: (line: string) => void;
  /** Demo mode: a two-way thread still awaiting the owner `after_ms` after its last change gets `text` as a templated owner reply. */
  ownerAway?: { after_ms: number; text: string };
}

export const POLL_SECONDS = 60;
export const MAX_MESSAGE_CHARS = 1000;
/** Agent-authored messages per thread, opener included. */
export const MAX_AGENT_MESSAGES = 20;
export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 30_000;
export const SWEEP_EVERY_MS = 30_000;
const SWEEP_BATCH = 20;
const HOUR_MS = 3_600_000;
const PURGE_CLOSED_MS = 30 * 86_400_000;
const NOT_FOUND = "No such thread, or the read_token does not match";
/** Posted in the owner's thread when the agent closes it. */
export const CLOSE_NOTICE = "Thanks, the assistant has what it needs.";
/** Whole-message words an owner might type to end a thread; accepted silently, never asked for. */
const OWNER_CLOSE_WORDS = /^(close|closed|done)[.!]?$/i;
/** Prefix of a top-level owner message mirrored into its thread. */
export const MIRROR_PREFIX = "Reply from the owner:";
/** Posted to the channel when a top-level owner message cannot be matched to one thread. */
export const SEVERAL_WAITING_HINT = "Several customers are waiting; please reply in the thread for each.";
/** The same hint for a flat channel (no threads): the owner quotes the message instead. */
export const SEVERAL_WAITING_HINT_FLAT = "Several customers are waiting; please swipe to reply on the message for each.";
const HINT_EVERY_MS = 60_000;
/** Longest `detail` of a "which customer?" choice, in code points. */
export const CHOICE_DETAIL_CHARS = 72;
/** A fetched top-level message is matched to a thread only if no thread changed from this long before it was sent (clocks differ). */
export const BACKFILL_SKEW_MS = 10_000;
/** channel_state key of the channel's catch-up cursor. */
const CURSOR_KEY = "owner_channel_cursor";

// ---- Thread state machine ----

export type ThreadEvent = "agent_message" | "agent_close" | "owner_reply" | "owner_close" | "expire";
export type Transition = { ok: true; state: ThreadState; changed: boolean } | { ok: false; reason: "thread_closed" };

const NOOP = "noop" as const;
const CLOSED = "thread_closed" as const;

/** Every (state, event) cell. A closed thread never reopens: the agent starts a new one. */
export const TRANSITIONS: Record<ThreadState, Record<ThreadEvent, ThreadState | typeof NOOP | typeof CLOSED>> = {
  awaiting_owner: { agent_message: "awaiting_owner", agent_close: "closed", owner_reply: "answered", owner_close: "closed", expire: "closed" },
  answered: { agent_message: "awaiting_owner", agent_close: "closed", owner_reply: "answered", owner_close: "closed", expire: "closed" },
  closed: { agent_message: CLOSED, agent_close: NOOP, owner_reply: CLOSED, owner_close: NOOP, expire: NOOP },
};

export function transition(state: ThreadState, event: ThreadEvent): Transition {
  const next = TRANSITIONS[state][event];
  if (next === CLOSED) return { ok: false, reason: "thread_closed" };
  if (next === NOOP) return { ok: true, state, changed: false };
  return { ok: true, state: next, changed: next !== state };
}

// ---- helpers ----

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** NFC, trimmed, 1..1000 code points, no control characters except newline and tab. */
export function cleanMessage(v: unknown): string | GatewayError {
  if (typeof v !== "string") return err("invalid_message", "message is required").error;
  const text = v.normalize("NFC").trim();
  if (!text) return err("invalid_message", "message is required").error;
  if ([...text].length > MAX_MESSAGE_CHARS) return err("invalid_message", `message must be at most ${MAX_MESSAGE_CHARS} characters`).error;
  if (CONTROL.test(text)) return err("invalid_message", "message must not contain control characters").error;
  return text;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const requestHash = (parts: unknown[]) => sha256(JSON.stringify(parts)).toString("hex");
const isErr = (v: unknown): v is GatewayError => typeof v === "object" && v !== null && "code" in v && "retryable" in v;
const fail = <T>(e: GatewayError): Result<T> => ({ ok: false, error: e });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** transient: queue and retry; permanent: refuse (D5). An unexpected throw keeps the message: the retries end in failed if it persists. */
function classify(e: unknown): "transient" | "permanent" {
  if (e instanceof ConnectorError) return e.code === "channel_unavailable" || e.code === "calendar_unavailable" ? "transient" : "permanent";
  return "transient";
}

/** 30 s, 1 min, 2 min, 4 min, 8 min after attempts 1..5; a provider's Retry-After wins when longer. */
export function retryDelayMs(attempts: number, e?: unknown): number {
  const backoff = RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const hinted = e instanceof ConnectorError && e.retry_after_s ? e.retry_after_s * 1000 : 0;
  return Math.max(backoff, hinted);
}

const contactLine = (c: Customer) => [c.phone, c.email].filter(Boolean).join(", ");

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new ConnectorError("channel_unavailable", `owner channel did not answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

class KeyTaken extends Error {}

// ---- ops ----

/**
 * Message ops for the configured owner channel, or undefined when there is none or it only writes the log
 * (the tools and routes are then not registered: a message nobody reads must not be reported as delivered).
 */
export function createMessageOps(deps: MessageDeps): MessageOps | undefined {
  const { config, store, channel } = deps;
  if (!channel || channel.logOnly) return undefined;
  const merchant = config.merchant_id;
  const enabled = deps.settings.messages_enabled;
  const mode: ThreadMode = supportsThreads(channel) ? "two_way" : "one_way";
  const clock = deps.now ?? (() => new Date());
  const timers: Timers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const log = deps.log ?? ((line: string) => console.error(line));
  const rateLimit = messageRateLimit(config.limits);
  // The channel should time out on its own (connector_timeout_ms); this only bounds a hung provider.
  const sendTimeoutMs = config.limits.connector_timeout_ms + 2000;
  let timer: unknown;
  let sweeping: Promise<void> | null = null;
  let lastHintMs = -Infinity;
  /** Set by stop(): requests that arrive during shutdown answer at once instead of holding. */
  let stopping = false;
  /** Held get_thread requests, at most one per thread; size is the global count (limits.max_waiting_requests). */
  const waiters = new Map<string, (outcome: WaitOutcome) => void>();

  const local = (ms: number) => formatInZone(ms, config.timezone);
  const disabled = <T>(): Result<T> => err("messages_disabled", "The business has paused messages", { retryable: false });

  const bookingLog = (outcome: string, contact: string | null, idemKey: string | null, detail: Record<string, unknown>) => {
    try {
      store.log({ merchant_id: merchant, idem_key: idemKey, quote_id: null, contact, outcome, detail }, clock().toISOString());
    } catch {
      // The log must never change the outcome.
    }
  };

  function view(t: ThreadRow): ThreadView {
    const out = store.listOutbox(t.thread_id);
    const delivery: Delivery = out.some((o) => o.state === "failed") ? "failed" : out.some((o) => o.state !== "delivered") ? "queued" : "delivered";
    return {
      thread_id: t.thread_id,
      status: t.state,
      poll_after_seconds: t.mode === "two_way" && t.state === "awaiting_owner" ? POLL_SECONDS : 0,
      delivery,
      owner_replies_in_band: t.mode === "two_way",
      customer: t.customer,
      messages: store.listThreadMessages(t.thread_id).map((m) => ({ from: m.author, text: m.text, at: m.at })),
    };
  }

  /** The thread, if id and token match. Missing id, unknown id and wrong token all look the same to the caller. */
  function authorize(req: GetThreadRequest | undefined): ThreadRow | null {
    const id = typeof req?.thread_id === "string" ? req.thread_id : "";
    const token = typeof req?.read_token === "string" ? req.read_token : "";
    if (!id || !token) return null;
    const t = store.getThread(id);
    if (!t || t.merchant_id !== merchant) return null;
    const want = Buffer.from(t.token_hash, "hex");
    const got = sha256(token);
    return want.length === got.length && timingSafeEqual(want, got) ? t : null;
  }

  function replay<T>(key: string, hash: string): Result<T> | null {
    const prior = store.getMessageRequest(merchant, key);
    if (!prior) return null;
    if (prior.request_hash !== hash) return err("idempotency_conflict", "This idempotency_key was used with a different message");
    if (prior.response === null) {
      return err("message_in_progress", "The first request with this idempotency_key is still being delivered; retry with the same key", {
        retry_after_s: 2,
      });
    }
    return ok(prior.response as T);
  }

  function badKey(key: unknown): GatewayError | null {
    if (key === undefined) return null;
    if (typeof key !== "string" || key.length < 1 || key.length > 255) {
      return err("invalid_request", "idempotency_key must be 1-255 characters; reuse it when retrying").error;
    }
    return null;
  }

  /** A bookable service, else an ask-the-owner one (also a valid service_id here); only the name is used. */
  async function lookupService(id: string): Promise<{ name: string } | "unknown" | undefined> {
    const ask = (bookable: Service[]) => askServices(config, bookable).find((a) => a.id === id);
    if (!deps.listServices) return ask([]);
    let services: Service[];
    try {
      services = await deps.listServices();
    } catch {
      return ask([]);
    }
    return services.find((s) => s.id === id) ?? ask(services) ?? "unknown";
  }

  function openerText(t: ThreadRow, text: string, service: { name: string } | undefined): string {
    const lines = [
      `New message for ${config.name} from a customer's AI assistant (thread ${t.thread_id})`,
      `From: ${t.customer.name} (${contactLine(t.customer)})`,
    ];
    if (t.service_id) lines.push(`About: ${service?.name ?? t.service_id}`);
    lines.push("", text, "");
    lines.push(
      t.mode !== "two_way"
        ? "Replies cannot be passed back from here: contact the customer directly."
        : channel?.flat
          ? FLAT_REPLY_HINT
          : "Reply in this thread and the assistant will pass it on. If the assistant does not come back, the customer's contact is above.",
    );
    return lines.join("\n");
  }

  function followUpText(t: ThreadRow, text: string, done: boolean): string {
    // With done the closing line rides in the same post, so it can never arrive before the message.
    return t.mode === "two_way"
      ? `Follow-up from the assistant:\n\n${text}${done ? `\n\n${CLOSE_NOTICE}` : ""}`
      : `Follow-up on thread ${t.thread_id} from ${t.customer.name} (${contactLine(t.customer)}):\n\n${text}\n\nContact the customer directly to reply.`;
  }

  /** Best effort, not awaited: a slow channel must not hold up the agent or a booking. Also mirrors top-level owner replies. */
  function postNotice(t: ThreadRow, text: string): void {
    if (t.mode !== "two_way" || !t.provider_ref || !supportsThreads(channel)) return;
    const ref = t.provider_ref;
    try {
      withTimeout(channel.postToThread(ref, text), sendTimeoutMs).catch((e) => log(`[gateway] close notice failed thread=${t.thread_id}: ${errMsg(e)}`));
    } catch (e) {
      log(`[gateway] close notice failed thread=${t.thread_id}: ${errMsg(e)}`);
    }
  }

  function closeRow(t: ThreadRow, by: string, detail: Record<string, unknown> = {}): void {
    store.updateThread(t.thread_id, { state: "closed", updated_at_ms: clock().getTime() });
    log(`[gateway] thread closed thread=${t.thread_id} by=${by}`);
    bookingLog("thread_closed", null, null, { thread_id: t.thread_id, by, ...detail });
    wake(t.thread_id, "closed");
  }

  /** Answer the thread's held get_thread, if any, with the current view. */
  function wake(threadId: string, outcome: WaitOutcome): void {
    waiters.get(threadId)?.(outcome);
  }

  const dedupeKey = (threadId: string, outboxId: number) => `${threadId}:${outboxId}`;

  /** Hand one message to the channel. Returns the provider's thread handle for an opener. */
  async function deliver(outboxId: number, kind: OutboxKind, text: string, t: ThreadRow): Promise<string | undefined> {
    if (kind === "notify") {
      await channel!.notify(text);
      return undefined;
    }
    if (!supportsThreads(channel)) throw new ConnectorError("channel_rejected", "owner channel cannot carry threads");
    const dedupe_key = dedupeKey(t.thread_id, outboxId);
    if (kind === "open") return (await channel.openThread({ thread_id: t.thread_id, text, dedupe_key })).provider_ref;
    await channel.postToThread(t.provider_ref!, text, { dedupe_key });
    return undefined;
  }

  /** Before a re-send: the provider's id of the message if an earlier attempt already posted it. */
  async function alreadyPosted(row: OutboxRow, t: ThreadRow): Promise<string | null> {
    if (row.kind === "notify" || !channel!.findPosted) return null;
    return channel!.findPosted({
      dedupe_key: dedupeKey(t.thread_id, row.id),
      provider_ref: row.kind === "post" ? t.provider_ref! : undefined,
      since_ms: row.created_at_ms ?? Date.parse(t.created_at),
    });
  }

  function markDelivered(row: Pick<OutboxRow, "id" | "thread_id">, ref: string | undefined): void {
    const now = clock();
    const iso = now.toISOString();
    store.tx(() => {
      if (ref) store.setProviderRef(row.thread_id, ref, now.getTime());
      store.updateOutbox(row.id, { state: "delivered" }, iso);
    });
  }

  /** First attempt, in the request. "permanent" means the caller must undo what it stored. */
  async function sendNow(outboxId: number, kind: OutboxKind, text: string, t: ThreadRow): Promise<{ result: "delivered" | "queued" } | { result: "permanent"; error: unknown }> {
    try {
      const ref = await withTimeout(deliver(outboxId, kind, text, t), sendTimeoutMs);
      markDelivered({ id: outboxId, thread_id: t.thread_id }, ref);
      return { result: "delivered" };
    } catch (e) {
      if (classify(e) === "permanent") return { result: "permanent", error: e };
      const now = clock();
      store.updateOutbox(outboxId, { state: "queued", next_at_ms: now.getTime() + retryDelayMs(1, e), last_error: errMsg(e) }, now.toISOString());
      log(`[gateway] owner channel send failed thread=${t.thread_id} kind=${kind} attempt=1 retry_in=${Math.round(retryDelayMs(1, e) / 1000)}s: ${errMsg(e)}`);
      return { result: "queued" };
    }
  }

  const permanentError = <T>(): Result<T> =>
    err("channel_unavailable", "The business's message channel refused the message; tell the user to contact the business another way", {
      retryable: false,
    });

  async function leaveMessageInner(req: LeaveMessageRequest | undefined, key: string | undefined, customer: Customer): Promise<Result<LeaveMessageResult>> {
    if (!enabled) return disabled();
    const kerr = badKey(req?.idempotency_key);
    if (kerr) return fail(kerr);
    const bad = validateCustomer(customer);
    if (bad) return err("invalid_customer", `${bad}, so the owner can reach them`);
    const text = cleanMessage(req?.message);
    if (isErr(text)) return fail(text);
    let service: { name: string } | undefined;
    let serviceId: string | null = null;
    if (req?.service_id !== undefined && req.service_id !== null && req.service_id !== "") {
      if (typeof req.service_id !== "string") return err("invalid_request", "service_id must be a string");
      const found = await lookupService(req.service_id);
      if (found === "unknown") return err("unknown_service", `No service "${req.service_id}"; GET /api/services lists them, or leave service_id out`);
      service = found;
      serviceId = req.service_id;
    }

    // No await from here to the claim: two requests with one key cannot both pass the lookup.
    const now = clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const hash = requestHash(["leave", customer.name, customer.phone ?? "", customer.email ?? "", text, serviceId ?? ""]);
    if (key) {
      const prior = replay<LeaveMessageResult>(key, hash);
      if (prior) return prior;
    }
    const keys = contactKeys(customer);
    const open = store.countOpenThreads(merchant, keys);
    if (open >= config.limits.max_open_threads_per_contact) {
      return err(
        "thread_limit_reached",
        `This contact already has ${open} open message thread(s); the limit is ${config.limits.max_open_threads_per_contact}. Use follow_up on an existing thread.`,
      );
    }
    const limited = rateLimit(keys, nowMs);
    if (limited) return fail(limited);

    const token = randomBytes(24).toString("base64url");
    const t: ThreadRow = {
      thread_id: `t_${randomBytes(8).toString("hex")}`,
      merchant_id: merchant,
      token_hash: sha256(token).toString("hex"),
      state: "awaiting_owner",
      mode,
      customer,
      contact_keys: keys,
      service_id: serviceId,
      provider_ref: null,
      agent_count: 1,
      created_at: nowIso,
      updated_at_ms: nowMs,
      closed_at_ms: null,
    };
    const kind: OutboxKind = mode === "two_way" ? "open" : "notify";
    const outText = openerText(t, text, service);
    let outboxId = 0;
    try {
      store.tx(() => {
        store.insertThread(t);
        store.insertThreadMessage({ thread_id: t.thread_id, author: "agent", text, provider_msg_id: null, at: local(nowMs) });
        outboxId = store.insertOutbox({ thread_id: t.thread_id, kind, text: outText, state: "sending", attempts: 1, next_at_ms: null }, nowIso);
        if (key && !store.claimMessageRequest({ merchant_id: merchant, idem_key: key, request_hash: hash, thread_id: t.thread_id }, nowIso)) {
          throw new KeyTaken();
        }
      });
    } catch (e) {
      if (e instanceof KeyTaken && key) return replay<LeaveMessageResult>(key, hash) ?? err("message_in_progress", "Retry with the same idempotency_key");
      throw e;
    }

    const sent = await sendNow(outboxId, kind, outText, t);
    if (sent.result === "permanent") {
      store.deleteThread(t.thread_id); // cascades the message, outbox and idempotency rows
      log(`[gateway] owner channel refused a message (nothing stored): ${errMsg(sent.error)}`);
      return permanentError();
    }
    const result: LeaveMessageResult = { ...view(store.getThread(t.thread_id)!), read_token: token };
    if (key) store.setMessageResponse(merchant, key, result);
    log(`[gateway] message left thread=${t.thread_id} mode=${mode} delivery=${result.delivery}`);
    return ok(result);
  }

  async function leaveMessage(req: LeaveMessageRequest): Promise<Result<LeaveMessageResult>> {
    const key = typeof req?.idempotency_key === "string" ? req.idempotency_key : undefined;
    const customer = normalizeCustomer(req?.customer);
    delete customer.notes; // the message itself carries what the customer wants to say
    const r = await leaveMessageInner(req, key, customer);
    const contact = customer.email ?? customer.phone ?? null;
    if (r.ok) bookingLog(r.data.delivery === "queued" ? "message_queued" : "message_left", contact, key ?? null, { thread_id: r.data.thread_id });
    else bookingLog(`message_rejected:${r.error.code}`, contact, key ?? null, { message: r.error.message });
    return r;
  }

  async function getThread(req: GetThreadRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    const max = config.limits.thread_wait_max_seconds;
    const asked = typeof req.wait_s === "number" && req.wait_s > 0 ? Math.min(req.wait_s, max) : 0;
    // Nothing to wait for, or shutting down: answer now (also the plain-polling fallback).
    if (asked <= 0 || t.mode !== "two_way" || t.state !== "awaiting_owner" || req.signal?.aborted || stopping) return ok(view(t));

    // No await from here to the registration: no reply can land between the check and the hold (S1).
    const id = t.thread_id;
    wake(id, "replaced"); // before the cap, so a same-thread retry never counts against it (O4)
    if (waiters.size >= config.limits.max_waiting_requests) return ok(view(t));
    const startMs = clock().getTime();
    return new Promise((resolve) => {
      const end = (outcome: WaitOutcome) => {
        if (waiters.get(id) !== end) return; // already answered or displaced
        waiters.delete(id);
        timers.clearTimeout(handle);
        req.signal?.removeEventListener("abort", onAbort);
        log(`[gateway] wait thread=${id} asked=${asked}s held=${clock().getTime() - startMs}ms outcome=${outcome}`);
        const v = view(store.getThread(id) ?? t);
        // A full hold with no change: call again right away (D3).
        if (outcome === "timeout" && v.status === "awaiting_owner") v.poll_after_seconds = 0;
        resolve(ok(v));
      };
      const onAbort = () => end("client_closed");
      waiters.set(id, end);
      const handle = timers.setTimeout(() => end("timeout"), asked * 1000);
      req.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function agentFollowUp(req: FollowUpRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    const kerr = badKey(req?.idempotency_key);
    if (kerr) return fail(kerr);
    const key = req.idempotency_key;
    const text = cleanMessage(req?.message);
    if (isErr(text)) return fail(text);
    if (req.done !== undefined && req.done !== null && typeof req.done !== "boolean") return err("invalid_request", "done must be true or false");
    const done = req.done === true;

    const now = clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const hash = requestHash(done ? ["follow_up", t.thread_id, text, "done"] : ["follow_up", t.thread_id, text]);
    if (key) {
      const prior = replay<ThreadView>(key, hash);
      if (prior) return prior;
    }
    const tr = transition(t.state, "agent_message");
    if (!tr.ok) return err("thread_closed", "This thread is closed; call leave_message to start a new one");
    if (t.agent_count >= MAX_AGENT_MESSAGES) {
      return err("thread_closed", `This thread reached ${MAX_AGENT_MESSAGES} messages; call leave_message to start a new one`);
    }
    const limited = rateLimit([], nowMs);
    if (limited) return fail(limited);

    const kind: OutboxKind = mode === "two_way" ? "post" : "notify";
    // Keep the owner's view in order: while anything earlier is still undelivered, this one waits behind it.
    const behind = kind === "post" && (!t.provider_ref || store.listOutbox(t.thread_id).some((o) => o.state !== "delivered"));
    const outText = followUpText(t, text, done);
    const nextState: ThreadState = done ? "closed" : tr.state;
    let outboxId = 0;
    let messageId = 0;
    try {
      store.tx(() => {
        messageId = store.insertThreadMessage({ thread_id: t.thread_id, author: "agent", text, provider_msg_id: null, at: local(nowMs) })!;
        store.updateThread(t.thread_id, { state: nextState, agent_count: t.agent_count + 1, updated_at_ms: nowMs });
        outboxId = store.insertOutbox(
          { thread_id: t.thread_id, kind, text: outText, state: behind ? "queued" : "sending", attempts: behind ? 0 : 1, next_at_ms: behind ? nowMs : null },
          nowIso,
        );
        if (key && !store.claimMessageRequest({ merchant_id: merchant, idem_key: key, request_hash: hash, thread_id: t.thread_id }, nowIso)) {
          throw new KeyTaken();
        }
      });
    } catch (e) {
      if (e instanceof KeyTaken && key) return replay<ThreadView>(key, hash) ?? err("message_in_progress", "Retry with the same idempotency_key");
      throw e;
    }

    if (!behind) {
      const sent = await sendNow(outboxId, kind, outText, t);
      if (sent.result === "permanent") {
        store.tx(() => {
          store.deleteOutbox(outboxId);
          store.deleteThreadMessage(messageId);
          if (key) store.deleteMessageRequest(merchant, key);
          // Undo against the current row, not the snapshot: an owner reply, a close or another follow-up may have landed during the send.
          const cur = store.getThread(t.thread_id);
          if (cur) {
            store.updateThread(t.thread_id, {
              state: cur.state === nextState ? t.state : cur.state,
              agent_count: Math.max(1, cur.agent_count - 1),
              updated_at_ms: t.updated_at_ms,
            });
          }
        });
        log(`[gateway] owner channel refused a follow-up thread=${t.thread_id} (not stored): ${errMsg(sent.error)}`);
        return permanentError();
      }
    }
    const result = view(store.getThread(t.thread_id)!);
    if (key) store.setMessageResponse(merchant, key, result);
    log(`[gateway] follow-up thread=${t.thread_id} delivery=${result.delivery}${done ? " done" : ""}`);
    bookingLog(result.delivery === "queued" ? "message_queued" : "message_left", null, key ?? null, { thread_id: t.thread_id, follow_up: true });
    if (done) {
      log(`[gateway] thread closed thread=${t.thread_id} by=agent`);
      bookingLog("thread_closed", null, null, { thread_id: t.thread_id, by: "agent" });
      wake(t.thread_id, "closed"); // after the send, so the close is final (O3)
    }
    return ok(result);
  }

  async function closeThread(req: GetThreadRequest): Promise<Result<ThreadView>> {
    if (!enabled) return disabled();
    const t = authorize(req);
    if (!t) return err("unknown_thread", NOT_FOUND);
    const tr = transition(t.state, "agent_close");
    if (tr.ok && tr.changed) {
      closeRow(t, "agent");
      postNotice(t, CLOSE_NOTICE);
    }
    return ok(view(store.getThread(t.thread_id)!));
  }

  async function closeForBooking(b: Booking, service?: Service): Promise<string[]> {
    if (!enabled) return [];
    const keys = contactKeys(b?.customer);
    if (!keys.length) return [];
    const text = bookedThreadNotice(b, service, config.timezone);
    const closed: string[] = [];
    for (const t of store.listOpenThreadsForContact(merchant, keys)) {
      closeRow(t, "booking", { booking_id: b.booking_id });
      postNotice(t, text);
      closed.push(t.thread_id);
    }
    return closed;
  }

  function acknowledge(t: ThreadRow, m: OwnerInboundMessage): void {
    try {
      // Best effort: the ✅ tells the owner the gateway has it; it never changes the outcome.
      channel!.acknowledge?.(t.provider_ref ?? m.provider_ref ?? "", m.provider_msg_id).catch(() => {});
    } catch {
      // ignore
    }
  }

  // Storage errors propagate on purpose: the channel must not ack, so the provider redelivers.
  async function ownerReply(m: OwnerInboundMessage): Promise<OwnerOutcome> {
    const t = typeof m?.provider_ref === "string" ? store.getThreadByProviderRef(m.provider_ref) : null;
    if (!t || t.merchant_id !== merchant) return "ignored";
    const text = typeof m.text === "string" ? m.text.normalize("NFC").trim() : "";
    if (!text || !m.provider_msg_id || store.hasProviderMessage(m.provider_msg_id)) return "ignored";
    const tr = transition(t.state, "owner_reply");
    if (!tr.ok) return "rejected:thread_closed";
    const now = clock();
    const stored = store.tx(() => {
      const id = store.insertThreadMessage({ thread_id: t.thread_id, author: "owner", text, provider_msg_id: m.provider_msg_id, at: local(now.getTime()) });
      if (id === null) return false;
      store.updateThread(t.thread_id, { state: tr.state, updated_at_ms: now.getTime() });
      return true;
    });
    if (!stored) return "ignored";
    log(`[gateway] owner replied thread=${t.thread_id} by=${m.user_id}`);
    bookingLog("owner_replied", null, null, { thread_id: t.thread_id });
    wake(t.thread_id, "replied");
    acknowledge(t, m);
    return "accepted";
  }

  async function ownerClose(m: OwnerInboundMessage): Promise<OwnerOutcome> {
    const t = typeof m?.provider_ref === "string" ? store.getThreadByProviderRef(m.provider_ref) : null;
    if (!t || t.merchant_id !== merchant) return "ignored";
    const tr = transition(t.state, "owner_close");
    if (!tr.ok || !tr.changed) return "ignored";
    closeRow(t, "owner");
    acknowledge(t, m);
    return "accepted";
  }

  /** The several-waiting hint, at most once a minute. Not for a message fetched after a gap: it would arrive long after the owner typed. */
  function hint(m: OwnerInboundMessage): void {
    const nowMs = clock().getTime();
    if (m.backfilled || nowMs - lastHintMs < HINT_EVERY_MS) return;
    lastHintMs = nowMs;
    try {
      channel!.notify(channel!.flat ? SEVERAL_WAITING_HINT_FLAT : SEVERAL_WAITING_HINT).catch((e) => log(`[gateway] owner hint failed: ${errMsg(e)}`));
    } catch (e) {
      log(`[gateway] owner hint failed: ${errMsg(e)}`);
    }
  }

  /**
   * Ask the owner which thread the message answers (askWhichThread), else the hint. Awaited, once per message, no rate
   * limit: a throw propagates so the provider redelivers. Nothing is asked about a message fetched after a gap.
   */
  async function askOrHint(m: OwnerInboundMessage, candidates: ThreadRow[]): Promise<void> {
    if (!channel!.askWhichThread) return hint(m);
    if (m.backfilled) return;
    await channel!.askWhichThread(m, threadChoices(candidates));
    log(`[gateway] top-level owner message: asked which customer (${candidates.length} choices)`);
  }

  /** The open two-way threads of this merchant among `refs`, oldest first. */
  function openInScope(refs: string[]): ThreadRow[] {
    const out: ThreadRow[] = [];
    for (const ref of new Set(refs)) {
      const t = typeof ref === "string" ? store.getThreadByProviderRef(ref) : null;
      if (t && t.merchant_id === merchant && t.mode === "two_way" && t.state !== "closed") out.push(t);
    }
    return out.sort((a, b) => (a.created_at === b.created_at ? (a.thread_id < b.thread_id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  }

  /**
   * One choice per thread: the customer's name, plus a suffix where names collide (case-insensitive): the service, else
   * the phone's last 4 digits, else the thread id, whichever first tells that group apart. Detail: the latest agent message.
   */
  function threadChoices(threads: ThreadRow[]): ThreadChoice[] {
    // Config only (no catalog call): a Square service id shows as itself.
    const serviceName = (id: string) => [...config.services, ...config.ask_services].find((x) => x.id === id)?.name ?? id;
    const suffixes: ((t: ThreadRow) => string | undefined)[] = [
      (t) => (t.service_id ? serviceName(t.service_id) : undefined),
      (t) => {
        const digits = (t.customer.phone ?? "").replace(/\D/g, "");
        return digits.length >= 4 ? digits.slice(-4) : undefined;
      },
      (t) => t.thread_id.slice(-4),
      (t) => t.thread_id,
    ];
    const name = (t: ThreadRow) => t.customer.name.trim();
    const groups = new Map<string, ThreadRow[]>();
    for (const t of threads) groups.set(name(t).toLowerCase(), [...(groups.get(name(t).toLowerCase()) ?? []), t]);
    const titles = new Map<string, string>();
    for (const group of groups.values()) {
      if (group.length === 1) {
        titles.set(group[0]!.thread_id, name(group[0]!));
        continue;
      }
      // The last suffix (the full thread id) always tells them apart.
      const pick = suffixes.find((f) => {
        const vals = group.map(f);
        return vals.every(Boolean) && new Set(vals.map((v) => v!.toLowerCase())).size === group.length;
      })!;
      for (const t of group) titles.set(t.thread_id, `${name(t)} (${pick(t)})`);
    }
    return threads.map((t) => {
      const last = store.listThreadMessages(t.thread_id).filter((x) => x.author === "agent").at(-1);
      const line = last?.text.replace(/\s+/g, " ").trim();
      const cps = line ? [...line] : [];
      const detail = cps.length > CHOICE_DETAIL_CHARS ? `${cps.slice(0, CHOICE_DETAIL_CHARS - 1).join("")}…` : line || undefined;
      return { provider_ref: t.provider_ref!, thread_id: t.thread_id, title: titles.get(t.thread_id)!, ...(detail ? { detail } : {}) };
    });
  }

  /**
   * A top-level owner message: the reply to the one waiting thread, a question (or hint) when several wait, nothing when
   * none do. With scope_refs (a channel that could not route it) it never auto-matches: it asks over the open threads in scope.
   */
  async function ownerTopLevel(m: OwnerInboundMessage, close: boolean): Promise<OwnerOutcome> {
    const text = typeof m.text === "string" ? m.text.normalize("NFC").trim() : "";
    // Dedup first: a redelivered message must not be matched to a different thread now waiting.
    if (!text || !m.provider_msg_id || store.hasProviderMessage(m.provider_msg_id)) return "ignored";
    if (Array.isArray(m.scope_refs)) {
      const open = openInScope(m.scope_refs);
      if (open.length > 0) await askOrHint(m, open);
      log(`[gateway] top-level owner message not routed by the channel: ${open.length} open threads in scope`);
      return "ignored";
    }
    const waiting = store.listAwaitingOwnerThreads(merchant);
    if (waiting.length === 0) return "ignored";
    if (waiting.length > 1) {
      await askOrHint(m, waiting);
      log(`[gateway] top-level owner message ignored: ${waiting.length} threads awaiting the owner`);
      return "ignored";
    }
    const t = waiting[0]!;
    if (m.backfilled || m.sent_at_ms !== undefined) {
      // "Exactly one thread waiting" must have been true when the owner typed, not just now (a Slack catch-up or a
      // delayed webhook retry). Another thread opening, closing, being answered or getting a follow-up in the window
      // means the message may belong to someone else. The waiting thread's own opening inside that window is the
      // prompt being answered, not that ambiguity.
      const sent = m.sent_at_ms;
      if (typeof sent !== "number" || !Number.isFinite(sent)) {
        log(`[gateway] top-level owner message from a gap ignored: threads changed since it was typed`);
        return "ignored";
      }
      // While nothing else has touched the thread, updated_at_ms is when the opener became visible. After a
      // follow-up that stamp moves, so the row's creation is the earliest it could have been the one waiting.
      const openedAt = t.agent_count === 1 ? t.updated_at_ms : Date.parse(t.created_at);
      if (openedAt > sent + BACKFILL_SKEW_MS || store.countThreadsTouchedSince(merchant, sent - BACKFILL_SKEW_MS, t.thread_id) > 0) {
        log(`[gateway] top-level owner message from a gap ignored: threads changed since it was typed`);
        return "ignored";
      }
    }
    const routed: OwnerInboundMessage = { ...m, provider_ref: t.provider_ref! };
    const outcome = close ? await ownerClose(routed) : await ownerReply(routed);
    // The mirror puts the reply where the thread is read; a flat channel has no thread, and the owner just typed it.
    if (outcome === "accepted" && !channel!.flat) postNotice(t, `${MIRROR_PREFIX}\n\n${text}`);
    return outcome;
  }

  const onOwnerMessage: OwnerMessageHandler = async (m) => {
    if (!enabled) return "ignored";
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    const close = OWNER_CLOSE_WORDS.test(text);
    if (m && typeof m.provider_ref !== "string") return ownerTopLevel(m, close);
    return close ? ownerClose(m) : ownerReply(m);
  };

  async function sweepOne(row: OutboxRow): Promise<void> {
    const t = store.getThread(row.thread_id);
    if (!t) return; // purged meanwhile
    const now = clock();
    const iso = now.toISOString();
    if (row.kind === "post" && !t.provider_ref) {
      const opener = store.listOutbox(t.thread_id).find((o) => o.kind === "open");
      if (!opener || opener.state === "failed") {
        store.updateOutbox(row.id, { state: "failed", last_error: "the thread's first message was never delivered" }, iso);
        bookingLog("message_failed", null, null, { thread_id: t.thread_id });
        return;
      }
      store.deferOutbox(row.id, now.getTime() + RETRY_BASE_MS, iso);
      return;
    }
    try {
      // An earlier attempt may have reached the channel without the gateway learning it; a failed lookup counts as a failed send.
      const found = row.attempts > 1 ? await withTimeout(alreadyPosted(row, t), sendTimeoutMs) : null;
      if (found) {
        markDelivered(row, row.kind === "open" ? found : undefined);
      } else {
        const ref = await withTimeout(deliver(row.id, row.kind, row.text, t), sendTimeoutMs);
        markDelivered(row, ref);
      }
      log(`[gateway] owner channel ${found ? "reconciled (already posted)" : "delivered"} thread=${t.thread_id} kind=${row.kind} attempt=${row.attempts}`);
      bookingLog("message_delivered", null, null, { thread_id: t.thread_id, attempts: row.attempts });
    } catch (e) {
      const after = clock();
      if (classify(e) === "permanent" || row.attempts > MAX_RETRIES) {
        store.updateOutbox(row.id, { state: "failed", last_error: errMsg(e) }, after.toISOString());
        log(`[gateway] owner channel gave up thread=${t.thread_id} kind=${row.kind} attempts=${row.attempts}: ${errMsg(e)}`);
        bookingLog("message_failed", null, null, { thread_id: t.thread_id, attempts: row.attempts });
        return;
      }
      const delay = retryDelayMs(row.attempts, e);
      store.updateOutbox(row.id, { state: "queued", next_at_ms: after.getTime() + delay, last_error: errMsg(e) }, after.toISOString());
      log(`[gateway] owner channel send failed thread=${t.thread_id} kind=${row.kind} attempt=${row.attempts} retry_in=${Math.round(delay / 1000)}s: ${errMsg(e)}`);
    }
  }

  /**
   * Demo mode: so an agent is never left waiting on a playground, a thread the owner has not answered within
   * `after_ms` gets a templated owner reply, stored like a real one (the thread becomes answered) and posted in
   * the owner's thread so the channel shows what the agent was told. Keyed by the thread's last change, so each
   * unanswered agent message gets at most one.
   */
  function answerForAwayOwner(away: { after_ms: number; text: string }, nowMs: number): void {
    for (const t of store.listAwaitingOwnerThreads(merchant)) {
      if (t.updated_at_ms > nowMs - away.after_ms) continue;
      const tr = transition(t.state, "owner_reply");
      if (!tr.ok) continue;
      const stored = store.tx(() => {
        const id = store.insertThreadMessage({ thread_id: t.thread_id, author: "owner", text: away.text, provider_msg_id: `away:${t.thread_id}:${t.updated_at_ms}`, at: local(nowMs) });
        if (id === null) return false;
        store.updateThread(t.thread_id, { state: tr.state, updated_at_ms: nowMs });
        return true;
      });
      if (!stored) continue;
      log(`[gateway] owner away: templated reply thread=${t.thread_id}`);
      bookingLog("owner_away_reply", null, null, { thread_id: t.thread_id });
      wake(t.thread_id, "replied");
      postNotice(t, away.text);
    }
  }

  async function sweepInner(): Promise<void> {
    const now = clock();
    const nowMs = now.getTime();
    const answeredCutoff = nowMs - config.limits.thread_close_after_reply_hours * HOUR_MS;
    const awaitingCutoff = nowMs - config.limits.thread_close_unanswered_days * 24 * HOUR_MS;
    for (const id of store.expireIdleThreads(answeredCutoff, awaitingCutoff, nowMs)) {
      log(`[gateway] thread closed thread=${id} by=expiry`);
      bookingLog("thread_closed", null, null, { thread_id: id, by: "expiry" });
      wake(id, "closed");
    }
    store.purgeClosedThreads(nowMs - PURGE_CLOSED_MS);
    if (deps.ownerAway) answerForAwayOwner(deps.ownerAway, nowMs);
    // Sequential on purpose: a slow provider must not pile up parallel sends.
    for (const row of store.claimDueOutbox(nowMs, SWEEP_BATCH, now.toISOString())) await sweepOne(row);
  }

  function sweep(): Promise<void> {
    if (!sweeping) {
      sweeping = sweepInner().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  return {
    enabled,
    mode,
    leaveMessage,
    getThread,
    agentFollowUp,
    closeThread,
    closeForBooking,
    ownerReply,
    ownerClose,
    onOwnerMessage,
    sweep,

    async start() {
      if (!enabled) return;
      if (supportsThreads(channel)) {
        channel.onOwnerMessage(onOwnerMessage, {
          openThreadRefs: () => store.listOpenThreadRefs(merchant),
          getCursor: () => store.getChannelState(CURSOR_KEY),
          setCursor: (c) => store.setChannelState(CURSOR_KEY, c),
        });
      }
      timer = timers.setInterval(() => {
        sweep().catch((e) => log(`[gateway] outbox sweep failed: ${errMsg(e)}`));
      }, SWEEP_EVERY_MS);
      if (channel.start) {
        try {
          await channel.start();
        } catch (e) {
          // Boot continues: bookings still work, /healthz shows the channel down.
          log(`[gateway] owner channel did not start: ${errMsg(e)}`);
        }
      }
      // The channel has caught up on missed replies by now, so the sweep's expiry cannot close a thread whose answer was waiting.
      // Rows queued before a restart go out now, not 30 s from now.
      sweep().catch((e) => log(`[gateway] outbox sweep failed: ${errMsg(e)}`));
    },

    async stop() {
      // Answer every hold first, and hold no new ones, so a shutdown never cuts an agent's request.
      stopping = true;
      for (const end of [...waiters.values()]) end("shutdown");
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
      await sweeping?.catch(() => {});
      await channel.stop?.();
    },

    health() {
      const s = channel.status?.();
      return {
        mode,
        enabled,
        connected: s ? s.connected : null,
        ...(s?.last_error ? { last_error: s.last_error } : {}),
        outbox: store.outboxCounts(),
      };
    },
  };
}
