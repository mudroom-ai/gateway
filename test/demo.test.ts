import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, parseConfig } from "../src/config.js";
import type { CommunicationConnector, OwnerMessageHandler } from "../src/connectors/types.js";
import { cancelDueDemoBookings } from "../src/demo/cleanup.js";
import { OWNER_AWAY_TEXT } from "../src/demo/index.js";
import { classifyVendor } from "../src/demo/vendor.js";
import { createMessageOps, type MessageOps } from "../src/messages.js";
import { createApp, toBookingConnector } from "../src/server.js";
import { Store } from "../src/store/sqlite.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";

const config = parseConfig({
  merchant_id: "m1",
  name: "Paws & Suds Dog Grooming",
  timezone: "America/Los_Angeles",
  currency: "USD",
  services: [{ id: "bath", name: "Bath and brush", duration_min: 60, buffer_min: 0, price_cents: 6500 }],
  hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "09:00", end: "17:00" }]])),
});
const CUSTOMER = { name: "Ann Lee", phone: "+1 202 555 0199" };

describe("classifyVendor", () => {
  it("reads the vendor from the user-agent, then the X-Agent-Name hint", () => {
    expect(classifyVendor("Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot")).toBe("openai");
    expect(classifyVendor("Claude-User (claude-code/1.0; +https://support.anthropic.com/)")).toBe("claude");
    expect(classifyVendor("Mozilla/5.0 (compatible; Grok/1.0)")).toBe("grok");
    expect(classifyVendor("curl/8.7.1", "Muse")).toBe("muse");
    expect(classifyVendor("python-requests/2.32", "grok 4")).toBe("grok");
    expect(classifyVendor("curl/8.7.1")).toBe("other");
    expect(classifyVendor("curl/8.7.1", "Ann Lee's bot")).toBe("other");
    expect(classifyVendor(undefined)).toBe("other");
  });
});

