// Pure pricing rules engine. No I/O, no clock: `now` is passed in.
//
// Order: blackout -> ordered conditional discounts -> cap vs base -> floor last.
// Money is integer cents; each discount step is rounded half-up.
// Conditions are evaluated on the slot start in the merchant's IANA zone.

import { DateTime } from "luxon";
import type { Config, DiscountConfig } from "../config.js";
import type { AppliedRule, Cents, PriceResult, Service, Slot, Weekday } from "../types.js";

const WEEKDAY_BY_LUXON: Record<number, Weekday> = {
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
  7: "sun",
};

/** pct is stored in micro-units (pct * 10^4) so the math stays in exact integers. */
const PCT_SCALE = 10_000;

/** round_half_up(cents * pct / 100) using integer arithmetic only. */
export function pctOfCents(cents: Cents, pct: number): Cents {
  const pctMicro = Math.round(pct * PCT_SCALE);
  const denom = 100 * PCT_SCALE;
  return Math.floor((cents * pctMicro + denom / 2) / denom);
}

function discountApplies(d: DiscountConfig, start: DateTime, now: Date): boolean {
  if (d.days_of_week) {
    const day = WEEKDAY_BY_LUXON[start.weekday];
    if (!day || !d.days_of_week.includes(day)) return false;
  }
  if (d.starts_within_hours !== undefined) {
    const msAhead = start.toMillis() - now.getTime();
    if (msAhead < 0 || msAhead > d.starts_within_hours * 3_600_000) return false;
  }
  if (d.time_of_day) {
    const hhmm = start.toFormat("HH:mm");
    if (hhmm < d.time_of_day.start || hhmm >= d.time_of_day.end) return false;
  }
  return true;
}

/**
 * Price one slot for one service.
 * Returns `{ok:false, reason:"blocked_by_rule"}` when the slot falls on a blackout day,
 * or when `slot.start` cannot be parsed (callers validate times before pricing).
 */
export function price(
  service: Pick<Service, "id" | "price_cents">,
  slot: Pick<Slot, "start">,
  now: Date,
  config: Pick<
    Config,
    "timezone" | "blackout_days" | "discounts" | "max_total_discount_pct" | "floor_cents"
  >,
): PriceResult {
  const start = DateTime.fromISO(slot.start, { setZone: true }).setZone(config.timezone);
  if (!start.isValid) return { ok: false, reason: "blocked_by_rule", rule_id: "invalid_slot_start" };

  const localDate = start.toISODate();
  if (localDate && config.blackout_days.includes(localDate)) {
    return { ok: false, reason: "blocked_by_rule", rule_id: `blackout:${localDate}` };
  }

  const base = service.price_cents;
  const applied: AppliedRule[] = [];
  let running = base;

  for (const d of config.discounts) {
    if (!discountApplies(d, start, now)) continue;
    const off = Math.min(pctOfCents(running, d.pct), running);
    if (off <= 0) continue;
    running -= off;
    const rule: AppliedRule = { rule_id: d.id, kind: "discount", amount_cents: -off };
    if (d.label !== undefined) rule.label = d.label;
    applied.push(rule);
  }

  // Cap: total discount measured against the base price.
  const maxOff = pctOfCents(base, config.max_total_discount_pct);
  if (base - running > maxOff) {
    const capped = base - maxOff;
    applied.push({ rule_id: "max_total_discount", kind: "cap", amount_cents: capped - running });
    running = capped;
  }

  // Floor last; it always wins over discounts, but never raises above the base price.
  const floor = Math.min(config.floor_cents, base);
  if (running < floor) {
    applied.push({ rule_id: "floor", kind: "floor", amount_cents: floor - running });
    running = floor;
  }

  return { ok: true, base_cents: base, price_cents: running, applied_rules: applied };
}
