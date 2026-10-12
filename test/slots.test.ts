import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { CalendarBookingConnector } from "../src/connectors/calendar.js";
import type { BookingConnector, CalendarConnector } from "../src/connectors/types.js";
import { listServices } from "../src/services.js";
import { findSlots } from "../src/slots.js";
import type { Interval } from "../src/types.js";

const allDays = (start: string, end: string) =>
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start, end }]]));

function cfg(over: Record<string, unknown> = {}) {
  return parseConfig({
    name: "Test",
    timezone: "America/Los_Angeles",
    currency: "USD",
    services: [{ id: "s", name: "S", duration_min: 60, buffer_min: 0, price_cents: 1000 }],
    hours: allDays("09:00", "17:00"),
    ...over,
  });
}

const svc30 = [{ id: "s", name: "S", duration_min: 30, buffer_min: 0, price_cents: 1000 }];

function fakeCal(busy: Interval[] = []): CalendarConnector {
  return {
    getBusy: async () => busy,
    insertEvent: async () => {
      throw new Error("unused");
    },
    getEvent: async () => null,
    deleteEvent: async () => {},
    checkAccess: async () => {},
  };
}
const fake = (config = cfg(), busy: Interval[] = []): BookingConnector => new CalendarBookingConnector(config, fakeCal(busy));

const NOW = () => new Date("2026-01-01T00:00:00Z");

describe("listServices", () => {
  it("returns services with currency and zone", async () => {
    const r = await listServices(cfg(), fake());
    expect(r.ok && r.data.services[0]?.id).toBe("s");
  });
});

describe("findSlots", () => {
  it("pads busy by the default buffer: busy 14:00-15:00 + 15 min -> next slot 15:15", async () => {
    const r = await findSlots(
      { service_id: "s", window: { start: "2026-10-08T13:00:00-07:00", end: "2026-10-08T17:00:00-07:00" } },
      {
        config: cfg({ default_buffer_min: 15 }),
        connector: fake(cfg({ default_buffer_min: 15 }), [{ start: "2026-10-08T14:00:00-07:00", end: "2026-10-08T15:00:00-07:00" }]),
        now: NOW,
      },
    );
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.slots.map((s) => s.start)).toEqual([
      "2026-10-08T13:00:00-07:00",
      "2026-10-08T15:15:00-07:00",
      "2026-10-08T15:30:00-07:00",
      "2026-10-08T15:45:00-07:00",
      "2026-10-08T16:00:00-07:00",
    ]);
  });

  it("spring-forward: no 02:xx local slots", async () => {
    const r = await findSlots(
      { service_id: "s", window: { start: "2026-03-08T00:00:00-08:00", end: "2026-03-08T05:00:00-07:00" } },
      { config: cfg({ services: svc30, hours: allDays("00:00", "05:00") }), connector: fake(cfg({ services: svc30, hours: allDays("00:00", "05:00") })), now: NOW },
    );
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.slots.some((s) => s.start.includes("T02:"))).toBe(false);
    expect(r.data.slots).toHaveLength(15); // 4 real hours of 15-min starts, 30-min service
  });

  it("fall-back: repeated hour yields each real instant once", async () => {
    const r = await findSlots(
      { service_id: "s", window: { start: "2026-11-01T00:00:00-07:00", end: "2026-11-01T03:00:00-08:00" } },
      { config: cfg({ services: svc30, hours: allDays("00:00", "03:00") }), connector: fake(cfg({ services: svc30, hours: allDays("00:00", "03:00") })), now: NOW },
    );
    if (!r.ok) throw new Error(r.error.code);
    const starts = r.data.slots.map((s) => s.start);
    expect(new Set(starts.map((s) => Date.parse(s))).size).toBe(starts.length);
    expect(starts).toContain("2026-11-01T01:15:00-07:00");
    expect(starts).toContain("2026-11-01T01:15:00-08:00");
    expect(starts).toHaveLength(15); // 4 real hours
  });

  it.each([
    ["bare local start", { start: "2026-10-08T09:00:00", end: "2026-10-08T17:00:00-07:00" }, undefined, "invalid_time"],
    ["window > 14 days", { start: "2026-10-01T00:00:00Z", end: "2026-10-15T00:00:01Z" }, undefined, "invalid_window"],
    ["flexibility > 240", { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" }, 241, "invalid_window"],
  ])("rejects %s", async (_name, window, flexibility_min, code) => {
    const r = await findSlots(
      { service_id: "s", window, ...(flexibility_min !== undefined ? { flexibility_min } : {}) },
      { config: cfg(), connector: fake(), now: NOW },
    );
    expect(r.ok ? "ok" : r.error.code).toBe(code);
  });
});
