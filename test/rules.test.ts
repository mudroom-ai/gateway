import { describe, expect, it } from "vitest";
import type { DiscountConfig } from "../src/config.js";
import { price } from "../src/rules/engine.js";

const service = { id: "bath", price_cents: 10000 };
const tz = "America/Los_Angeles";
const NOW = new Date("2026-10-06T08:00:00-07:00"); // Tue

const weekday: DiscountConfig = {
  id: "weekday",
  pct: 10,
  days_of_week: ["mon", "tue", "wed", "thu", "fri"],
};
const third = (id: string): DiscountConfig => ({ id, pct: 33.33 });

function cfg(over: Partial<Parameters<typeof price>[3]> = {}) {
  return {
    timezone: tz,
    blackout_days: [] as string[],
    discounts: [weekday],
    max_total_discount_pct: 100,
    floor_cents: 0,
    ...over,
  };
}

describe("rules engine price()", () => {
  const rows: Array<{
    name: string;
    start: string;
    config: ReturnType<typeof cfg>;
    price: number;
    kinds: string[];
    base?: number;
  }> = [
    {
      name: "Saturday gets no discount",
      start: "2026-10-10T11:00:00-07:00",
      config: cfg(),
      price: 10000,
      kinds: [],
    },
    {
      // 18:00Z Friday is 11:00 Fri in LA; zone conversion must use merchant tz.
      name: "weekday discount applied",
      start: "2026-10-09T18:00:00Z",
      config: cfg(),
      price: 9000,
      kinds: ["discount"],
    },
    {
      name: "cap vs base price",
      start: "2026-10-08T10:00:00-07:00",
      config: cfg({ discounts: [weekday, { id: "big", pct: 50 }], max_total_discount_pct: 40 }),
      price: 6000,
      kinds: ["discount", "discount", "cap"],
    },
    {
      name: "floor wins over discounts and cap",
      start: "2026-10-08T10:00:00-07:00",
      config: cfg({ discounts: [{ id: "big", pct: 50 }], floor_cents: 7000 }),
      price: 7000,
      kinds: ["discount", "floor"],
    },
    {
      // 10000 -> -3333 = 6667 -> -2222 (2222.11) = 4445 -> -1482 (1481.52) = 2963
      name: "rounding edge: 3 x 33.33% half-up per step",
      start: "2026-10-08T10:00:00-07:00",
      config: cfg({ discounts: [third("a"), third("b"), third("c")] }),
      price: 2963,
      kinds: ["discount", "discount", "discount"],
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const res = price(service, { start: r.start }, NOW, r.config);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.price_cents).toBe(r.price);
      expect(res.base_cents).toBe(10000);
      expect(res.applied_rules.map((a) => a.kind)).toEqual(r.kinds);
      const sum = res.applied_rules.reduce((s, a) => s + a.amount_cents, 0);
      expect(res.base_cents + sum).toBe(res.price_cents);
    });
  }

  it("exact half cent rounds up", () => {
    const res = price({ id: "x", price_cents: 150 }, { start: "2026-10-08T10:00:00-07:00" }, NOW, cfg({ discounts: [{ id: "five", pct: 5 }] }));
    expect(res).toMatchObject({ ok: true, price_cents: 142 }); // 7.5 -> 8 off
  });

  it("blackout day (merchant-local) is blocked_by_rule", () => {
    // 2026-12-26T05:00Z is still Dec 25 in LA.
    const res = price(service, { start: "2026-12-26T05:00:00Z" }, NOW, cfg({ blackout_days: ["2026-12-25"] }));
    expect(res).toEqual({ ok: false, reason: "blocked_by_rule", rule_id: "blackout:2026-12-25" });
  });
});
