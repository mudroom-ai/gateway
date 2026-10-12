// quote core op: request -> findSlots + rules price -> stored open quote,
// or a failure (no_slot / over_budget / blocked_by_rule) with up to 3 alternatives.
// The price and applied rules are locked at quote time; book uses the stored price.
// With booking_id + contact (moving a booking) that booking's span counts as free,
// and the quote is tied to it: only reschedule of that booking accepts it.

import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { BookingConnector } from "./connectors/types.js";
import { err, ok, type Alternative, type Result } from "./errors.js";
import { price } from "./rules/engine.js";
import { findService } from "./services.js";
import { findSlots, formatInZone, parseRfc3339, type SlotPricer } from "./slots.js";
import type { Store } from "./store/sqlite.js";
import type { PricedSlot, Quote, QuoteRequest } from "./types.js";

/** Keep expired quotes this long so callers get `expired`, not `unknown_quote`. */
const PURGE_GRACE_MS = 24 * 3_600_000;

export interface QuoteDeps {
  config: Config;
  connector: BookingConnector;
  store: Store;
  now?: () => Date;
}

/** Wrap the rules engine as a find_slots pricer: blocked slots are dropped. */
export function rulesPricer(config: Config, now: Date, onBlocked?: () => void): SlotPricer {
  return (service, slot) => {
    const r = price(service, slot, now, config);
    if (r.ok) return r.price_cents;
    onBlocked?.();
    return null;
  };
}

const toAlt = (s: PricedSlot): Alternative => ({
  slot: { service_id: s.service_id, start: s.start, end: s.end },
  price_cents: s.price_cents,
});

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export async function quote(req: QuoteRequest, deps: QuoteDeps): Promise<Result<Quote>> {
  const { config, connector, store } = deps;
  const nowDate = (deps.now ?? (() => new Date()))();
  const nowMs = nowDate.getTime();

  if (
    req.max_price_cents !== undefined &&
    (!Number.isInteger(req.max_price_cents) || req.max_price_cents < 0)
  ) {
    return err("invalid_request", "max_price_cents must be a non-negative integer (minor units)");
  }

  let blocked = 0;
  const slotDeps = {
    config,
    connector,
    store,
    now: () => nowDate,
    price: rulesPricer(config, nowDate, () => blocked++),
  };
  const found = await findSlots(req, slotDeps);
  if (!found.ok) return found;

  const ws = parseRfc3339(req.window.start)!.toMillis();
  const we = parseRfc3339(req.window.end)!.toMillis();
  const distance = (s: PricedSlot) => {
    const a = Date.parse(s.start);
    const b = Date.parse(s.end);
    if (a >= ws && b <= we) return 0;
    return a < ws ? ws - a : b - we;
  };
  const ranked = [...found.data.slots].sort((x, y) => distance(x) - distance(y) || Date.parse(x.start) - Date.parse(y.start));
  const budget = req.max_price_cents;
  const affordable = ranked.filter((s) => budget === undefined || s.price_cents <= budget);

  if (affordable.length === 0) {
    if (ranked.length > 0) {
      const cheapest = [...ranked].sort((a, b) => a.price_cents - b.price_cents).slice(0, 3);
      return err("over_budget", `No slot in the window is at or under ${budget} cents; cheapest shown`, {
        alternatives: cheapest.map(toAlt),
      });
    }
    // Nothing in this window: offer the next few slots after it.
    const span = Math.min(Math.max(we - ws, 86_400_000), config.limits.max_window_days * 86_400_000);
    const next = await findSlots(
      {
        service_id: req.service_id,
        window: { start: formatInZone(we, config.timezone), end: formatInZone(we + span, config.timezone) },
        booking_id: req.booking_id,
        phone: req.phone,
        email: req.email,
      },
      { ...slotDeps, price: rulesPricer(config, nowDate) },
    );
    const alts = next.ok
      ? next.data.slots.filter((s) => budget === undefined || s.price_cents <= budget).slice(0, 3).map(toAlt)
      : [];
    if (blocked > 0) {
      return err("blocked_by_rule", "The merchant's rules block every slot in this window", { alternatives: alts });
    }
    return err("no_slot", "No open slot in the window", { alternatives: alts });
  }

  const chosen = affordable[0]!;
  const service = (await findService(connector, req.service_id))!;
  const priced = connector.pricesServices
    ? { ok: true as const, price_cents: service.price_cents, applied_rules: [] }
    : price(service, chosen, nowDate, config);
  if (!priced.ok) return err("blocked_by_rule", `Blocked by rule ${priced.rule_id}`);

  const startMs = Date.parse(chosen.start);
  const expiresMs = nowMs + config.quote_ttl_min * 60_000;
  const q: Quote = {
    quote_id: newId("q"),
    service_id: service.id,
    slot: { service_id: service.id, start: chosen.start, end: chosen.end },
    price_cents: priced.price_cents,
    currency: config.currency,
    applied_rules: priced.applied_rules,
    state: "open",
    created_at: formatInZone(nowMs, config.timezone),
    expires_at: formatInZone(expiresMs, config.timezone),
  };
  // findSlots already authorised it.
  if (req.booking_id !== undefined && req.booking_id !== null) q.for_booking_id = req.booking_id;
  try {
    store.purgeExpiredQuotes(nowMs - PURGE_GRACE_MS);
    store.insertQuote({
      ...q,
      merchant_id: config.merchant_id,
      start_ms: startMs,
      block_end_ms: startMs + (service.duration_min + service.buffer_min) * 60_000,
      expires_at_ms: expiresMs,
    });
  } catch {
    return err("internal", "Could not store the quote");
  }
  return ok(q);
}
