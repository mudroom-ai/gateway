// SQLite store for quotes, bookings, the owner-visible booking log and the
// leave_message threads (threads, thread_messages, owner_outbox, message_requests).
// node:sqlite (built into Node >= 22.13), WAL mode, one file per gateway.
// All timestamps are stored as UTC epoch ms next to the RFC 3339 strings
// that were returned to the caller.

import { DatabaseSync } from "node:sqlite";
import type { AppliedRule, Booking, BookingState, Cents, Customer, QuoteState, Slot } from "../types.js";

export interface QuoteRow {
  quote_id: string;
  merchant_id: string;
  service_id: string;
  slot: Slot;
  start_ms: number;
  /** start + duration + service buffer: the span the calendar event blocks. */
  block_end_ms: number;
  price_cents: Cents;
  currency: string;
  applied_rules: AppliedRule[];
  state: QuoteState;
  created_at: string;
  expires_at: string;
  expires_at_ms: number;
  /** Set when made to move this booking (its own span was ignored): book refuses it. */
  for_booking_id?: string | null;
}

export interface BookingRow {
  merchant_id: string;
  idem_key: string;
  request_hash: string;
  quote_id: string;
  booking_id: string;
  event_id: string;
  customer: Customer;
  start_ms: number;
  /** start + duration + service buffer. */
  end_ms: number;
  state: BookingState;
  /** Stored success response, set once booked. */
  response: Booking | null;
}

export interface LogEntry {
  merchant_id: string;
  idem_key: string | null;
  quote_id: string | null;
  contact: string | null;
  outcome: string;
  detail?: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
  quote_id      TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  slot_start    TEXT NOT NULL,
  slot_end      TEXT NOT NULL,
  start_ms      INTEGER NOT NULL,
  block_end_ms  INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  applied_rules TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  for_booking_id TEXT
);
CREATE INDEX IF NOT EXISTS quotes_expires_at ON quotes (expires_at_ms);

CREATE TABLE IF NOT EXISTS bookings (
  merchant_id  TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  quote_id     TEXT NOT NULL UNIQUE,
  booking_id   TEXT NOT NULL UNIQUE,
  event_id     TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  customer     TEXT NOT NULL,
  state        TEXT NOT NULL,
  response     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (merchant_id, idem_key)
);
CREATE INDEX IF NOT EXISTS bookings_span ON bookings (start_ms, end_ms);

CREATE TABLE IF NOT EXISTS booking_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  idem_key    TEXT,
  quote_id    TEXT,
  contact     TEXT,
  outcome     TEXT NOT NULL,
  detail      TEXT
);

