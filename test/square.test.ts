import { describe, expect, it } from "vitest";
import { SquareConnector, normalizePhone } from "../src/connectors/square.js";
import type { BookingRequest } from "../src/connectors/types.js";

type Call = { method: string; path: string; body: unknown };

/** Scripted Square: a route table of handlers, plus a log of every call made. */
function square(routes: Record<string, (body: unknown, call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${path}`;
    const h = routes[key] ?? routes[`${call.method} *`];
    if (!h) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: `no route ${key}` }] }), { status: 404 });
    const r = h(call.body, call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  const c = new SquareConnector({
    accessToken: "tok",
    locationId: "LOC",
    environment: "sandbox",
    timezone: "America/Los_Angeles",
    fetch: fetchImpl,
    now: () => Date.parse("2026-10-06T16:00:00Z"),
    warn: () => {},
  });
  return { c, calls };
}

const CATALOG = {
  items: [
    {
      id: "I1",
      item_data: {
        name: "Bath and brush",
        description_plaintext: "Bath, dry, brush.",
        variations: [
          { id: "V1", version: 7, item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: { amount: 6500, currency: "USD" }, service_duration: 3_600_000, available_for_booking: true } },
        ],
      },
    },
    {
      id: "I2",
      item_data: {
        name: "Full groom",
        variations: [
          { id: "V2", version: 3, item_variation_data: { name: "Small dog", pricing_type: "FIXED_PRICING", price_money: { amount: 9000 }, service_duration: 5_400_000 } },
          { id: "V3", version: 3, item_variation_data: { name: "Large dog", pricing_type: "VARIABLE_PRICING", service_duration: 7_200_000 } },
          { id: "V4", version: 3, item_variation_data: { name: "Hidden", pricing_type: "FIXED_PRICING", price_money: { amount: 100 }, service_duration: 600_000, available_for_booking: false } },
        ],
      },
    },
  ],
};

const avail = (...starts: string[]) => ({
  availabilities: starts.map((s) => ({ start_at: s, location_id: "LOC", appointment_segments: [{ duration_minutes: 60, service_variation_id: "V1", team_member_id: "TM1", service_variation_version: 7 }] })),
});

const SERVICE = { id: "V1", name: "Bath and brush", duration_min: 60, buffer_min: 0, price_cents: 6500 };
const REQ: BookingRequest = {
  event_id: "ev",
  idempotency_key: "agent-key-1",
  booking_id: "b_1",
  quote_id: "q_1",
  service: SERVICE,
  slot: { service_id: "V1", start: "2026-10-08T10:00:00-07:00", end: "2026-10-08T11:00:00-07:00" },
  block_end: "2026-10-08T11:00:00-07:00",
  customer: { name: "Ann Lee", email: "ann@example.com", phone: "+1 (555) 010-2030", notes: "Nervous dog" },
  price_cents: 6500,
  currency: "USD",
};

describe("SquareConnector", () => {
  it("lists bookable fixed-price variations as services", async () => {
    const { c } = square({ "POST /v2/catalog/search-catalog-items": () => ({ body: CATALOG }) });
    const s = await c.listServices();
    expect(s).toEqual([
      { id: "V1", name: "Bath and brush", description: "Bath, dry, brush.", duration_min: 60, buffer_min: 0, price_cents: 6500 },
      { id: "V2", name: "Full groom: Small dog", duration_min: 90, buffer_min: 0, price_cents: 9000 },
    ]);
  });

  it("widens the availability query to Square's 24h minimum and filters back to the asked range", async () => {
    const { c, calls } = square({
      "POST /v2/bookings/availability/search": () => ({ body: avail("2026-10-08T16:00:00Z", "2026-10-08T17:00:00Z", "2026-10-09T16:00:00Z") }),
    });
    const slots = await c.findSlots(SERVICE, { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T12:00:00-07:00" });
    expect(slots.map((s) => s.start)).toEqual(["2026-10-08T09:00:00-07:00", "2026-10-08T10:00:00-07:00"]);
    const q = (calls[0]!.body as { query: { filter: { start_at_range: { start_at: string; end_at: string }; segment_filters: unknown[] } } }).query.filter;
    expect(Date.parse(q.start_at_range.end_at) - Date.parse(q.start_at_range.start_at)).toBeGreaterThanOrEqual(86_400_000);
    expect(q.segment_filters).toEqual([{ service_variation_id: "V1" }]);
  });

  it("with ignoreBooking, filters availability by booking_id instead of location and segments", async () => {
    const { c, calls } = square({ "POST /v2/bookings/availability/search": () => ({ body: avail("2026-10-08T17:15:00Z") }) });
    const ignoreBooking = { id: "BK1", start: "2026-10-08T10:00:00-07:00", end: "2026-10-08T11:00:00-07:00" };
    const slots = await c.findSlots(SERVICE, { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T12:00:00-07:00" }, { ignoreBooking });
    expect(slots.map((s) => s.start)).toEqual(["2026-10-08T10:15:00-07:00"]);
    const f = (calls[0]!.body as { query: { filter: Record<string, unknown> } }).query.filter;
    expect(f.booking_id).toBe("BK1");
    expect(f.location_id).toBeUndefined();
    expect(f.segment_filters).toBeUndefined();
  });

  it("books: creates a customer (never looks one up), re-checks the slot, creates the booking with a hashed idempotency key", async () => {
    const { c, calls } = square({
      "POST /v2/customers": () => ({ body: { customer: { id: "CUST1" } } }),
      "POST /v2/bookings/availability/search": () => ({ body: avail("2026-10-08T17:00:00Z") }),
      "POST /v2/bookings": (body) => ({ body: { booking: { id: "BK1", version: 0, status: "ACCEPTED", start_at: (body as { booking: { start_at: string } }).booking.start_at } } }),
    });
    const ext = await c.book(REQ);
    expect(ext).toEqual({ id: "BK1", start: "2026-10-08T10:00:00-07:00", end: "2026-10-08T11:00:00-07:00" });
    expect(calls.some((x) => x.path === "/v2/customers/search")).toBe(false);
    const create = calls.find((x) => x.path === "/v2/customers")!.body as Record<string, unknown>;
    expect(create).toMatchObject({ given_name: "Ann", family_name: "Lee", email_address: "ann@example.com", phone_number: "+15550102030" });
    const booking = calls.find((x) => x.path === "/v2/bookings")!.body as { idempotency_key: string; booking: Record<string, unknown> };
    expect(booking.idempotency_key).toMatch(/^[0-9a-f]{48}$/);
    expect(booking.booking).toMatchObject({
      location_id: "LOC",
      customer_id: "CUST1",
      start_at: "2026-10-08T17:00:00.000Z",
      appointment_segments: [{ service_variation_id: "V1", service_variation_version: 7, team_member_id: "TM1" }],
    });
    expect(String(booking.booking.customer_note)).toContain("Nervous dog");
  });

  it("reports slot_unavailable when Square no longer offers the start, and invalid_customer without a phone", async () => {
    const { c } = square({ "POST /v2/bookings/availability/search": () => ({ body: avail("2026-10-08T18:00:00Z") }) });
    await expect(c.book(REQ)).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(c.book({ ...REQ, customer: { name: "Ann", email: "ann@example.com" } })).rejects.toMatchObject({ code: "invalid_customer" });
  });

  it("cancels with the current version and is a no-op when already cancelled", async () => {
    let status = "ACCEPTED";
    const { c, calls } = square({
      "GET /v2/bookings/BK1": () => ({ body: { booking: { id: "BK1", version: 4, status, start_at: "2026-10-08T17:00:00Z" } } }),
      "POST /v2/bookings/BK1/cancel": () => ({ body: { booking: { id: "BK1", version: 5, status: "CANCELLED_BY_CUSTOMER", start_at: "2026-10-08T17:00:00Z" } } }),
    });
    await c.cancel("BK1");
    expect(calls.at(-1)!.body).toMatchObject({ booking_version: 4 });
    status = "CANCELLED_BY_CUSTOMER";
    await c.cancel("BK1");
    expect(calls.filter((x) => x.path.endsWith("/cancel")).length).toBe(1);
    expect(await c.getBooking("BK1")).toBeNull(); // cancelled bookings don't count as existing
  });

  it("reschedules with UpdateBooking and keeps the id", async () => {
    const { c, calls } = square({
      "GET /v2/bookings/BK1": () => ({ body: { booking: { id: "BK1", version: 2, status: "ACCEPTED", start_at: "2026-10-08T17:00:00Z" } } }),
      "POST /v2/bookings/availability/search": () => ({ body: avail("2026-10-09T17:00:00Z") }),
      "PUT /v2/bookings/BK1": (body) => ({ body: { booking: { id: "BK1", version: 3, status: "ACCEPTED", start_at: (body as { booking: { start_at: string } }).booking.start_at } } }),
    });
    const next = { ...REQ, quote_id: "q_2", slot: { service_id: "V1", start: "2026-10-09T10:00:00-07:00", end: "2026-10-09T11:00:00-07:00" } };
    const ext = await c.reschedule("BK1", next);
    expect(ext).toEqual({ id: "BK1", start: "2026-10-09T10:00:00-07:00", end: "2026-10-09T11:00:00-07:00" });
    expect(calls.at(-1)!.body).toMatchObject({ booking: { version: 2, start_at: "2026-10-09T17:00:00.000Z" } });
    expect((calls.at(-1)!.body as { booking: Record<string, unknown> }).booking.appointment_segments).toBeUndefined();
    const recheck = calls.find((x) => x.path === "/v2/bookings/availability/search")!.body as { query: { filter: Record<string, unknown> } };
    expect(recheck.query.filter.booking_id).toBe("BK1"); // its own time doesn't block the move
  });

  it("maps 401/403 to calendar_auth_failed and 5xx to calendar_unavailable", async () => {
    const denied = square({ "POST *": () => ({ status: 401, body: { errors: [{ code: "UNAUTHORIZED", detail: "bad token" }] } }) });
    await expect(denied.c.listServices()).rejects.toMatchObject({ code: "calendar_auth_failed" });
    const down = square({ "POST *": () => ({ status: 503, body: {} }) });
    await expect(down.c.listServices()).rejects.toMatchObject({ code: "calendar_unavailable", retry_after_s: 5 });
  });

  it("normalizes phones to digits with an optional +", () => {
    expect(normalizePhone("+1 (555) 010-2030")).toBe("+15550102030");
    expect(normalizePhone("555 010 2030")).toBe("5550102030");
  });
});
