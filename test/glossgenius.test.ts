import { describe, expect, it } from "vitest";
import {
  GlossGeniusConnector,
  createGlossGeniusConnector,
  mapServices,
  monthsInRange,
  parseBookingPage,
  slugFromUrl,
} from "../src/connectors/glossgenius.js";
import { ConnectorError, type BookingRequest } from "../src/connectors/types.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";

// All fixtures are synthetic: invented names and tokens shaped like the vendor's.
const SLUG = "fern-studio";
const URL_ = `https://${SLUG}.glossgenius.com/services`;
const BIZ = "10016-aaaa1111";
const SPACE = "1001a-bbbb2222";
const LOC = "1003d-cccc3333";
const SVC_TOKEN = "1000f-dddd4444";

const NEXT_DATA = {
  props: { serverContext: { publicUser: { business_token: BIZ, space_token: SPACE, name: "Fern Studio" } }, pageProps: {} },
  locations: [{ token: LOC, spaceToken: SPACE, name: "Main", hours: [], contactInfo: { phone: "+1 202 555 0199" } }],
};
const PAGE = `<html><head></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(NEXT_DATA)}</script></body></html>`;
const PAGE_REGEX_ONLY = `<html><script>window.__LOCATIONS__ = [{"token":"${LOC}","spaceToken":"${SPACE}","name":"Main"}];
self.__next_f.push([1,"{\\"business_token\\":\\"${BIZ}\\",\\"space_token\\":\\"${SPACE}\\"}"])</script></html>`;

const VENDOR_SERVICES = {
  services: [
    { name: "Gel manicure", price: "45.00", total_duration: 60, start_duration: 60, processing_duration: 0, end_duration: 0, price_varies: false, price_hidden: false, category_name: "Nails", token: SVC_TOKEN, description: "Shape and gel.", deposit_amount: null, options: [], modifier_groups: [] },
    { name: "Balayage", price: "180.00", total_duration: 180, price_varies: true, price_hidden: false, token: "1000f-eeee5555" },
    { name: "Consult", price: "0.00", total_duration: 15, price_varies: false, price_hidden: true, token: "1000f-ffff6666" },
    { name: "Mystery", price: "abc", total_duration: 30, price_varies: false, price_hidden: false, token: "1000f-gggg7777" },
  ],
  pagination: { size: 4, next_cursor: null, has_next_page: false },
};

const avail = (...starts: string[]) => ({
  data: starts.map((s) => ({ starts_at: s, ends_at: s, client_starts_at: s, client_ends_at: s, events: [{ service_token: SVC_TOKEN, space_member_tokens: ["1001b-hhhh8888"], timing: {} }] })),
  pagination: {},
});

type Call = { method: string; key: string; body: Record<string, unknown> | undefined };
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

