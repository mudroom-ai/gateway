// book core op. Reconcile-first idempotency:
//   1. Same idempotency key: hash differs -> idempotency_conflict; booked -> stored
//      response; pending -> getBooking(deterministic id): found -> mark booked, else continue.
//   2. Quote checks: unknown -> booked (already_booked) -> expired -> void -> kill switch.
//   3. Validate customer.
//   4. Claim a pending row (tx) -> connector.book (re-checks availability itself;
//      "slot_unavailable" voids the quote and returns alternatives).
//   5. Mark booked, store the response, write the booking log, close the
//      customer's open message threads (best effort).
// SQLite and connector writes can't be atomic; the deterministic id (or the
// platform's own idempotency) makes a retry after a crash produce one appointment.
// Known gap: no lock against concurrent books of overlapping slots; a per-merchant lock is planned.

import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { ConnectorError, type BookingConnector, type BookingRequest, type CommunicationConnector } from "./connectors/types.js";
import { err, ok, type Result } from "./errors.js";
import { bookedMessage, notifyOwner } from "./notify/owner.js";
import { newId, rulesPricer } from "./quote.js";
import { connectorErr, findService } from "./services.js";
import { findSlots, formatInZone } from "./slots.js";
import type { BookingRow, QuoteRow, Store } from "./store/sqlite.js";
import type { BookRequest, Booking, Customer, Service } from "./types.js";

