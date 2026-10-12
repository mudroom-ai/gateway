import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { book, type BookDeps } from "../src/book.js";
import { parseConfig } from "../src/config.js";
import { CalendarBookingConnector } from "../src/connectors/calendar.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { ConnectorError } from "../src/connectors/types.js";
import { createMessageOps } from "../src/messages.js";
import { quote } from "../src/quote.js";
import { Store } from "../src/store/sqlite.js";
import type { BookRequest, Customer } from "../src/types.js";

const allDays = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]),
);
const config = parseConfig({
  merchant_id: "m1",
  name: "Test",
  timezone: "America/Los_Angeles",
  currency: "USD",
  services: [{ id: "s", name: "Groom", duration_min: 60, buffer_min: 15, price_cents: 10000 }],
  hours: allDays,
  quote_ttl_min: 15,
});

const T0 = Date.parse("2026-10-06T16:00:00Z");
const WINDOW = { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T12:00:00-07:00" };
const SLOT = { start: "2026-10-08T09:00:00-07:00", end: "2026-10-08T10:15:00-07:00" };
const ANN: Customer = { name: "Ann", email: "ann@example.com" };

async function setup(dbPath = join(mkdtempSync(join(tmpdir(), "gw-")), "t.sqlite")) {
  const ctx = {
    dbPath,
    store: new Store(dbPath),
    connector: new FakeCalendarConnector(),
    nowMs: T0,
    enabled: true,
    quoteId: "",
  };
  const deps = (): BookDeps => ({
    config,
    connector: new CalendarBookingConnector(config, ctx.connector),
    store: ctx.store,
    bookingEnabled: ctx.enabled,
    now: () => new Date(ctx.nowMs),
  });
  const q = await quote({ service_id: "s", window: WINDOW }, { ...deps() });
  if (!q.ok) throw new Error(JSON.stringify(q.error));
  ctx.quoteId = q.data.quote_id;
  const doBook = (over: Partial<BookRequest> = {}) =>
    book({ quote_id: ctx.quoteId, customer: ANN, idempotency_key: "k1", ...over }, deps());
  return { ctx, doBook };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

interface Row {
  name: string;
  prep?: (c: Ctx) => Promise<unknown> | void;
  req?: Partial<BookRequest>;
  code: string; // "ok" or an error code
  state: string; // quote state afterwards
  events: number;
}

const rows: Row[] = [
  { name: "open -> booked", code: "ok", state: "booked", events: 1 },
  { name: "booked, same key -> original result", prep: (c) => c.doBook(), code: "ok", state: "booked", events: 1 },
  { name: "booked, new key -> already_booked", prep: (c) => c.doBook(), req: { idempotency_key: "k2" }, code: "already_booked", state: "booked", events: 1 },
  { name: "same key, different customer -> idempotency_conflict", prep: (c) => c.doBook(), req: { customer: { name: "Bob", email: "b@example.com" } }, code: "idempotency_conflict", state: "booked", events: 1 },
  { name: "open past TTL -> expired", prep: (c) => void (c.ctx.nowMs += 16 * 60_000), code: "expired", state: "expired", events: 0 },
  { name: "slot taken -> void + alternatives", prep: (c) => void (c.ctx.connector.busy = [SLOT]), code: "slot_unavailable", state: "void", events: 0 },
  {
    name: "void stays void",
    prep: async (c) => {
      c.ctx.connector.busy = [SLOT];
      await c.doBook();
      c.ctx.connector.busy = [];
    },
    req: { idempotency_key: "k2" },
    code: "slot_unavailable",
    state: "void",
    events: 0,
  },
  { name: "kill switch -> booking_disabled, quote stays open", prep: (c) => void (c.ctx.enabled = false), code: "booking_disabled", state: "open", events: 0 },
  {
    name: "calendar outage -> calendar_unavailable, quote stays open",
    prep: (c) => {
      c.ctx.connector.getBusy = async () => {
        throw new ConnectorError("calendar_unavailable", "timeout", { retry_after_s: 5 });
      };
    },
    code: "calendar_unavailable",
    state: "open",
    events: 0,
  },
  { name: "no phone or email -> invalid_customer", req: { customer: { name: "Ann" } }, code: "invalid_customer", state: "open", events: 0 },
  { name: "unknown quote", req: { quote_id: "q_missing" }, code: "unknown_quote", state: "open", events: 0 },
];

describe("book state transitions", () => {
  it.each(rows)("$name", async (row) => {
    const c = await setup();
    await row.prep?.(c);
    const r = await c.doBook(row.req);
    expect(r.ok ? "ok" : r.error.code).toBe(row.code);
    expect(c.ctx.store.getQuote(c.ctx.quoteId)?.state).toBe(row.state);
    expect(c.ctx.connector.events.size).toBe(row.events);
    if (row.name.startsWith("slot taken") && !r.ok) expect(r.error.alternatives?.length).toBeGreaterThan(0);
    if (row.code === "calendar_unavailable" && !r.ok) expect(r.error.retryable).toBe(true);
  });

  it("already_booked doesn't leak another caller's booking_id", async () => {
    const c = await setup();
    const first = await c.doBook();
    const r = await c.doBook({ idempotency_key: "k2" });
    expect(!r.ok && r.error.code).toBe("already_booked");
    expect(first.ok).toBe(true);
    expect(first.ok && !r.ok && r.error.message.includes(first.data.booking_id)).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/idempotency_key/);
  });

  it("same key twice returns the same booking and one event", async () => {
    const c = await setup();
    const a = await c.doBook();
    const b = await c.doBook();
    expect(a.ok && b.ok && a.data.booking_id === b.data.booking_id).toBe(true);
    expect(c.ctx.connector.events.size).toBe(1);
    const ev = [...c.ctx.connector.events.values()][0]!;
    expect(ev.end).toBe(SLOT.end); // span = duration + buffer
    expect(ev.title).toContain("Ann");
    expect(ev.description).toContain("ann@example.com");
  });
});

describe("crash after insert", () => {
  it("retry with the same key after a crash gives one event", async () => {
    const c = await setup();
    const real = c.ctx.connector.insertEvent.bind(c.ctx.connector);
    // The insert lands on the calendar, then the process dies before marking booked.
    c.ctx.connector.insertEvent = async (ev) => {
      await real(ev);
      throw new ConnectorError("calendar_unavailable", "connection reset");
    };
    const first = await c.doBook();
    expect(!first.ok && first.error.code).toBe("calendar_unavailable");
    expect(c.ctx.store.getBookingByKey("m1", "k1")?.state).toBe("pending");

    // Restart: reopen the same SQLite file, healthy connector, same calendar.
    c.ctx.store.close();
    c.ctx.store = new Store(c.ctx.dbPath);
    c.ctx.connector.insertEvent = real;
    const retry = await c.doBook();
    expect(retry.ok).toBe(true);
    expect(c.ctx.connector.events.size).toBe(1);
    expect(c.ctx.connector.insertCalls).toBe(1); // reconciled via getEvent, no second insert
    expect(c.ctx.store.getQuote(c.ctx.quoteId)?.state).toBe("booked");
  });
});

describe("owner notice", () => {
  it("tells the owner once per new booking, not on a replay, with the connector's note", async () => {
    const c = await setup();
    const messages: string[] = [];
    const owner = { notify: async (m: string) => void messages.push(m) };
    const connector = Object.assign(new CalendarBookingConnector(config, c.ctx.connector), {
      ownerNotes: { booked: "Please add it by hand.", cancelled: "x", rescheduled: "y" },
    });
    const deps: BookDeps = { config, connector, store: c.ctx.store, bookingEnabled: true, owner, now: () => new Date(c.ctx.nowMs) };
    const req = { quote_id: c.ctx.quoteId, customer: ANN, idempotency_key: "k1" };
    const r = await book(req, deps);
    expect(r.ok).toBe(true);
    expect(await book(req, deps)).toEqual(r); // idempotent replay
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^Agent booking: Ann, Groom, Thu Oct 8, 9:00 AM, \$100\.00\. Booking b_/);
    expect(messages[0]).toMatch(/ Please add it by hand\.$/);
  });
});

