// cancel and reschedule core ops.
//
// Authorisation is booking_id (96 random bits) plus the phone or email the
// booking was made with. A wrong id or a wrong contact both answer
// `unknown_booking`, so the endpoint never confirms that an id exists.
//
// cancel is idempotent: cancelling twice returns the cancelled booking.
// reschedule is idempotent on quote_id: the new quote can only ever be
// attached to this booking, so a retry returns the moved booking. The
// connector writes the new appointment before the old one is removed.

import type { Config } from "./config.js";
import { ConnectorError, type BookingConnector, type FindSlotsOptions, type CommunicationConnector } from "./connectors/types.js";
import { err, ok, type Result } from "./errors.js";
import { nearbyAlternatives, normalizeCustomer, toBookingRequest, eventIdFor } from "./book.js";
import { cancelledMessage, notifyOwner, rescheduledMessage } from "./notify/owner.js";
import { connectorErr, findService } from "./services.js";
import { formatInZone } from "./slots.js";
import type { BookingRow, Store } from "./store/sqlite.js";
import type { Booking, CancelRequest, OwnBooking, RescheduleRequest, Service } from "./types.js";

export interface CancelDeps {
  config: Config;
  connector: BookingConnector;
  store: Store;
  /** Told about each cancel and move. Never affects the result. */
  owner?: CommunicationConnector;
  now?: () => Date;
}

/** Look up the booking and check the contact. Returns the row or an error result. */
function authorise(req: CancelRequest, deps: Pick<CancelDeps, "config" | "store">): { row: BookingRow; booking: Booking } | { error: Result<never> } {
  if (typeof req?.booking_id !== "string" || !req.booking_id) {
    return { error: err("invalid_request", "booking_id is required") };
  }
  const given = normalizeCustomer({ phone: req.phone, email: req.email });
  if (!given.phone && !given.email) {
    return { error: err("invalid_request", "phone or email used for the booking is required") };
  }
  const row = deps.store.getBookingById(req.booking_id);
  const notFound = { error: err("unknown_booking", "No booking with this id for this contact") };
  if (!row || row.merchant_id !== deps.config.merchant_id || !row.response) return notFound;
  const c = row.customer;
  const phoneOk = given.phone !== undefined && c.phone !== undefined && samePhone(given.phone, c.phone);
  const emailOk = given.email !== undefined && c.email === given.email;
  if (!phoneOk && !emailOk) return notFound;
  return { row, booking: row.response };
}

/**
 * slots/quote while moving a booking: when the request names one (booking_id plus
 * its phone or email), the span it blocks, to be treated as free. Same
 * authorisation as cancel. Returns null when no booking_id was given.
 */
export function ownBookingSpan(
  req: OwnBooking & { service_id: string },
  deps: Pick<CancelDeps, "config" | "store">,
): Result<{ booking_id: string; ignore: NonNullable<FindSlotsOptions["ignoreBooking"]> } | null> {
  if (req.booking_id === undefined || req.booking_id === null) return ok(null);
  const auth = authorise(req as CancelRequest, deps);
  if ("error" in auth) return auth.error;
  const { row, booking } = auth;
  if (booking.state === "cancelled") return err("already_cancelled", "This booking was cancelled; book a new appointment instead");
  if (booking.slot.service_id !== req.service_id) {
    return err("invalid_request", "booking_id is for another service; a booking can only move within its service");
  }
  const zone = deps.config.timezone;
  return ok({
    booking_id: row.booking_id,
    ignore: { id: row.event_id, start: formatInZone(row.start_ms, zone), end: formatInZone(row.end_ms, zone) },
  });
}

const digits = (p: string) => p.replace(/\D/g, "");

/**
 * Same number with or without the country code: one digit string is a suffix of
 * the other, and the shorter has at least 9 digits. Deliberately looser than
 * equality: the booking_id (96 random bits) is the secret, the contact only
 * stops a copied confirmation from sufficing, and users retype their own number
 * differently across chats.
 */
export function samePhone(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 9 && long.endsWith(short);
}

