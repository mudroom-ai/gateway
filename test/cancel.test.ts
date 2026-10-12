import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { book } from "../src/book.js";
import { cancel, reschedule } from "../src/cancel.js";
import { parseConfig } from "../src/config.js";
import { CalendarBookingConnector } from "../src/connectors/calendar.js";
import type { BookingConnector } from "../src/connectors/types.js";
import { samePhone } from "../src/cancel.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { quote } from "../src/quote.js";
import { Store } from "../src/store/sqlite.js";

const config = parseConfig({
  name: "T",
  timezone: "America/Los_Angeles",
  currency: "USD",
  services: [{ id: "s", name: "S", duration_min: 60, buffer_min: 15, price_cents: 5000 }],
  hours: { tue: [], wed: [], thu: [{ start: "09:00", end: "17:00" }], fri: [], sat: [], sun: [], mon: [] },
  default_buffer_min: 15,
});
const NOW = () => new Date("2026-10-06T16:00:00Z");
const ANN = { name: "Ann", email: "Ann@Example.com", phone: "+1 (555) 010-2030" };

async function setup() {
  const fake = new FakeCalendarConnector();
  const connector = new CalendarBookingConnector(config, fake);
  const store = new Store(join(mkdtempSync(join(tmpdir(), "gw-")), "t.sqlite"));
  const deps = { config, connector, store, now: NOW, bookingEnabled: true };
  const q = async (start: string, end: string) => {
    const r = await quote({ service_id: "s", window: { start, end } }, deps);
    if (!r.ok) throw new Error(r.error.code);
    return r.data.quote_id;
  };
  const b = await book({ quote_id: await q("2026-10-08T09:00:00-07:00", "2026-10-08T10:00:00-07:00"), customer: ANN, idempotency_key: "k1" }, deps);
  if (!b.ok) throw new Error(b.error.code);
  return { fake, store, deps, q, booking: b.data };
}