/** Scripted GlossGenius: routes keyed "METHOD host/path", plus a log of every call. */
function gg(routes: Record<string, (body: Record<string, unknown> | undefined, n: number) => Reply>, extra: { minLeadHours?: number } = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.host}${u.pathname}`;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? "GET", key, body });
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const h = routes[key];
    if (!h) return new Response("not found", { status: 404 });
    const r = h(body, n);
    if (r instanceof Error) throw r;
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  const calendar = new FakeCalendarConnector();
  const warnings: string[] = [];
  const c = new GlossGeniusConnector({
    bookingUrl: URL_,
    calendar,
    timezone: "America/Los_Angeles",
    fetch: fetchImpl,
    now: () => Date.parse("2026-10-06T16:00:00Z"),
    warn: (m) => warnings.push(m),
    ...extra,
  });
  return { c, calls, calendar, warnings };
}

const PAGE_KEY = `GET ${SLUG}.glossgenius.com/services`;
const SERVICES_KEY = "POST api.glossgenius.com/v4/web/services/search";
const AVAIL_KEY = "POST api.glossgenius.com/v4/web/bookings/availabilities/search";
const page = () => ({ text: PAGE });

const SERVICE = { id: SVC_TOKEN, name: "Gel manicure", duration_min: 60, buffer_min: 0, price_cents: 4500 };
// 2026-10-09 10:00 PDT is 66h after "now": past the 48h lead time.
const REQ: BookingRequest = {
  event_id: "ev1",
  idempotency_key: "agent-key-1",
  booking_id: "b_1",
  quote_id: "q_1",
  service: SERVICE,
  slot: { service_id: SVC_TOKEN, start: "2026-10-09T10:00:00-07:00", end: "2026-10-09T11:00:00-07:00" },
  block_end: "2026-10-09T11:00:00-07:00",
  customer: { name: "Rae Okafor", phone: "+1 202 555 0199" },
  price_cents: 4500,
  currency: "USD",
};
const DAY = { start: "2026-10-09T08:00:00-07:00", end: "2026-10-09T18:00:00-07:00" };

async function codeOf(p: Promise<unknown>): Promise<ConnectorError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ConnectorError);
  return e as ConnectorError;
}

describe("GlossGenius pure helpers", () => {
  it("parses tokens from __NEXT_DATA__ and, failing that, by regex", () => {
    const want = { businessToken: BIZ, spaceToken: SPACE, locationToken: LOC };
    expect(parseBookingPage(PAGE)).toEqual(want);
    expect(parseBookingPage(PAGE_REGEX_ONLY)).toEqual(want);
    expect(parseBookingPage("<html>Just a moment...</html>")).toBeNull();
    expect(slugFromUrl(URL_)).toBe(SLUG);
  });

  it("maps services, skipping hidden, variable and non-numeric prices", () => {
    const skipped: string[] = [];
    expect(mapServices(VENDOR_SERVICES.services, (n, why) => skipped.push(`${n}: ${why}`))).toEqual([
      { id: SVC_TOKEN, name: "Gel manicure", description: "Shape and gel.", duration_min: 60, buffer_min: 0, price_cents: 4500 },
    ]);
    expect(skipped).toEqual(["Balayage: price varies", "Consult: price is hidden", "Mystery: price is not a number"]);
  });

  it("splits a range into merchant-zone calendar months", () => {
    const r = { start: Date.parse("2026-10-28T09:00:00-07:00"), end: Date.parse("2026-11-03T09:00:00-08:00") };
    expect(monthsInRange(r, "America/Los_Angeles")).toEqual([
      { from: "2026-10-01", to: "2026-10-31" },
      { from: "2026-11-01", to: "2026-11-30" },
    ]);
  });
});

describe("GlossGeniusConnector", () => {
  it("lists services with the minted location token and warns once per skipped service", async () => {
    const { c, calls, warnings } = gg({ [PAGE_KEY]: page, [SERVICES_KEY]: () => ({ body: VENDOR_SERVICES }) });
    expect((await c.listServices()).map((s) => s.id)).toEqual([SVC_TOKEN]);
    await c.listServices(); // cached
    expect(calls.filter((x) => x.key === SERVICES_KEY)).toHaveLength(1);
    expect(calls.find((x) => x.key === SERVICES_KEY)!.body).toEqual({ location_token: LOC, slug: SLUG });
    expect(warnings).toHaveLength(3);
  });

  it("finds slots: one call per month, lead time, range and own-calendar busy filtered, cached", async () => {
    const { c, calls, calendar } = gg({
      [PAGE_KEY]: page,
      [AVAIL_KEY]: (b) =>
        (b!.availability_window as { from: string }).from === "2026-10-01"
          ? { body: avail("2026-10-08T15:00:00.000Z", "2026-10-31T17:00:00.000Z", "2026-10-31T18:00:00.000Z", "2026-10-31T18:00:00.000Z") }
          : { body: avail("2026-11-02T18:00:00.000Z") },
    });
    // A shadow booking the gateway made earlier blocks 11:00-12:00 PDT on Oct 31.
    calendar.busy.push({ start: "2026-10-31T11:00:00-07:00", end: "2026-10-31T12:00:00-07:00" });
    const range = { start: "2026-10-07T00:00:00-07:00", end: "2026-11-30T00:00:00-08:00" };
    const slots = await c.findSlots(SERVICE, range);
    expect(slots).toEqual([
      { service_id: SVC_TOKEN, start: "2026-10-31T10:00:00-07:00", end: "2026-10-31T11:00:00-07:00" },
      { service_id: SVC_TOKEN, start: "2026-11-02T10:00:00-08:00", end: "2026-11-02T11:00:00-08:00" },
    ]);
    const av = calls.filter((x) => x.key === AVAIL_KEY);
    expect(av.map((x) => x.body!.availability_window)).toEqual([
      { from: "2026-10-01", to: "2026-10-31" },
      { from: "2026-11-01", to: "2026-11-30" },
    ]);
    expect(av[0]!.body).toMatchObject({ business_token: BIZ, slug: SLUG, space_token: SPACE, location_tokens: [LOC], events: [{ service_token: SVC_TOKEN, space_member_tokens: [] }] });

    // ignoreBooking frees the moved booking's own span; cache: no new HTTP calls.
    calendar.events.set("old", { id: "old", start: "2026-10-31T11:00:00-07:00", end: "2026-10-31T12:00:00-07:00" });
    calendar.busy.length = 0;
    const n = calls.length;
    const moved = await c.findSlots(SERVICE, range, { ignoreBooking: { id: "old", start: "2026-10-31T11:00:00-07:00", end: "2026-10-31T12:00:00-07:00" } });
    expect(moved.map((s) => s.start)).toContain("2026-10-31T11:00:00-07:00");
    expect(calls.length).toBe(n);
  });

  it("books into the calendar after a fresh availability check", async () => {
    const { c, calls, calendar } = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: avail("2026-10-09T17:00:00.000Z") }) });
    await c.findSlots(SERVICE, DAY); // warms the cache
    const ext = await c.book(REQ);
    expect(ext).toEqual({ id: "ev1", start: REQ.slot.start, end: REQ.block_end });
    expect(calls.filter((x) => x.key === AVAIL_KEY)).toHaveLength(2); // book bypassed the cache
    expect(calendar.events.get("ev1")!.title).toBe("Gel manicure - Rae Okafor");
    expect(calls.some((x) => x.method !== "GET" && !x.key.includes("/search"))).toBe(false); // nothing written to GlossGenius

    // Idempotent: the calendar says already_exists, same external record.
    expect(await c.book(REQ)).toEqual(ext);
    expect(calendar.insertCalls).toBe(2);
  });

  it("refuses a booking the vendor no longer offers", async () => {
    const { c, calendar } = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: avail("2026-10-09T18:00:00.000Z") }) });
    expect((await codeOf(c.book(REQ))).code).toBe("slot_unavailable");
    expect(calendar.events.size).toBe(0);
  });

  it("refuses a booking whose time the calendar already holds (an earlier shadow booking)", async () => {
    const { c, calendar } = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: avail("2026-10-09T17:00:00.000Z") }) });
    calendar.busy.push({ start: "2026-10-09T10:30:00-07:00", end: "2026-10-09T11:30:00-07:00" });
    expect((await codeOf(c.book(REQ))).code).toBe("slot_unavailable");
    expect(calendar.events.size).toBe(0);
  });

  it("asks the merchant to mirror each change by hand (ownerNotes)", () => {
    const { c } = gg({});
    expect(c.ownerNotes).toEqual({
      booked: "Not in GlossGenius yet, please add it by hand.",
      cancelled: "Please remove it from GlossGenius.",
      rescheduled: "Please move it in GlossGenius.",
    });
  });

  it("cancel deletes; a second cancel is a no-op", async () => {
    const { c, calendar } = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: avail("2026-10-09T17:00:00.000Z") }) });
    await c.book(REQ);
    await c.cancel("ev1");
    await c.cancel("ev1");
    expect(calendar.events.size).toBe(0);
    expect(await c.getBooking("ev1")).toBeNull();
  });

  it("reschedule inserts the new event, then deletes the old one", async () => {
    const { c, calendar } = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: avail("2026-10-09T17:00:00.000Z", "2026-10-09T17:30:00.000Z") }) });
    await c.book(REQ);
    const order: string[] = [];
    const ins = calendar.insertEvent.bind(calendar);
    const del = calendar.deleteEvent.bind(calendar);
    calendar.insertEvent = async (e) => (order.push(`insert ${e.id}`), ins(e));
    calendar.deleteEvent = async (id) => (order.push(`delete ${id}`), del(id));
    // Overlaps the old booking's own span: allowed.
    const moved = { ...REQ, event_id: "ev2", booking_id: "b_1", slot: { ...REQ.slot, start: "2026-10-09T10:30:00-07:00", end: "2026-10-09T11:30:00-07:00" }, block_end: "2026-10-09T11:30:00-07:00" };
    expect(await c.reschedule("ev1", moved)).toEqual({ id: "ev2", start: moved.slot.start, end: moved.block_end });
    expect(order).toEqual(["insert ev2", "delete ev1"]);
    expect([...calendar.events.keys()]).toEqual(["ev2"]);
  });

  it("checkAccess gives a merchant fix hint when the booking page cannot be read", async () => {
    const { c } = gg({ [PAGE_KEY]: () => ({ status: 404, text: "not found" }) });
    const e = await codeOf(c.checkAccess());
    expect(e.code).toBe("calendar_auth_failed");
    expect(e.message).toContain(`Could not read the GlossGenius booking page at ${URL_}`);
    expect(e.message).toContain("Check GLOSSGENIUS_BOOKING_URL opens in a browser and shows your services.");
    const ok = gg({ [PAGE_KEY]: page });
    await expect(ok.c.checkAccess()).resolves.toBeUndefined();
  });

  it("maps vendor failures onto calendar_unavailable with a cause in the message", async () => {
    const net = gg({ [PAGE_KEY]: page, [SERVICES_KEY]: () => new TypeError("fetch failed") });
    let e = await codeOf(net.c.listServices());
    expect([e.code, e.retry_after_s]).toEqual(["calendar_unavailable", 30]);
    expect(e.message).toMatch(/GlossGenius unreachable/);

    const five = gg({ [PAGE_KEY]: page, [SERVICES_KEY]: () => ({ status: 503, body: {}, headers: { "retry-after": "12" } }) });
    e = await codeOf(five.c.listServices());
    expect([e.code, e.retry_after_s]).toEqual(["calendar_unavailable", 12]);

    // 403 re-mints once, then gives up as blocked_by_vendor.
    const blocked = gg({ [PAGE_KEY]: page, [SERVICES_KEY]: () => ({ status: 403, text: "<html>denied</html>" }) });
    e = await codeOf(blocked.c.listServices());
    expect(e.message).toMatch(/^GlossGenius refused the request \(blocked_by_vendor\)/);
    expect(blocked.calls.filter((x) => x.key === PAGE_KEY)).toHaveLength(2);
    expect(blocked.calls.filter((x) => x.key === SERVICES_KEY)).toHaveLength(2);

    // A 403 that clears after the re-mint succeeds.
    const recovers = gg({ [PAGE_KEY]: page, [SERVICES_KEY]: (_b, n) => (n === 1 ? { status: 401, body: {} } : { body: VENDOR_SERVICES }) });
    expect(await recovers.c.listServices()).toHaveLength(1);

    const challenge = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ text: "<html>Just a moment...</html>" }) });
    e = await codeOf(challenge.c.findSlots(SERVICE, DAY));
    expect(e.message).toMatch(/blocked_by_vendor/);

    const drift = gg({ [PAGE_KEY]: page, [AVAIL_KEY]: () => ({ body: { slots: [] } }) });
    e = await codeOf(drift.c.findSlots(SERVICE, DAY));
    expect(e.code).toBe("calendar_unavailable");
    expect(e.message).toMatch(/^GlossGenius response changed shape \(connector_drift\)/);
  });
});

describe("createGlossGeniusConnector", () => {
  it("is off without a URL and needs a calendar with one", () => {
    expect(createGlossGeniusConnector({ glossgenius_booking_url: undefined }, { calendar: undefined, timezone: "UTC" })).toBeUndefined();
    expect(() => createGlossGeniusConnector({ glossgenius_booking_url: URL_ }, { calendar: undefined, timezone: "UTC" })).toThrow(/needs Google Calendar/);
    expect(createGlossGeniusConnector({ glossgenius_booking_url: URL_ }, { calendar: new FakeCalendarConnector(), timezone: "UTC" })).toBeInstanceOf(GlossGeniusConnector);
  });
});
