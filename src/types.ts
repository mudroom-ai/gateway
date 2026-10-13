// Shared domain types. Shared contract: changing these shapes affects every adapter.
//
// Time: every timestamp is an RFC 3339 string WITH an offset. Inputs
// without an offset are rejected with `invalid_time`. Outputs use the
// merchant's zone offset; storage uses UTC instants.
// Money: integer minor units (cents) plus the config `currency`.

/** RFC 3339 timestamp with offset, e.g. "2026-10-08T15:00:00-07:00". */
export type Rfc3339 = string;

/** Integer minor units of the merchant currency. */
export type Cents = number;

/** Half-open time interval [start, end). */
export interface Interval {
  start: Rfc3339;
  end: Rfc3339;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface Service {
  id: string;
  name: string;
  description?: string;
  duration_min: number;
  buffer_min: number;
  price_cents: Cents;
}

/** Offered by the business but not bookable through the API (no fixed price or duration); agents message the owner about it. */
export interface AskService {
  id: string;
  name: string;
  /** The business's own price wording, e.g. "from $80". */
  price_note?: string;
}

/** A bookable start for one service. `end` = start + duration (buffer excluded). */
export interface Slot {
  service_id: string;
  start: Rfc3339;
  end: Rfc3339;
}

/** A slot plus the price the rules engine would charge for it. */
export interface PricedSlot extends Slot {
  price_cents: Cents;
}

export type AppliedRuleKind = "discount" | "cap" | "floor";

/** One pricing step. `amount_cents` is the signed change to the running price. */
export interface AppliedRule {
  rule_id: string;
  kind: AppliedRuleKind;
  label?: string;
  amount_cents: Cents;
}

/** Output of the pure rules engine `price(service, slot, now, config)`. */
export type PriceResult =
  | { ok: true; base_cents: Cents; price_cents: Cents; applied_rules: AppliedRule[] }
  | { ok: false; reason: "blocked_by_rule"; rule_id: string };

/** Quote state machine: open -> booked | expired | void. */
export type QuoteState = "open" | "booked" | "expired" | "void";

export interface Quote {
  quote_id: string;
  service_id: string;
  slot: Slot;
  /** Price is locked at quote time. */
  price_cents: Cents;
  currency: string;
  applied_rules: AppliedRule[];
  state: QuoteState;
  created_at: Rfc3339;
  expires_at: Rfc3339;
  /** Set when the quote was made to move this booking: only reschedule of that booking accepts it. */
  for_booking_id?: string;
}

/** Name plus at least one of phone or email. */
export interface Customer {
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export type BookingState = "pending" | "booked" | "cancelled";

export interface Booking {
  booking_id: string;
  quote_id: string;
  /** Deterministic calendar event id: base32hex(hash(merchant, quote_id)). */
  event_id: string;
  slot: Slot;
  price_cents: Cents;
  currency: string;
  customer: Customer;
  state: BookingState;
  created_at: Rfc3339;
  cancelled_at?: Rfc3339;
}

// ---- Operation inputs (HTTP request bodies) ----

export interface ListServicesResult {
  currency: string;
  timezone: string;
  services: Service[];
  /** Present only when the business lists any. */
  ask_services?: AskService[];
}

/**
 * Optional, when moving an existing booking: booking_id plus the phone or email it
 * was made with. The booking's own time then counts as free.
 */
export interface OwnBooking {
  booking_id?: string;
  phone?: string;
  email?: string;
}

export interface FindSlotsRequest extends OwnBooking {
  service_id: string;
  window: Interval;
  /** Minutes either side of the window, max 240. */
  flexibility_min?: number;
}

export interface FindSlotsResult {
  timezone: string;
  slots: PricedSlot[];
}

export interface QuoteRequest extends OwnBooking {
  service_id: string;
  window: Interval;
  max_price_cents?: Cents;
  flexibility_min?: number;
}

export interface BookRequest {
  quote_id: string;
  customer: Customer;
  idempotency_key: string;
}

/** booking_id plus the phone or email the booking was made with. */
export interface CancelRequest {
  booking_id: string;
  phone?: string;
  email?: string;
}

/** Move an existing booking to a fresh quote for the same service. Idempotent on quote_id. */
export interface RescheduleRequest extends CancelRequest {
  quote_id: string;
}