export interface BookDeps {
  config: Config;
  connector: BookingConnector;
  store: Store;
  /** Kill switch: BOOKING_ENABLED env, else config. */
  bookingEnabled: boolean;
  /** Told about each new booking. Never affects the result. */
  owner?: CommunicationConnector;
  /** Closes the customer's open message threads once the booking is committed. Never affects the result. */
  threads?: { closeForBooking(b: Booking, service?: Service): Promise<unknown> };
  now?: () => Date;
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** RFC 4648 base32hex, lowercase, no padding (Google event id alphabet a-v0-9). */
export function base32hex(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** Deterministic calendar event id for a quote. */
export function eventIdFor(merchantId: string, quoteId: string): string {
  return base32hex(createHash("sha256").update(`${merchantId}\u0000${quoteId}`).digest());
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Normalize without validating; used for the request hash and storage. */
export function normalizeCustomer(c: unknown): Customer {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const out: Customer = { name: str(o.name) };
  const phone = str(o.phone);
  const email = str(o.email).toLowerCase();
  const notes = str(o.notes);
  if (phone) out.phone = phone;
  if (email) out.email = email;
  if (notes) out.notes = notes;
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;

/** Name plus at least one valid phone or email. Returns an error message or null. */
export function validateCustomer(c: Customer): string | null {
  if (!c.name) return "customer.name is required";
  if (c.name.length > 200) return "customer.name is too long (max 200)";
  if (!c.phone && !c.email) return "customer needs a phone or an email";
  if (c.email && (c.email.length > 254 || !EMAIL.test(c.email))) return "customer.email is not a valid email address";
  if (c.phone) {
    const digits = c.phone.replace(/\D/g, "").length;
    if (!PHONE.test(c.phone) || digits < 7 || digits > 15) return "customer.phone is not a valid phone number";
  }
  if (c.notes && c.notes.length > 1000) return "customer.notes is too long (max 1000)";
  return null;
}

export function requestHash(quoteId: string, customer: Customer): string {
  const canonical = JSON.stringify([quoteId, customer.name, customer.phone ?? "", customer.email ?? "", customer.notes ?? ""]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** What the connector needs to create or move an appointment for `q`. */
export function toBookingRequest(
  config: Config,
  q: QuoteRow,
  row: Pick<BookingRow, "idem_key" | "booking_id" | "event_id" | "customer">,
  service: Service | undefined,
): BookingRequest {
  return {
    event_id: row.event_id,
    idempotency_key: row.idem_key,
    booking_id: row.booking_id,
    quote_id: q.quote_id,
    service: service ?? { id: q.service_id, name: q.service_id, duration_min: 0, buffer_min: 0, price_cents: q.price_cents },
    slot: q.slot,
    block_end: formatInZone(q.block_end_ms, config.timezone),
    customer: row.customer,
    price_cents: q.price_cents,
    currency: q.currency,
  };
}

export async function book(req: BookRequest, deps: BookDeps): Promise<Result<Booking>> {
  const now = (deps.now ?? (() => new Date()))();
  const customer = normalizeCustomer(req?.customer);
  let r: Result<Booking>;
  try {
    r = await bookInner(req, customer, deps, now);
  } catch {
    r = err("internal", "booking failed unexpectedly");
  }
  try {
    deps.store.log(
      {
        merchant_id: deps.config.merchant_id,
        idem_key: typeof req?.idempotency_key === "string" ? req.idempotency_key : null,
        quote_id: typeof req?.quote_id === "string" ? req.quote_id : null,
        contact: customer.email ?? customer.phone ?? null,
        outcome: r.ok ? "booked" : r.error.code,
        detail: r.ok ? { booking_id: r.data.booking_id, event_id: r.data.event_id, price_cents: r.data.price_cents } : { message: r.error.message },
      },
      now.toISOString(),
    );
  } catch {
    // The log must never change the booking outcome.
  }
  return r;
}

async function bookInner(req: BookRequest, customer: Customer, deps: BookDeps, now: Date): Promise<Result<Booking>> {
  const { config, connector, store } = deps;
  const merchant = config.merchant_id;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  if (typeof req?.quote_id !== "string" || !req.quote_id) return err("invalid_request", "quote_id is required");
  const key = req.idempotency_key;
  if (typeof key !== "string" || key.length < 1 || key.length > 255) {
    return err("invalid_request", "idempotency_key is required (1-255 chars); reuse it when retrying");
  }
  const hash = requestHash(req.quote_id, customer);

  // 1. Reconcile first.
  const existing = store.getBookingByKey(merchant, key);
  if (existing) {
    if (existing.request_hash !== hash) {
      return err("idempotency_conflict", "This idempotency_key was used with a different quote or customer");
    }
    if (existing.state !== "pending" && existing.response) return ok(existing.response);
    let ev;
    try {
      ev = await connector.getBooking(existing.event_id);
    } catch (e) {
      return connectorErr(e, "calendar lookup");
    }
    const q = store.getQuote(existing.quote_id);
    if (ev && q) {
      // A crash between the write and markBooked: the owner was never told.
      const booking = finalize(store, q, { ...existing, event_id: ev.id }, config, nowIso);
      await tellOwner(deps, booking, undefined);
      return ok(booking);
    }
    // Appointment missing: the write never landed. Fall through and redo it.
  }

  // 2. Quote checks.
  const q = store.getQuote(req.quote_id);
  if (!q || q.merchant_id !== merchant) return err("unknown_quote", `No quote "${req.quote_id}". Call quote first.`);
  if (q.for_booking_id) {
    // Made while ignoring that booking's own span: booking it would double-book.
    return err("invalid_request", "This quote was made to move a booking; pass it to reschedule, or request a new quote to book");
  }
  if (q.state === "booked") {
    // Don't echo the booking id: it may belong to another caller.
    return err("already_booked", "Quote already booked; reuse the original idempotency_key to fetch it");
  }
  if (q.state === "expired" || (q.state === "open" && nowMs >= q.expires_at_ms)) {
    if (q.state !== "expired") store.setQuoteState(q.quote_id, "expired");
    return err("expired", "Quote expired; request a new quote");
  }
  if (q.state === "void") {
    return err("slot_unavailable", "This quote's slot was taken; request a new quote");
  }
  if (!deps.bookingEnabled) {
    return err("booking_disabled", "The merchant has paused online booking", { retryable: false });
  }

  // 3. Customer.
  const bad = validateCustomer(customer);
  if (bad) return err("invalid_customer", bad);
  if (connector.requiresPhone && !customer.phone) return err("invalid_customer", "This merchant needs the customer's phone number to book");

  // 4. Claim the pending row, then write the appointment.
  let row: BookingRow | null = existing;
  if (!row) {
    const claim = {
      merchant_id: merchant,
      idem_key: key,
      request_hash: hash,
      quote_id: q.quote_id,
      booking_id: newId("b"),
      event_id: eventIdFor(merchant, q.quote_id),
      customer,
      start_ms: q.start_ms,
      end_ms: q.block_end_ms,
    };
    if (!store.claimPending(claim, nowIso)) {
      return err("already_booked", "A booking for this quote is already in progress under another idempotency_key");
    }
    row = { ...claim, state: "pending", response: null };
  }

  let service: Service | undefined;
  try {
    service = await findService(connector, q.service_id);
  } catch {
    service = undefined;
  }
  let external;
  try {
    external = await connector.book(toBookingRequest(config, q, row, service));
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "slot_unavailable") {
      store.setQuoteState(q.quote_id, "void");
      return err("slot_unavailable", "The slot was just taken; here are nearby openings", {
        alternatives: await nearbyAlternatives(q, deps, now),
      });
    }
    if (e instanceof ConnectorError && e.code === "invalid_customer") {
      store.releasePending(merchant, key);
      return err("invalid_customer", e.message);
    }
    return connectorErr(e, "calendar write");
  }

  // 5. Mark booked, store the response, tell the owner.
  const booking = finalize(store, q, { ...row, event_id: external.id }, config, nowIso);
  await tellOwner(deps, booking, service);
  return ok(booking);
}

async function tellOwner(deps: BookDeps, booking: Booking, service: Service | undefined): Promise<void> {
  if (deps.owner) {
    try {
      await notifyOwner(deps.owner, bookedMessage(booking, service, deps.config.timezone, deps.connector.ownerNotes?.booked));
    } catch {
      // The owner notice must never change the booking outcome.
    }
  }
  if (deps.threads) {
    try {
      // The customer has what they came for: their open threads close so the owner never has to.
      await deps.threads.closeForBooking(booking, service);
    } catch {
      // Closing threads must never change the booking outcome.
    }
  }
}

function finalize(store: Store, q: QuoteRow, row: BookingRow, config: Config, nowIso: string): Booking {
  const booking: Booking = {
    booking_id: row.booking_id,
    quote_id: q.quote_id,
    event_id: row.event_id,
    slot: q.slot,
    price_cents: q.price_cents,
    currency: q.currency,
    customer: row.customer,
    state: "booked",
    created_at: formatInZone(Date.parse(nowIso), config.timezone),
  };
  store.markBooked(row.merchant_id, row.idem_key, booking, nowIso);
  return booking;
}

export async function nearbyAlternatives(q: QuoteRow, deps: { config: Config; connector: BookingConnector }, now: Date) {
  const { config } = deps;
  const day = 86_400_000;
  const start = Math.max(now.getTime(), q.start_ms - day);
  const r = await findSlots(
    {
      service_id: q.service_id,
      window: { start: formatInZone(start, config.timezone), end: formatInZone(q.start_ms + day, config.timezone) },
    },
    { config, connector: deps.connector, now: () => now, price: rulesPricer(config, now) },
  );
  if (!r.ok) return [];
  return r.data.slots
    .filter((s) => Date.parse(s.start) !== q.start_ms)
    .sort((a, b) => Math.abs(Date.parse(a.start) - q.start_ms) - Math.abs(Date.parse(b.start) - q.start_ms))
    .slice(0, 3)
    .map((s) => ({ slot: { service_id: s.service_id, start: s.start, end: s.end }, price_cents: s.price_cents }));
}