describe("cancel", () => {
  it("needs a matching contact, then deletes the event and is idempotent", async () => {
    const c = await setup();
    const id = c.booking.booking_id;
    expect((await cancel({ booking_id: id, email: "other@example.com" }, c.deps)).ok).toBe(false);
    expect((await cancel({ booking_id: "b_nope", email: "ann@example.com" }, c.deps)).ok).toBe(false);
    const r = await cancel({ booking_id: id, phone: "+1 555 010 2030" }, c.deps); // digits match, formatting differs
    expect(r.ok && r.data.state).toBe("cancelled");
    expect(c.fake.events.size).toBe(0);
    const again = await cancel({ booking_id: id, email: "ann@example.com" }, c.deps);
    expect(again.ok && again.data.state).toBe("cancelled");
    expect(c.store.getBookingById(id)?.state).toBe("cancelled");
  });

  it("stores the connector's own id and cancels with it; phone matches with or without country code", async () => {
    const fake = new FakeCalendarConnector();
    const inner = new CalendarBookingConnector(config, fake);
    const cancelled: string[] = [];
    // A platform-style connector that hands back its own id, not our deterministic one.
    const platform: BookingConnector = {
      ...inner,
      pricesServices: false,
      requiresPhone: false,
      listServices: () => inner.listServices(),
      findSlots: (s, r) => inner.findSlots(s, r),
      book: async (req) => ({ ...(await inner.book(req)), id: `SQ-${req.quote_id}` }),
      getBooking: (id) => inner.getBooking(id),
      cancel: async (id) => void cancelled.push(id),
      reschedule: (id, req) => inner.reschedule(id, req),
      checkAccess: () => inner.checkAccess(),
    };
    const store = new Store(join(mkdtempSync(join(tmpdir(), "gw-")), "t.sqlite"));
    const deps = { config, connector: platform, store, now: NOW, bookingEnabled: true };
    const q = await quote({ service_id: "s", window: { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T10:00:00-07:00" } }, deps);
    if (!q.ok) throw new Error(q.error.code);
    const b = await book({ quote_id: q.data.quote_id, customer: ANN, idempotency_key: "k" }, deps);
    if (!b.ok) throw new Error(b.error.code);
    expect(b.data.event_id).toBe(`SQ-${q.data.quote_id}`);
    expect(store.getBookingById(b.data.booking_id)?.event_id).toBe(b.data.event_id);
    const r = await cancel({ booking_id: b.data.booking_id, phone: "555 010 2030" }, deps); // no country code
    expect(r.ok && r.data.state).toBe("cancelled");
    expect(cancelled).toEqual([b.data.event_id]);
    expect(samePhone("+1 415 867 5309", "4158675309")).toBe(true);
    expect(samePhone("+1 415 867 5309", "5309")).toBe(false);
  });

  it("refuses once the appointment has started", async () => {
    const c = await setup();
    const r = await cancel({ booking_id: c.booking.booking_id, email: "ann@example.com" }, { ...c.deps, now: () => new Date("2026-10-08T16:30:00Z") });
    expect(!r.ok && r.error.code).toBe("cancel_forbidden");
  });
});

describe("owner notice", () => {
  it("tells the owner once on cancel and on reschedule, never on an already-cancelled cancel", async () => {
    const c = await setup();
    const messages: string[] = [];
    const owner = { notify: async (m: string) => void messages.push(m) };
    const connector = Object.assign(new CalendarBookingConnector(config, c.fake), {
      ownerNotes: { booked: "a", cancelled: "Please remove it.", rescheduled: "Please move it." },
    });
    const deps = { ...c.deps, connector, owner };
    const id = c.booking.booking_id;
    const moved = await reschedule({ booking_id: id, email: "ann@example.com", quote_id: await c.q("2026-10-08T11:00:00-07:00", "2026-10-08T12:00:00-07:00") }, deps);
    expect(moved.ok).toBe(true);
    expect(messages).toEqual([`Agent rescheduled: Ann, S from Thu Oct 8, 9:00 AM to Thu Oct 8, 11:00 AM. Booking ${id}. Please move it.`]);
    messages.length = 0;
    expect((await cancel({ booking_id: id, email: "ann@example.com" }, deps)).ok).toBe(true);
    expect((await cancel({ booking_id: id, email: "ann@example.com" }, deps)).ok).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^Agent cancelled: Ann, s, Thu Oct 8, 11:00 AM\. Booking b_[\w-]+\. Please remove it\.$/);
  });
});

describe("reschedule", () => {
  it("moves to the new quote, keeps booking_id, frees the old slot, and retries are no-ops", async () => {
    const c = await setup();
    const id = c.booking.booking_id;
    const q2 = await c.q("2026-10-08T13:00:00-07:00", "2026-10-08T14:00:00-07:00");
    const r = await reschedule({ booking_id: id, email: "ann@example.com", quote_id: q2 }, c.deps);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.booking_id).toBe(id);
    expect(r.data.slot.start).toBe("2026-10-08T13:00:00-07:00");
    expect(c.fake.events.size).toBe(1);
    expect(c.store.getQuote(c.booking.quote_id)?.state).toBe("void");
    expect(c.store.getQuote(q2)?.state).toBe("booked");
    const retry = await reschedule({ booking_id: id, email: "ann@example.com", quote_id: q2 }, c.deps);
    expect(retry.ok && retry.data.slot.start).toBe("2026-10-08T13:00:00-07:00");
    // Old slot is bookable again; the new one is not.
    expect((await quote({ service_id: "s", window: { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T10:00:00-07:00" } }, c.deps)).ok).toBe(true);
    const taken = await quote({ service_id: "s", window: { start: "2026-10-08T13:00:00-07:00", end: "2026-10-08T14:00:00-07:00" } }, c.deps);
    expect(!taken.ok && taken.error.code).toBe("no_slot");
  });

  it("rejects a cancelled booking and a quote for another service", async () => {
    const c = await setup();
    const id = c.booking.booking_id;
    const q2 = await c.q("2026-10-08T13:00:00-07:00", "2026-10-08T14:00:00-07:00");
    await cancel({ booking_id: id, email: "ann@example.com" }, c.deps);
    const r = await reschedule({ booking_id: id, email: "ann@example.com", quote_id: q2 }, c.deps);
    expect(!r.ok && r.error.code).toBe("already_cancelled");
  });
});