-- leave_message threads. The read token is stored only as a sha256 hash; the
-- plaintext lives in message_requests.response so an idempotent retry can return it.
CREATE TABLE IF NOT EXISTS threads (
  thread_id     TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  state         TEXT NOT NULL,
  mode          TEXT NOT NULL,
  customer      TEXT NOT NULL,
  contact_keys  TEXT NOT NULL,
  service_id    TEXT,
  provider_ref  TEXT,
  agent_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS threads_provider_ref ON threads (provider_ref);
CREATE INDEX IF NOT EXISTS threads_state ON threads (state);

CREATE TABLE IF NOT EXISTS thread_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  author          TEXT NOT NULL,
  text            TEXT NOT NULL,
  provider_msg_id TEXT UNIQUE,
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_messages_thread ON thread_messages (thread_id, id);

CREATE TABLE IF NOT EXISTS owner_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  state       TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  next_at_ms  INTEGER,
  last_error  TEXT,
  updated_at  TEXT NOT NULL,
  created_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_next ON owner_outbox (state, next_at_ms);

-- Small durable facts an owner channel keeps across restarts (Slack: the ts of the
-- newest message it handled, so replies typed while it was down can be fetched).
CREATE TABLE IF NOT EXISTS channel_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Idempotency for leave_message / follow_up: the row is claimed before the send;
-- response stays NULL while the send is in flight (message_in_progress).
CREATE TABLE IF NOT EXISTS message_requests (
  merchant_id  TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  response     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (merchant_id, idem_key)
);
`;

export type ThreadState = "awaiting_owner" | "answered" | "closed";
/** two_way: replies come back in-band (Slack thread). one_way: notify only, the owner contacts the customer directly. */
export type ThreadMode = "two_way" | "one_way";

export interface ThreadRow {
  thread_id: string;
  merchant_id: string;
  token_hash: string;
  state: ThreadState;
  mode: ThreadMode;
  customer: Customer;
  contact_keys: string[];
  service_id: string | null;
  provider_ref: string | null;
  /** Agent-authored messages, opener included (capped per thread). */
  agent_count: number;
  created_at: string;
  updated_at_ms: number;
  closed_at_ms: number | null;
}

export interface ThreadMessageRow {
  id: number;
  thread_id: string;
  author: "agent" | "owner";
  text: string;
  provider_msg_id: string | null;
  at: string;
}

export type OutboxState = "sending" | "queued" | "delivered" | "failed";
/** open: the thread opener (openThread); post: a follow-up into the thread; notify: one-way channel. */
export type OutboxKind = "open" | "post" | "notify";

export interface OutboxRow {
  id: number;
  thread_id: string;
  kind: OutboxKind;
  text: string;
  state: OutboxState;
  attempts: number;
  next_at_ms: number | null;
  last_error: string | null;
  /** null on rows written before the column existed. */
  created_at_ms: number | null;
}

export interface MessageRequestRow {
  merchant_id: string;
  idem_key: string;
  request_hash: string;
  thread_id: string;
  response: unknown | null;
}

type Raw = Record<string, unknown>;

function toQuote(r: Raw): QuoteRow {
  return {
    quote_id: r.quote_id as string,
    merchant_id: r.merchant_id as string,
    service_id: r.service_id as string,
    slot: { service_id: r.service_id as string, start: r.slot_start as string, end: r.slot_end as string },
    start_ms: Number(r.start_ms),
    block_end_ms: Number(r.block_end_ms),
    price_cents: Number(r.price_cents),
    currency: r.currency as string,
    applied_rules: JSON.parse(r.applied_rules as string) as AppliedRule[],
    state: r.state as QuoteState,
    created_at: r.created_at as string,
    expires_at: r.expires_at as string,
    expires_at_ms: Number(r.expires_at_ms),
    for_booking_id: (r.for_booking_id as string | null | undefined) ?? null,
  };
}

function toBooking(r: Raw): BookingRow {
  return {
    merchant_id: r.merchant_id as string,
    idem_key: r.idem_key as string,
    request_hash: r.request_hash as string,
    quote_id: r.quote_id as string,
    booking_id: r.booking_id as string,
    event_id: r.event_id as string,
    customer: JSON.parse(r.customer as string) as Customer,
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    state: r.state as BookingState,
    response: r.response ? (JSON.parse(r.response as string) as Booking) : null,
  };
}

function toThread(r: Raw): ThreadRow {
  return {
    thread_id: r.thread_id as string,
    merchant_id: r.merchant_id as string,
    token_hash: r.token_hash as string,
    state: r.state as ThreadState,
    mode: r.mode as ThreadMode,
    customer: JSON.parse(r.customer as string) as Customer,
    contact_keys: JSON.parse(r.contact_keys as string) as string[],
    service_id: (r.service_id as string | null) ?? null,
    provider_ref: (r.provider_ref as string | null) ?? null,
    agent_count: Number(r.agent_count),
    created_at: r.created_at as string,
    updated_at_ms: Number(r.updated_at_ms),
    closed_at_ms: r.closed_at_ms === null || r.closed_at_ms === undefined ? null : Number(r.closed_at_ms),
  };
}

function toOutbox(r: Raw): OutboxRow {
  return {
    id: Number(r.id),
    thread_id: r.thread_id as string,
    kind: r.kind as OutboxKind,
    text: r.text as string,
    state: r.state as OutboxState,
    attempts: Number(r.attempts),
    next_at_ms: r.next_at_ms === null || r.next_at_ms === undefined ? null : Number(r.next_at_ms),
    last_error: (r.last_error as string | null) ?? null,
    created_at_ms: r.created_at_ms === null || r.created_at_ms === undefined ? null : Number(r.created_at_ms),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Databases created before for_booking_id existed.
    const cols = this.db.prepare("PRAGMA table_info(quotes)").all() as Raw[];
    if (!cols.some((c) => c.name === "for_booking_id")) this.db.exec("ALTER TABLE quotes ADD COLUMN for_booking_id TEXT");
    // Databases created before owner_outbox.created_at_ms existed.
    const outboxCols = this.db.prepare("PRAGMA table_info(owner_outbox)").all() as Raw[];
    if (!outboxCols.some((c) => c.name === "created_at_ms")) this.db.exec("ALTER TABLE owner_outbox ADD COLUMN created_at_ms INTEGER");
    // A crash mid-send leaves rows in `sending`; nobody else will pick them up, so queue them again.
    this.resetSendingOutbox();
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside BEGIN IMMEDIATE / COMMIT; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  insertQuote(q: QuoteRow): void {
    this.db
      .prepare(
        `INSERT INTO quotes (quote_id, merchant_id, service_id, slot_start, slot_end, start_ms, block_end_ms,
           price_cents, currency, applied_rules, state, created_at, expires_at, expires_at_ms, for_booking_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.quote_id,
        q.merchant_id,
        q.service_id,
        q.slot.start,
        q.slot.end,
        q.start_ms,
        q.block_end_ms,
        q.price_cents,
        q.currency,
        JSON.stringify(q.applied_rules),
        q.state,
        q.created_at,
        q.expires_at,
        q.expires_at_ms,
        q.for_booking_id ?? null,
      );
  }

  getQuote(quoteId: string): QuoteRow | null {
    const r = this.db.prepare("SELECT * FROM quotes WHERE quote_id = ?").get(quoteId) as Raw | undefined;
    return r ? toQuote(r) : null;
  }

  setQuoteState(quoteId: string, state: QuoteState): void {
    this.db.prepare("UPDATE quotes SET state = ? WHERE quote_id = ?").run(state, quoteId);
  }

  /** Delete unbooked quotes that expired before `cutoffMs`. Returns rows removed. */
  purgeExpiredQuotes(cutoffMs: number): number {
    const r = this.db
      .prepare(
        `DELETE FROM quotes WHERE expires_at_ms < ? AND state != 'booked'
           AND quote_id NOT IN (SELECT quote_id FROM bookings)`,
      )
      .run(cutoffMs);
    return Number(r.changes);
  }

  getBookingByKey(merchantId: string, idemKey: string): BookingRow | null {
    const r = this.db
      .prepare("SELECT * FROM bookings WHERE merchant_id = ? AND idem_key = ?")
      .get(merchantId, idemKey) as Raw | undefined;
    return r ? toBooking(r) : null;
  }

  getBookingById(bookingId: string): BookingRow | null {
    const r = this.db.prepare("SELECT * FROM bookings WHERE booking_id = ?").get(bookingId) as Raw | undefined;
    return r ? toBooking(r) : null;
  }

  getBookingByQuote(quoteId: string): BookingRow | null {
    const r = this.db.prepare("SELECT * FROM bookings WHERE quote_id = ?").get(quoteId) as Raw | undefined;
    return r ? toBooking(r) : null;
  }

  /** Claim a pending row. Returns false if the quote already has a booking row (any key). */
  claimPending(
    b: Omit<BookingRow, "state" | "response"> & { start_ms: number; end_ms: number },
    nowIso: string,
  ): boolean {
    return this.tx(() => {
      if (this.getBookingByQuote(b.quote_id)) return false;
      this.db
        .prepare(
          `INSERT INTO bookings (merchant_id, idem_key, request_hash, quote_id, booking_id, event_id,
             start_ms, end_ms, customer, state, response, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          b.merchant_id,
          b.idem_key,
          b.request_hash,
          b.quote_id,
          b.booking_id,
          b.event_id,
          b.start_ms,
          b.end_ms,
          JSON.stringify(b.customer),
          nowIso,
          nowIso,
        );
      return true;
    });
  }

  /** Drop a pending claim whose write was rejected for good (bad customer), so the quote can be retried. */
  releasePending(merchantId: string, idemKey: string): void {
    this.db.prepare("DELETE FROM bookings WHERE merchant_id = ? AND idem_key = ? AND state = 'pending'").run(merchantId, idemKey);
  }

  /** Mark the booking row and its quote booked, store the response and the connector's id, all in one tx. */
  markBooked(merchantId: string, idemKey: string, response: Booking, nowIso: string): void {
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE bookings SET state = 'booked', event_id = ?, response = ?, updated_at = ? WHERE merchant_id = ? AND idem_key = ?",
        )
        .run(response.event_id, JSON.stringify(response), nowIso, merchantId, idemKey);
      this.setQuoteState(response.quote_id, "booked");
    });
  }

  /** Mark a booking cancelled and store the cancelled response. The quote stays booked (it was consumed). */
  markCancelled(bookingId: string, response: Booking, nowIso: string): void {
    this.db
      .prepare("UPDATE bookings SET state = 'cancelled', response = ?, updated_at = ? WHERE booking_id = ?")
      .run(JSON.stringify(response), nowIso, bookingId);
  }

  /** Point the booking at its new quote/appointment; the old quote is voided (its slot is free again). */
  markRescheduled(
    bookingId: string,
    oldQuoteId: string,
    next: { quote_id: string; event_id: string; start_ms: number; block_end_ms: number },
    response: Booking,
    nowIso: string,
  ): void {
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE bookings SET quote_id = ?, event_id = ?, start_ms = ?, end_ms = ?, response = ?, updated_at = ?
             WHERE booking_id = ?`,
        )
        .run(next.quote_id, next.event_id, next.start_ms, next.block_end_ms, JSON.stringify(response), nowIso, bookingId);
      this.setQuoteState(next.quote_id, "booked");
      this.setQuoteState(oldQuoteId, "void");
    });
  }

  log(e: LogEntry, nowIso: string): void {
    this.db
      .prepare(
        "INSERT INTO booking_log (at, merchant_id, idem_key, quote_id, contact, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        nowIso,
        e.merchant_id,
        e.idem_key,
        e.quote_id,
        e.contact,
        e.outcome,
        e.detail === undefined ? null : JSON.stringify(e.detail),
      );
  }

  readLog(limit = 100): Raw[] {
    return this.db.prepare("SELECT * FROM booking_log ORDER BY id DESC LIMIT ?").all(limit) as Raw[];
  }

  // ---- leave_message threads ----

  insertThread(t: ThreadRow): void {
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, merchant_id, token_hash, state, mode, customer, contact_keys, service_id,
           provider_ref, agent_count, created_at, updated_at_ms, closed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.thread_id,
        t.merchant_id,
        t.token_hash,
        t.state,
        t.mode,
        JSON.stringify(t.customer),
        JSON.stringify(t.contact_keys),
        t.service_id,
        t.provider_ref,
        t.agent_count,
        t.created_at,
        t.updated_at_ms,
        t.closed_at_ms,
      );
  }

  getThread(threadId: string): ThreadRow | null {
    const r = this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as Raw | undefined;
    return r ? toThread(r) : null;
  }

  getThreadByProviderRef(providerRef: string): ThreadRow | null {
    const r = this.db.prepare("SELECT * FROM threads WHERE provider_ref = ?").get(providerRef) as Raw | undefined;
    return r ? toThread(r) : null;
  }

  /** Set state (and closed_at when closing) plus the agent message count. */
  updateThread(threadId: string, patch: { state: ThreadState; agent_count?: number; updated_at_ms: number }): void {
    const closed = patch.state === "closed" ? patch.updated_at_ms : null;
    this.db
      .prepare(
        `UPDATE threads SET state = ?, agent_count = COALESCE(?, agent_count), updated_at_ms = ?,
           closed_at_ms = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(closed_at_ms, ?) END
         WHERE thread_id = ?`,
      )
      .run(patch.state, patch.agent_count ?? null, patch.updated_at_ms, closed, closed, threadId);
  }

  /** The opener reached the channel. Counts as a change to the thread (updated_at_ms): from now on it can be matched to owner messages. */
  setProviderRef(threadId: string, providerRef: string, nowMs: number): void {
    this.db.prepare("UPDATE threads SET provider_ref = ?, updated_at_ms = ? WHERE thread_id = ?").run(providerRef, nowMs, threadId);
  }

  deleteThread(threadId: string): void {
    // ON DELETE CASCADE removes its messages, outbox rows and idempotency rows.
    this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
  }

  /** Not-closed threads of this merchant that share any of `keys`. The open set is small (capped per contact). */
  countOpenThreads(merchantId: string, keys: string[]): number {
    const want = new Set(keys);
    const rows = this.db
      .prepare("SELECT contact_keys FROM threads WHERE merchant_id = ? AND state != 'closed'")
      .all(merchantId) as { contact_keys: string }[];
    let n = 0;
    for (const r of rows) if ((JSON.parse(r.contact_keys) as string[]).some((k) => want.has(k))) n++;
    return n;
  }

  /** Not-closed threads of this merchant that share any of `keys`. */
  listOpenThreadsForContact(merchantId: string, keys: string[]): ThreadRow[] {
    const want = new Set(keys);
    const rows = this.db.prepare("SELECT * FROM threads WHERE merchant_id = ? AND state != 'closed'").all(merchantId) as Raw[];
    return rows.map(toThread).filter((t) => t.contact_keys.some((k) => want.has(k)));
  }

  /** Two-way threads of this merchant waiting for the owner whose opener reached the channel (provider_ref set), oldest first. */
  listAwaitingOwnerThreads(merchantId: string): ThreadRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM threads WHERE merchant_id = ? AND state = 'awaiting_owner' AND mode = 'two_way' AND provider_ref IS NOT NULL
         ORDER BY created_at, thread_id`,
      )
      .all(merchantId) as Raw[];
    return rows.map(toThread);
  }

  /** provider_ref of every not-closed two-way thread of this merchant whose opener reached the channel. */
  listOpenThreadRefs(merchantId: string): string[] {
    const rows = this.db
      .prepare("SELECT provider_ref FROM threads WHERE merchant_id = ? AND state != 'closed' AND mode = 'two_way' AND provider_ref IS NOT NULL")
      .all(merchantId) as Raw[];
    return rows.map((r) => r.provider_ref as string);
  }

  /** Two-way threads of this merchant whose state or messages changed at or after `sinceMs` (new threads included). */
  countThreadsTouchedSince(merchantId: string, sinceMs: number, exceptThreadId?: string): number {
    const r = (
      exceptThreadId
        ? this.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE merchant_id = ? AND mode = 'two_way' AND updated_at_ms >= ? AND thread_id != ?").get(merchantId, sinceMs, exceptThreadId)
        : this.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE merchant_id = ? AND mode = 'two_way' AND updated_at_ms >= ?").get(merchantId, sinceMs)
    ) as Raw;
    return Number(r.n);
  }

  getChannelState(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM channel_state WHERE key = ?").get(key) as Raw | undefined;
    return r ? (r.value as string) : null;
  }

  setChannelState(key: string, value: string): void {
    this.db.prepare("INSERT INTO channel_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * Close idle threads: answered ones last touched before `answeredCutoffMs` (the owner replied
   * and the agent never came back), awaiting_owner ones before `awaitingCutoffMs`. Returns their ids.
   */
  expireIdleThreads(answeredCutoffMs: number, awaitingCutoffMs: number, nowMs: number): string[] {
    return this.tx(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT thread_id FROM threads
             WHERE (state = 'answered' AND updated_at_ms < ?) OR (state = 'awaiting_owner' AND updated_at_ms < ?)`,
          )
          .all(answeredCutoffMs, awaitingCutoffMs) as Raw[]
      ).map((r) => r.thread_id as string);
      for (const id of ids) this.updateThread(id, { state: "closed", updated_at_ms: nowMs });
      return ids;
    });
  }

  /** Delete threads closed before `cutoffMs` (and everything hanging off them). Returns rows removed. */
  purgeClosedThreads(cutoffMs: number): number {
    const r = this.db.prepare("DELETE FROM threads WHERE state = 'closed' AND closed_at_ms < ?").run(cutoffMs);
    return Number(r.changes);
  }

  /** Insert a message. Returns null when provider_msg_id was already stored (redelivered event). */
  insertThreadMessage(m: Omit<ThreadMessageRow, "id">): number | null {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO thread_messages (thread_id, author, text, provider_msg_id, at) VALUES (?, ?, ?, ?, ?)")
      .run(m.thread_id, m.author, m.text, m.provider_msg_id, m.at);
    return Number(r.changes) === 0 ? null : Number(r.lastInsertRowid);
  }

  hasProviderMessage(providerMsgId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM thread_messages WHERE provider_msg_id = ?").get(providerMsgId) !== undefined;
  }

  deleteThreadMessage(id: number): void {
    this.db.prepare("DELETE FROM thread_messages WHERE id = ?").run(id);
  }

  listThreadMessages(threadId: string): ThreadMessageRow[] {
    return (this.db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id").all(threadId) as Raw[]).map((r) => ({
      id: Number(r.id),
      thread_id: r.thread_id as string,
      author: r.author as "agent" | "owner",
      text: r.text as string,
      provider_msg_id: (r.provider_msg_id as string | null) ?? null,
      at: r.at as string,
    }));
  }

  insertOutbox(o: { thread_id: string; kind: OutboxKind; text: string; state: OutboxState; attempts: number; next_at_ms: number | null }, nowIso: string): number {
    const r = this.db
      .prepare(
        "INSERT INTO owner_outbox (thread_id, kind, text, state, attempts, next_at_ms, last_error, updated_at, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(o.thread_id, o.kind, o.text, o.state, o.attempts, o.next_at_ms, nowIso, Date.parse(nowIso));
    return Number(r.lastInsertRowid);
  }

  getOutbox(id: number): OutboxRow | null {
    const r = this.db.prepare("SELECT * FROM owner_outbox WHERE id = ?").get(id) as Raw | undefined;
    return r ? toOutbox(r) : null;
  }

  deleteOutbox(id: number): void {
    this.db.prepare("DELETE FROM owner_outbox WHERE id = ?").run(id);
  }

  updateOutbox(id: number, patch: { state: OutboxState; next_at_ms?: number | null; last_error?: string | null }, nowIso: string): void {
    this.db
      .prepare("UPDATE owner_outbox SET state = ?, next_at_ms = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(patch.state, patch.next_at_ms ?? null, patch.last_error ?? null, nowIso, id);
  }

  /**
   * Claim queued rows that are due: flip them to `sending` and count the attempt, in one
   * transaction, so an in-request send and a sweep never pick the same row.
   */
  claimDueOutbox(nowMs: number, limit: number, nowIso: string): OutboxRow[] {
    return this.tx(() => {
      const rows = (
        this.db.prepare("SELECT * FROM owner_outbox WHERE state = 'queued' AND next_at_ms <= ? ORDER BY id LIMIT ?").all(nowMs, limit) as Raw[]
      ).map(toOutbox);
      const flip = this.db.prepare("UPDATE owner_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?");
      for (const r of rows) flip.run(nowIso, r.id);
      return rows.map((r) => ({ ...r, state: "sending" as const, attempts: r.attempts + 1 }));
    });
  }

  /** Put a claimed row back without spending its attempt (it is waiting on its thread's opener). */
  deferOutbox(id: number, nextAtMs: number, nowIso: string): void {
    this.db
      .prepare("UPDATE owner_outbox SET state = 'queued', attempts = attempts - 1, next_at_ms = ?, updated_at = ? WHERE id = ?")
      .run(nextAtMs, nowIso, id);
  }

  listOutbox(threadId: string): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM owner_outbox WHERE thread_id = ? ORDER BY id").all(threadId) as Raw[]).map(toOutbox);
  }

  resetSendingOutbox(): number {
    const r = this.db.prepare("UPDATE owner_outbox SET state = 'queued', next_at_ms = COALESCE(next_at_ms, 0) WHERE state = 'sending'").run();
    return Number(r.changes);
  }

  outboxCounts(): { queued: number; failed: number } {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM owner_outbox WHERE state IN ('queued', 'sending', 'failed') GROUP BY state")
      .all() as { state: string; n: number }[];
    let queued = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.state === "failed") failed += Number(r.n);
      else queued += Number(r.n);
    }
    return { queued, failed };
  }

  /** Claim an idempotency key. Returns false when the key already has a row. */
  claimMessageRequest(r: Omit<MessageRequestRow, "response">, nowIso: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO message_requests (merchant_id, idem_key, request_hash, thread_id, response, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .run(r.merchant_id, r.idem_key, r.request_hash, r.thread_id, nowIso);
    return Number(res.changes) === 1;
  }

  getMessageRequest(merchantId: string, idemKey: string): MessageRequestRow | null {
    const r = this.db.prepare("SELECT * FROM message_requests WHERE merchant_id = ? AND idem_key = ?").get(merchantId, idemKey) as Raw | undefined;
    if (!r) return null;
    return {
      merchant_id: r.merchant_id as string,
      idem_key: r.idem_key as string,
      request_hash: r.request_hash as string,
      thread_id: r.thread_id as string,
      response: r.response ? (JSON.parse(r.response as string) as unknown) : null,
    };
  }

  setMessageResponse(merchantId: string, idemKey: string, response: unknown): void {
    this.db.prepare("UPDATE message_requests SET response = ? WHERE merchant_id = ? AND idem_key = ?").run(JSON.stringify(response), merchantId, idemKey);
  }

  deleteMessageRequest(merchantId: string, idemKey: string): void {
    this.db.prepare("DELETE FROM message_requests WHERE merchant_id = ? AND idem_key = ?").run(merchantId, idemKey);
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