describe("open message threads", () => {
  /** Thread-capable fake channel: records what the owner sees in each thread. */
  function fakeChannel() {
    const posts: { ref: string; text: string }[] = [];
    let n = 0;
    return {
      posts,
      async notify() {},
      async openThread() {
        return { provider_ref: `ts.${++n}` };
      },
      async postToThread(ref: string, text: string) {
        posts.push({ ref, text });
      },
      onOwnerMessage() {},
      async start() {},
      async stop() {},
    };
  }

  it("a booking closes the customer's open threads with a notice to the owner", async () => {
    const c = await setup();
    const channel = fakeChannel();
    const messages = createMessageOps({ config, store: c.ctx.store, channel, settings: { messages_enabled: true }, now: () => new Date(c.ctx.nowMs), log: () => {} })!;
    const left = await messages.leaveMessage({ customer: ANN, message: "Can you do a nail trim too?" });
    if (!left.ok) throw new Error(left.error.code);
    const deps: BookDeps = {
      config,
      connector: new CalendarBookingConnector(config, c.ctx.connector),
      store: c.ctx.store,
      bookingEnabled: true,
      threads: messages,
      now: () => new Date(c.ctx.nowMs),
    };
    const r = await book({ quote_id: c.ctx.quoteId, customer: ANN, idempotency_key: "k1" }, deps);
    expect(r.ok).toBe(true);
    const t = await messages.getThread({ thread_id: left.data.thread_id, read_token: left.data.read_token });
    expect(t.ok && t.data.status).toBe("closed");
    await new Promise((res) => setImmediate(res));
    expect(channel.posts).toEqual([{ ref: "ts.1", text: "The customer booked Groom for Thu Oct 8, 9:00 AM, so the assistant has what it needs. Thanks!" }]);
  });

  it("a failure closing threads never fails the booking", async () => {
    const c = await setup();
    const deps: BookDeps = {
      config,
      connector: new CalendarBookingConnector(config, c.ctx.connector),
      store: c.ctx.store,
      bookingEnabled: true,
      threads: {
        closeForBooking: async () => {
          throw new Error("SQLITE_BUSY");
        },
      },
      now: () => new Date(c.ctx.nowMs),
    };
    const r = await book({ quote_id: c.ctx.quoteId, customer: ANN, idempotency_key: "k1" }, deps);
    expect(r.ok && r.data.state).toBe("booked");
  });
});
