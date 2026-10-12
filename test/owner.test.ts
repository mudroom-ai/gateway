import { describe, expect, it } from "vitest";
import { bookedMessage, cancelledMessage, logOwnerChannel, notifyOwner, rescheduledMessage } from "../src/notify/owner.js";
import type { Booking } from "../src/types.js";

const TZ = "America/Los_Angeles";
const BOOKING: Booking = {
  booking_id: "b_1",
  quote_id: "q_1",
  event_id: "ev1",
  slot: { service_id: "svc_gel", start: "2026-10-09T10:00:00-07:00", end: "2026-10-09T11:00:00-07:00" },
  price_cents: 4500,
  currency: "USD",
  customer: { name: "Rae Okafor", phone: "+1 202 555 0199" },
  state: "booked",
  created_at: "2026-10-06T09:00:00-07:00",
};
const SERVICE = { id: "svc_gel", name: "Gel manicure", duration_min: 60, buffer_min: 0, price_cents: 4500 };

describe("owner messages", () => {
  it("formats a booking in the merchant zone, with an optional note", () => {
    expect(bookedMessage(BOOKING, SERVICE, TZ)).toBe("Agent booking: Rae Okafor, Gel manicure, Fri Oct 9, 10:00 AM, $45.00. Booking b_1.");
    expect(bookedMessage(BOOKING, undefined, TZ, "Please add it.")).toBe("Agent booking: Rae Okafor, svc_gel, Fri Oct 9, 10:00 AM, $45.00. Booking b_1. Please add it.");
    expect(bookedMessage({ ...BOOKING, currency: "eur" }, SERVICE, TZ)).toContain(", 45.00 EUR. ");
  });

  it("formats a cancel and a move", () => {
    expect(cancelledMessage(BOOKING, SERVICE, TZ, "Remove it.")).toBe("Agent cancelled: Rae Okafor, Gel manicure, Fri Oct 9, 10:00 AM. Booking b_1. Remove it.");
    const moved = { ...BOOKING, slot: { ...BOOKING.slot, start: "2026-10-09T10:30:00-07:00" } };
    expect(rescheduledMessage(moved, BOOKING.slot, SERVICE, TZ)).toBe(
      "Agent rescheduled: Rae Okafor, Gel manicure from Fri Oct 9, 10:00 AM to Fri Oct 9, 10:30 AM. Booking b_1.",
    );
  });
});

describe("logOwnerChannel", () => {
  it("logs the message", async () => {
    const logs: string[] = [];
    await logOwnerChannel((m) => logs.push(m)).notify("hello");
    expect(logs).toEqual(["[gateway] owner notice (no SMS configured): hello"]);
  });
});

describe("notifyOwner", () => {
  it("no-ops without a channel, returns before delivery, and swallows delivery errors", async () => {
    const warnings: string[] = [];
    await expect(notifyOwner(undefined, "hi", (m) => warnings.push(m))).resolves.toBeUndefined();
    const broken = { notify: async () => { throw new Error("sms down"); } };
    await expect(notifyOwner(broken, "hi", (m) => warnings.push(m))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0)); // delivery runs in the background
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sms down");
  });
});
