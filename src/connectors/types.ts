// Connector contracts. Three kinds:
//
// - CalendarConnector: a plain calendar (Google). It only knows
//   busy intervals and events; the gateway's own slot engine and rules build
//   slots and prices on top (see calendar.ts).
// - BookingConnector: what the core ops talk to. A booking platform (Square)
//   implements it directly: it returns ready-made slots, sets prices and books,
//   cancels and reschedules itself. CalendarBookingConnector adapts a
//   CalendarConnector to it.
// - CommunicationConnector: how the merchant hears about agent bookings (Twilio SMS, or
//   a log line). Works with every booking connector; a connector that cannot
//   write to the merchant's own system (shadow mode) adds `ownerNotes`.
//
// Connectors throw ConnectorError; core ops map it into the shared error body.

import type { Cents, Customer, Interval, Rfc3339, Service, Slot } from "../types.js";

export interface NewCalendarEvent {
  /** Client-chosen deterministic id (base32hex). */
  id: string;
  start: Rfc3339;
  /** start + duration + buffer. */
  end: Rfc3339;
  title: string;
  description: string;
}

export interface CalendarEvent {
  id: string;
  start: Rfc3339;
  end: Rfc3339;
  title?: string;
  description?: string;
}

export interface CalendarConnector {
  /** Busy intervals overlapping `range`, unpadded (the core applies buffers). */
  getBusy(range: Interval): Promise<Interval[]>;
  /** Create the event. Throws ConnectorError("already_exists") on id collision (409). Never retried in-request. */
  insertEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  /** Fetch by id; null if it does not exist. */
  getEvent(id: string): Promise<CalendarEvent | null>;
  /** Delete by id. A missing event counts as deleted. */
  deleteEvent(id: string): Promise<void>;
  /** Startup check: throws ConnectorError("calendar_auth_failed") with a fix hint if access is missing. */
  checkAccess(): Promise<void>;
}

/** Everything a connector needs to create (or move) one appointment. */
export interface BookingRequest {
  /** Deterministic id = hash(merchant, quote_id). Calendar connectors use it as the event id; platforms may ignore it. */
  event_id: string;
  /** The agent's key; platforms with their own idempotency (Square) pass it through. */
  idempotency_key: string;
  booking_id: string;
  quote_id: string;
  service: Service;
  slot: Slot;
  /** start + duration + buffer: the span a calendar event blocks. */
  block_end: Rfc3339;
  customer: Customer;
  price_cents: Cents;
  currency: string;
}

export interface FindSlotsOptions {
  /** An existing appointment whose own time counts as free (moving it). `id` is the connector's id; start/end its blocked span. */
  ignoreBooking?: { id: string; start: Rfc3339; end: Rfc3339 };
}

/** The connector's own record of an appointment. */
export interface ExternalBooking {
  /** The connector's id (calendar event id or platform booking id). */
  id: string;
  start: Rfc3339;
  end: Rfc3339;
}

export interface BookingConnector {
  /** True when the connector sets prices itself: the rules engine is bypassed and quotes carry the service price. */
  readonly pricesServices: boolean;
  /** True when the platform cannot book without a customer phone number (Square). */
  readonly requiresPhone: boolean;
  /** Sentences appended to the owner message when the platform needs the merchant to act (shadow mode). */
  readonly ownerNotes?: { booked: string; cancelled: string; rescheduled: string };
  /** Bookable services. Calendar connectors return the config; platforms read their catalog. */
  listServices(): Promise<Service[]>;
  /** Unpriced bookable starts for `service` inside `range` (already clamped to now). */
  findSlots(service: Service, range: Interval, opts?: FindSlotsOptions): Promise<Slot[]>;
  /**
   * Create the appointment. Must be idempotent on event_id / idempotency_key.
   * Throws ConnectorError("slot_unavailable") when the slot was taken meanwhile.
   */
  book(req: BookingRequest): Promise<ExternalBooking>;
  /** Fetch by external id; null if it does not exist. */
  getBooking(id: string): Promise<ExternalBooking | null>;
  /** Cancel by external id. A missing booking counts as cancelled. Throws "cancel_forbidden" when the platform's policy refuses. */
  cancel(id: string): Promise<void>;
  /** Move the appointment `id` to `req.slot`. Returns the (possibly new) external record. Throws "slot_unavailable" if taken. */
  reschedule(id: string, req: BookingRequest): Promise<ExternalBooking>;
  /** Startup check: throws ConnectorError("calendar_auth_failed") with a fix hint if access is missing. */
  checkAccess(): Promise<void>;
}

/**
 * Third connector kind (the Communication module): how the merchant hears from
 * agents. `notify` is one-way (booking notices) and is all a provider must
 * implement (Twilio). A provider that can also carry a two-way thread (Slack)
 * implements the optional members; the core uses them only when all are present
 * (see `supportsThreads`). Delivery failures of `notify` are logged, never
 * thrown; thread methods throw ConnectorError so the core can decide between
 * queueing (transient) and refusing (permanent).
 */
