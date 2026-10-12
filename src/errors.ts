// One error shape for every operation and every HTTP response.
// Adding a code later is fine; renaming or changing a
// code's meaning, retryability or status is a contract change.

import type { Slot, Cents } from "./types.js";

export const ERROR_CODES = [
  // 400: bad input
  "invalid_request",
  "invalid_time", // bare local time / no offset
  "invalid_window", // window > 14 days, flexibility > 240 min, start in past
  "invalid_customer", // missing name or phone|email
  "invalid_message", // leave_message / follow_up: empty, too long or control characters
  // 401: bearer key present but wrong
  "unauthorized",
  // 404
  "unknown_service",
  "unknown_quote",
  "unknown_booking", // no such booking, or the contact does not match
  "unknown_thread", // no such thread, or read_token missing or wrong (one body for all three)
  // 409
  "already_booked", // booked quote + new idempotency key
  "slot_unavailable", // re-check found the slot busy; quote voided
  "idempotency_conflict", // same key, different payload
  "already_cancelled",
  "cancel_forbidden", // started already, or the merchant's cancellation window has passed
  "thread_closed", // follow-up on a closed thread, or the thread hit its message cap; start a new one
  "thread_limit_reached", // per-contact open-thread cap
  "message_in_progress", // same idempotency_key while the first request is still sending
  // 410
  "expired",
  // 422: quote could not be produced
  "no_slot",
  "over_budget",
  "blocked_by_rule",
  // 429
  "rate_limited",
  "contact_limit_reached", // per-contact open-booking cap
  // 503
  "calendar_unavailable", // timeout / 5xx upstream, retryable
  "calendar_auth_failed",
  "booking_disabled", // BOOKING_ENABLED=false kill switch
  "messages_disabled", // MESSAGES_ENABLED=false kill switch
  "channel_unavailable", // the owner channel refused the message for good (bad token, bot removed); nothing stored
  // 500
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Alternative {
  slot: Slot;
  price_cents?: Cents;
}

export interface GatewayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_s?: number;
  /** Up to 3 alternatives (quote failures, slot_unavailable). */
  alternatives?: Alternative[];
}

/** Every core op returns this. Never throw across the core/adapter boundary. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: GatewayError };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_time: 400,
  invalid_window: 400,
  invalid_customer: 400,
  invalid_message: 400,
  unauthorized: 401,
  unknown_service: 404,
  unknown_quote: 404,
  unknown_booking: 404,
  unknown_thread: 404,
  already_booked: 409,
  slot_unavailable: 409,
  idempotency_conflict: 409,
  already_cancelled: 409,
  cancel_forbidden: 409,
  thread_closed: 409,
  thread_limit_reached: 409, // like contact_limit_reached: waiting won't clear it
  message_in_progress: 409,
  expired: 410,
  no_slot: 422,
  over_budget: 422,
  blocked_by_rule: 422,
  rate_limited: 429,
  contact_limit_reached: 409, // not 429: waiting won't clear it, and 429 invites auto-retry
  calendar_unavailable: 503,
  calendar_auth_failed: 503,
  booking_disabled: 503,
  messages_disabled: 503,
  channel_unavailable: 503,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  "calendar_unavailable",
  // Retrying with the same idempotency_key returns the stored result once the first send finishes.
  "message_in_progress",
  "internal",
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function err(
  code: ErrorCode,
  message: string,
  extra: { retry_after_s?: number; alternatives?: Alternative[]; retryable?: boolean } = {},
): { ok: false; error: GatewayError } {
  const error: GatewayError = {
    code,
    message,
    retryable: extra.retryable ?? isRetryable(code),
  };
  if (extra.retry_after_s !== undefined) error.retry_after_s = extra.retry_after_s;
  if (extra.alternatives !== undefined) error.alternatives = extra.alternatives.slice(0, 3);
  return { ok: false, error };
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}