export async function cancel(req: CancelRequest, deps: CancelDeps): Promise<Result<Booking>> {
  const now = (deps.now ?? (() => new Date()))();
  const auth = authorise(req, deps);
  if ("error" in auth) return auth.error;
  const { row, booking } = auth;
  if (booking.state === "cancelled") return ok(booking);
  if (Date.parse(booking.slot.start) <= now.getTime()) {
    return err("cancel_forbidden", "This appointment has already started");
  }
  try {
    await deps.connector.cancel(row.event_id);
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "cancel_forbidden") return err("cancel_forbidden", e.message);
    return connectorErr(e, "cancellation");
  }
  const nowIso = now.toISOString();
  const cancelled: Booking = { ...booking, state: "cancelled", cancelled_at: formatInZone(now.getTime(), deps.config.timezone) };
  deps.store.markCancelled(row.booking_id, cancelled, nowIso);
  log(deps, row, "cancelled", nowIso);
  await tellOwner(deps, () => cancelledMessage(cancelled, undefined, deps.config.timezone, deps.connector.ownerNotes?.cancelled));
  return ok(cancelled);
}

export async function reschedule(req: RescheduleRequest, deps: CancelDeps): Promise<Result<Booking>> {
  const { config, connector, store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const auth = authorise(req, deps);
  if ("error" in auth) return auth.error;
  const { row, booking } = auth;
  if (typeof req.quote_id !== "string" || !req.quote_id) return err("invalid_request", "quote_id is required");
  if (booking.quote_id === req.quote_id) return ok(booking); // retry of a completed move
  if (booking.state === "cancelled") return err("already_cancelled", "This booking was cancelled; book a new appointment instead");

  const q = store.getQuote(req.quote_id);
  if (!q || q.merchant_id !== config.merchant_id) return err("unknown_quote", `No quote "${req.quote_id}". Call quote first.`);
  if (q.for_booking_id && q.for_booking_id !== row.booking_id) {
    return err("invalid_request", "This quote was made to move another booking; request a new quote");
  }
  if (q.state === "booked") return err("already_booked", "Quote already booked");
  if (q.state === "expired" || (q.state === "open" && nowMs >= q.expires_at_ms)) {
    if (q.state !== "expired") store.setQuoteState(q.quote_id, "expired");
    return err("expired", "Quote expired; request a new quote");
  }
  if (q.state === "void") return err("slot_unavailable", "This quote's slot was taken; request a new quote");
  if (q.service_id !== booking.slot.service_id) {
    return err("invalid_request", "The new quote must be for the same service; cancel and book again to change service");
  }
  if (Date.parse(booking.slot.start) <= nowMs) return err("cancel_forbidden", "This appointment has already started");

  let service: Service | undefined;
  try {
    service = await findService(connector, q.service_id);
  } catch {
    service = undefined;
  }
  const next = { ...row, event_id: eventIdFor(config.merchant_id, q.quote_id) };
  let external;
  try {
    external = await connector.reschedule(row.event_id, toBookingRequest(config, q, next, service));
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "slot_unavailable") {
      store.setQuoteState(q.quote_id, "void");
      return err("slot_unavailable", "The new slot was just taken; here are nearby openings", {
        alternatives: await nearbyAlternatives(q, deps, now),
      });
    }
    if (e instanceof ConnectorError && e.code === "cancel_forbidden") return err("cancel_forbidden", e.message);
    return connectorErr(e, "reschedule");
  }

  const nowIso = now.toISOString();
  const moved: Booking = {
    ...booking,
    quote_id: q.quote_id,
    event_id: external.id,
    slot: q.slot,
    price_cents: q.price_cents,
    currency: q.currency,
  };
  store.markRescheduled(row.booking_id, booking.quote_id, { ...q, event_id: external.id }, moved, nowIso);
  log(deps, { ...row, quote_id: q.quote_id }, "rescheduled", nowIso);
  await tellOwner(deps, () => rescheduledMessage(moved, booking.slot, service, config.timezone, connector.ownerNotes?.rescheduled));
  return ok(moved);
}

async function tellOwner(deps: CancelDeps, message: () => string): Promise<void> {
  if (!deps.owner) return;
  try {
    await notifyOwner(deps.owner, message());
  } catch {
    // The owner notice must never change the outcome.
  }
}

function log(deps: CancelDeps, row: BookingRow, outcome: string, nowIso: string): void {
  try {
    deps.store.log(
      {
        merchant_id: deps.config.merchant_id,
        idem_key: row.idem_key,
        quote_id: row.quote_id,
        contact: row.customer.email ?? row.customer.phone ?? null,
        outcome,
        detail: { booking_id: row.booking_id },
      },
      nowIso,
    );
  } catch {
    // The log must never change the outcome.
  }
}