export interface CommunicationConnector {
  notify(message: string): Promise<void>;
  /** Post the first message of a thread; returns the provider's thread handle (Slack: the message ts). */
  openThread?(opener: ThreadOpener): Promise<{ provider_ref: string }>;
  /** Post a follow-up into an existing thread (agent follow-ups, gateway notices). */
  postToThread?(provider_ref: string, text: string, opts?: { dedupe_key?: string }): Promise<void>;
  /**
   * Reconcile-first retry: the provider's id of a message already posted with this
   * `dedupe_key`, or null. The core asks before every re-send, so a post whose answer
   * was lost (timeout, crash) is never posted twice. Throws ConnectorError like a send.
   */
  findPosted?(q: PostedQuery): Promise<string | null>;
  /**
   * Register the handler for owner-typed messages. Called once at boot, before `start`.
   * `ctx` lets the channel fetch what it missed while disconnected (see ChannelContext).
   */
  onOwnerMessage?(handler: OwnerMessageHandler, ctx?: ChannelContext): void;
  /** Best-effort visible acknowledgement of an owner message (Slack: a ✅ reaction, keyed by the message id even when it is top-level). Never throws. */
  acknowledge?(provider_ref: string, provider_msg_id: string): Promise<void>;
  /** Open the inbound connection (Slack Socket Mode). Resolves once connected and caught up on missed replies; reconnects on its own afterwards. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Startup check: throws ConnectorError("channel_auth_failed") with a fix hint a merchant can act on. */
  checkAccess?(): Promise<void>;
  /** Live state for /healthz. */
  status?(): { connected: boolean; last_error?: string };
}

export interface ThreadOpener {
  thread_id: string;
  /** Rendered text for the owner (who, contact, service, the message, how to reply). */
  text: string;
  /** Unique per outbox row; the channel attaches it to the post so `findPosted` can find it. */
  dedupe_key?: string;
}

export interface PostedQuery {
  dedupe_key: string;
  /** Set for a follow-up: the thread to look in. Absent for an opener (look in the channel). */
  provider_ref?: string | undefined;
  /** The message cannot be older than this (when its outbox row was created). */
  since_ms: number;
}

/**
 * What a channel needs from the core to catch up after a gap (stop-then-start
 * deploy, reconnect): which threads are open, and a durable cursor (the provider's
 * id of the newest message the channel has handled; Slack: a ts).
 */
export interface ChannelContext {
  /** provider_ref of every open two-way thread. */
  openThreadRefs(): string[];
  getCursor(): string | null;
  setCursor(cursor: string): void;
}

export interface OwnerInboundMessage {
  /**
   * The thread the message was typed in (Slack: the opener's ts). Undefined for a
   * top-level message in the owner's channel, outside any thread: the core then
   * matches it to the one thread awaiting the owner, if there is exactly one,
   * posts it into that thread with `postToThread`, and otherwise may post one
   * short hint with `notify` (so `notify` must post into the same channel).
   */
  provider_ref?: string | undefined;
  /** Provider's unique id for this message (Slack: ts); the core dedups on it. */
  provider_msg_id: string;
  /** Provider user id of the author, for the optional owner allowlist. */
  user_id: string;
  text: string;
  /**
   * True when the channel fetched it after a gap instead of receiving it live. The core then skips hints about it and,
   * for a top-level message, needs `sent_at_ms` to check which thread was waiting when it was typed.
   */
  backfilled?: boolean;
  /** When the owner sent it, by the provider's clock. Required with `backfilled`. */
  sent_at_ms?: number;
}

/**
 * Returns "accepted" (persisted), "ignored" (unknown thread, duplicate, empty, or a
 * top-level message the core could not match to one waiting thread) or
 * "rejected:<reason>" (closed thread, not an owner); the channel posts one notice
 * in-thread for rejected. Throws on storage failure so the channel does NOT ack
 * and the provider redelivers.
 */
export type OwnerMessageHandler = (m: OwnerInboundMessage) => Promise<"accepted" | "ignored" | `rejected:${string}`>;

export type ThreadCapableChannel = CommunicationConnector &
  Required<Pick<CommunicationConnector, "openThread" | "postToThread" | "onOwnerMessage" | "start" | "stop">>;

export function supportsThreads(c: CommunicationConnector | undefined): c is ThreadCapableChannel {
  return !!c && !!c.openThread && !!c.postToThread && !!c.onOwnerMessage && !!c.start && !!c.stop;
}

export type ConnectorErrorCode =
  | "calendar_unavailable"
  | "calendar_auth_failed"
  | "already_exists"
  | "slot_unavailable"
  | "cancel_forbidden"
  | "unknown_booking"
  | "invalid_customer"
  | "channel_unavailable" // transient provider failure (429/5xx/timeout); core queues the send
  | "channel_auth_failed" // permanent (bad token, not in channel, missing scope); core refuses
  | "channel_rejected"; // provider refused this message (too long, bad channel); not retryable

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retry_after_s: number | undefined;

  constructor(code: ConnectorErrorCode, message: string, opts: { retry_after_s?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "ConnectorError";
    this.code = code;
    this.retry_after_s = opts.retry_after_s;
  }
}

export function isBookingConnector(c: CalendarConnector | BookingConnector): c is BookingConnector {
  return typeof (c as BookingConnector).book === "function";
}