describe("demo mode over HTTP", () => {
  let server: Server;
  let base = "";
  const fake = new FakeCalendarConnector();
  const store = new Store(join(mkdtempSync(join(tmpdir(), "gw-demo-")), "t.sqlite"));
  beforeAll(async () => {
    const settings = loadEnv({ DEMO_MODE: "1", DB_PATH: ":memory:" }, config);
    server = createApp(config, settings, { connector: fake, store, owner: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("books a [demo] event and the feed shows vendor, kind and outcome but no customer details", async () => {
    const day = DateTime.now().setZone(config.timezone).plus({ days: 2 }).startOf("day");
    const window = { start: day.set({ hour: 10 }).toISO()!, end: day.set({ hour: 11 }).toISO()! };
    const q = (await (await post("/api/quote", { service_id: "bath", window }, { "x-agent-name": "Muse" })).json()) as { quote_id: string };
    const b = await post("/api/book", { quote_id: q.quote_id, customer: { ...CUSTOMER, notes: "big dog" }, idempotency_key: "k1" }, { "user-agent": "ChatGPT-User/1.0" });
    expect(b.status).toBe(201);
    expect([...fake.events.values()][0]!.title).toMatch(/^\[demo\] Bath and brush - Ann Lee$/);
    await post("/api/cancel", { booking_id: "b_nope", phone: CUSTOMER.phone }, { "user-agent": "Claude-User" });

    const res = await fetch(`${base}/demo/feed`);
    const text = await res.text();
    const feed = JSON.parse(text) as { recent: { vendor: string; route: string; outcome: string }[]; bookings: { total: number; by_vendor: Record<string, number> }; today: { agents: number } };
    expect(feed.recent.map((r) => [r.vendor, r.route, r.outcome])).toEqual([
      ["claude", "cancel", "unknown_booking"],
      ["openai", "book", "ok"],
      ["muse", "quote", "ok"],
    ]);
    expect(feed.bookings).toMatchObject({ total: 1, by_vendor: { openai: 1 } });
    expect(feed.today.agents).toBe(3);
    for (const secret of ["Ann", "555", "0199", "big dog", "b_nope", "127.0.0.1"]) expect(text).not.toContain(secret);
  });

  it("serves the playground page to browsers and markdown with the playground note to agents", async () => {
    const html = await (await fetch(base, { headers: { accept: "text/html" } })).text();
    expect(html).toContain("Playground");
    expect(html).toContain(`Start at ${base}/llms.txt`);
    const md = await (await fetch(`${base}/llms.txt`)).text();
    expect(md).toContain("## This is a playground");
    expect(md).toContain("X-Agent-Name");
  });
});

describe("demo mode off", () => {
  it("has no feed, no playground page and no [demo] titles", async () => {
    const fake = new FakeCalendarConnector();
    const server = createApp(config, loadEnv({ DB_PATH: ":memory:" }, config), { connector: fake, store: new Store(":memory:"), owner: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/demo/feed`)).status).toBe(404);
      expect(await (await fetch(base, { headers: { accept: "text/html" } })).text()).not.toContain("Playground");
      expect(await (await fetch(`${base}/llms.txt`)).text()).not.toContain("playground");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("auto-cancel", () => {
  it("cancels bookings older than the TTL, keeps newer ones, and survives a restart (state is the table)", async () => {
    const fake = new FakeCalendarConnector();
    const connector = toBookingConnector(config, fake);
    const store = new Store(":memory:");
    const t0 = Date.parse("2026-10-14T17:00:00Z");
    const add = (id: string, createdMs: number) => {
      const iso = new Date(createdMs).toISOString();
      store.claimPending({ merchant_id: "m1", idem_key: id, request_hash: "h", quote_id: `q_${id}`, booking_id: id, event_id: `ev${id}`, customer: CUSTOMER, start_ms: t0 + 86_400_000, end_ms: t0 + 90_000_000 }, iso);
      const booking = { booking_id: id, quote_id: `q_${id}`, event_id: `ev${id}`, slot: { service_id: "bath", start: "2026-10-15T10:00:00-07:00", end: "2026-10-15T11:00:00-07:00" }, price_cents: 6500, currency: "USD", customer: CUSTOMER, state: "booked" as const, created_at: iso };
      store.markBooked("m1", id, booking, iso);
      fake.events.set(`ev${id}`, { id: `ev${id}`, start: booking.slot.start, end: booking.slot.end, title: "[demo] x" });
    };
    add("b_old", t0 - 61 * 60_000);
    add("b_new", t0 - 59 * 60_000);
    const deps = { store, connector, merchantId: "m1", timezone: config.timezone, ttlMs: 60 * 60_000, now: () => t0, log: () => {} };

    expect(await cancelDueDemoBookings(deps)).toEqual(["b_old"]);
    expect(fake.events.has("evb_old")).toBe(false);
    expect(store.getBookingById("b_old")!.state).toBe("cancelled");
    expect(store.getBookingById("b_new")!.state).toBe("booked");
    // Next pass (or the boot scan after a restart): nothing twice, the newer one once it is due.
    expect(await cancelDueDemoBookings({ ...deps, now: () => t0 + 2 * 60_000 })).toEqual(["b_new"]);
    expect(await cancelDueDemoBookings({ ...deps, now: () => t0 + 3 * 60_000 })).toEqual([]);
  });
});

describe("owner away", () => {
  it("answers a thread unanswered for 10 minutes with the templated reply, once", async () => {
    const posted: string[] = [];
    let handler: OwnerMessageHandler | undefined;
    const channel: CommunicationConnector = {
      notify: async () => {},
      openThread: async () => ({ provider_ref: "ts1" }),
      postToThread: async (_ref, text) => void posted.push(text),
      onOwnerMessage: (h) => void (handler = h),
      start: async () => {},
      stop: async () => {},
    };
    let nowMs = Date.parse("2026-10-14T17:00:00Z");
    const ops = createMessageOps({
      config,
      store: new Store(":memory:"),
      channel,
      settings: { messages_enabled: true },
      now: () => new Date(nowMs),
      log: () => {},
      ownerAway: { after_ms: 10 * 60_000, text: OWNER_AWAY_TEXT },
    }) as MessageOps;
    const t = await ops.leaveMessage({ customer: CUSTOMER, message: "Do you take large dogs?" });
    if (!t.ok) throw new Error(t.error.code);
    const read = () => ops.getThread({ thread_id: t.data.thread_id, read_token: t.data.read_token });

    nowMs += 9 * 60_000;
    await ops.sweep();
    const before = await read();
    expect(before.ok && before.data.status).toBe("awaiting_owner");

    nowMs += 2 * 60_000;
    await ops.sweep();
    await ops.sweep();
    const r = await read();
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.status).toBe("answered");
    expect(r.data.messages.filter((m) => m.from === "owner").map((m) => m.text)).toEqual([OWNER_AWAY_TEXT]);
    expect(posted).toEqual([OWNER_AWAY_TEXT]);
    expect(handler).toBeUndefined(); // start() was never called: the sweep alone does it
  });
});
