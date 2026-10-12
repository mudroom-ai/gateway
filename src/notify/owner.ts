// Owner notices: the messages the gateway sends the merchant about agent
// bookings, and the log fallback. Delivery itself is a CommunicationConnector
// (connectors/types.ts); Twilio SMS lives in connectors/twilio.ts.

import { DateTime } from "luxon";
import type { CommunicationConnector } from "../connectors/types.js";
import type { Booking, Service, Slot } from "../types.js";

/** Writes the message to the log. Used when no SMS provider is configured. */
export function logOwnerChannel(log: (m: string) => void = (m) => console.warn(m)): CommunicationConnector {
  return {
    async notify(message) {
      log(`[gateway] owner notice (no SMS configured): ${message}`);
    },
  };
}

function local(iso: string, timezone: string): string {
  const dt = DateTime.fromMillis(Date.parse(iso), { zone: timezone });
  return dt.isValid ? dt.toFormat("ccc LLL d, h:mm a") : iso;
}

function price(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency.toUpperCase() === "USD" ? `$${amount}` : `${amount} ${currency.toUpperCase()}`;
}

const serviceName = (b: Booking, service: Service | undefined) => service?.name ?? b.slot.service_id;
const withNote = (text: string, note?: string) => (note ? `${text} ${note}` : text);

/** "Agent booking: <name>, <service>, <local time>, $<price>. Booking <id>." plus the note. */
export function bookedMessage(b: Booking, service: Service | undefined, timezone: string, note?: string): string {
  return withNote(
    `Agent booking: ${b.customer.name}, ${serviceName(b, service)}, ${local(b.slot.start, timezone)}, ${price(b.price_cents, b.currency)}. Booking ${b.booking_id}.`,
    note,
  );
}

/** In-thread notice when the customer of an open message thread books: the thread is closed for them. */
export function bookedThreadNotice(b: Booking, service: Service | undefined, timezone: string): string {
  return `The customer booked ${serviceName(b, service)} for ${local(b.slot.start, timezone)}, so the assistant has what it needs. Thanks!`;
}

/** "Agent cancelled: <name>, <service>, <local time>. Booking <id>." plus the note. */
export function cancelledMessage(b: Booking, service: Service | undefined, timezone: string, note?: string): string {
  return withNote(`Agent cancelled: ${b.customer.name}, ${serviceName(b, service)}, ${local(b.slot.start, timezone)}. Booking ${b.booking_id}.`, note);
}

/** "Agent rescheduled: <name>, <service> from <old> to <new>. Booking <id>." plus the note. */
export function rescheduledMessage(b: Booking, previous: Slot, service: Service | undefined, timezone: string, note?: string): string {
  return withNote(
    `Agent rescheduled: ${b.customer.name}, ${serviceName(b, service)} from ${local(previous.start, timezone)} to ${local(b.slot.start, timezone)}. Booking ${b.booking_id}.`,
    note,
  );
}

/** Send one notice. No-op without a channel; errors are logged, never thrown. */
/**
 * Hand the message to the channel without waiting for delivery: an SMS
 * provider's latency must not delay the agent's response. Failures are logged.
 */
export function notifyOwner(channel: CommunicationConnector | undefined, message: string, warn: (m: string) => void = (m) => console.warn(m)): Promise<void> {
  if (!channel) return Promise.resolve();
  const fail = (e: unknown) => warn(`[gateway] owner notice failed: ${(e as Error)?.message ?? e}. Message was: ${message}`);
  try {
    channel.notify(message).catch(fail);
  } catch (e) {
    fail(e);
  }
  return Promise.resolve();
}
