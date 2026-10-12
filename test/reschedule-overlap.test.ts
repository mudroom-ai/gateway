import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { book } from "../src/book.js";
import { reschedule } from "../src/cancel.js";
import { parseConfig } from "../src/config.js";
import { CalendarBookingConnector } from "../src/connectors/calendar.js";
import { quote } from "../src/quote.js";
import { findSlots } from "../src/slots.js";
import { Store } from "../src/store/sqlite.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";

const config = parseConfig({
  name: "T",
  timezone: "America/Los_Angeles",
  currency: "USD",
  services: [{ id: "cut", name: "Haircut", duration_min: 45, buffer_min: 0, price_cents: 4000 }],
  hours: { thu: [{ start: "09:00", end: "17:00" }], mon: [], tue: [], wed: [], fri: [], sat: [], sun: [] },
  default_buffer_min: 15,
});
const NOW = () => new Date("2026-10-06T16:00:00Z");
const PHONE = "+1 202 555 0199";
const AT_1015 = { start: "2026-10-08T10:15:00-07:00", end: "2026-10-08T11:00:00-07:00" };

async function setup() {
  const fake = new FakeCalendarConnector();
  const connector = new CalendarBookingConnector(config, fake);
  const store = new Store(join(mkdtempSync(join(tmpdir(), "gw-")), "t.sqlite"));
  const deps = { config, connector, store, now: NOW, bookingEnabled: true };
  const q = await quote({ service_id: "cut", window: { start: "2026-10-08T10:00:00-07:00", end: "2026-10-08T10:45:00-07:00" } }, deps);
  if (!q.ok) throw new Error(q.error.code);
  const b = await book({ quote_id: q.data.quote_id, customer: { name: "Ann", phone: PHONE }, idempotency_key: "k1" }, deps);
  if (!b.ok) throw new Error(b.error.code);
  return { fake, store, deps, booking: b.data };
}

describe("moving a booking to an overlapping slot", () => {
  it("quotes 10:15 with booking_id + phone and reschedules onto it", async () => {
    const c = await setup();
    const id = c.booking.booking_id;
    const plain = await quote({ service_id: "cut", window: AT_1015 }, c.deps);
    expect(!plain.ok && plain.error.code).toBe("no_slot");

    const slots = await findSlots({ service_id: "cut", window: AT_1015, booking_id: id, phone: "2025550199" }, c.deps);
    expect(slots.ok && slots.data.slots.map((s) => s.start)).toEqual([AT_1015.start]);

    const q = await quote({ service_id: "cut", window: AT_1015, booking_id: id, phone: PHONE }, c.deps);
    if (!q.ok) throw new Error(q.error.code);
    expect(q.data.for_booking_id).toBe(id);

    // Not usable by book: it ignores Ann's own appointment.
    const stolen = await book({ quote_id: q.data.quote_id, customer: { name: "Bob", phone: "+1 202 555 0100" }, idempotency_key: "k2" }, c.deps);
    expect(!stolen.ok && stolen.error.code).toBe("invalid_request");

    const r = await reschedule({ booking_id: id, phone: PHONE, quote_id: q.data.quote_id }, c.deps);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.slot.start).toBe(AT_1015.start);
    expect([...c.fake.events.values()].map((e) => e.start)).toEqual([AT_1015.start]);
    expect(c.fake.events.has(c.booking.event_id)).toBe(false);
  });

  it("answers unknown_booking for a wrong contact or id", async () => {
    const c = await setup();
    const wrong = await quote({ service_id: "cut", window: AT_1015, booking_id: c.booking.booking_id, phone: "+1 415 867 5309" }, c.deps);
    expect(!wrong.ok && wrong.error.code).toBe("unknown_booking");
    const noId = await findSlots({ service_id: "cut", window: AT_1015, booking_id: "b_nope", phone: PHONE }, c.deps);
    expect(!noId.ok && noId.error.code).toBe("unknown_booking");
  });
});
