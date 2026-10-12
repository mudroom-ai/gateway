// find_slots core op, plus the pure slot engine calendar connectors use.
//
// The op validates the window, asks the BookingConnector for bookable starts
// and prices them. For calendar connectors the engine below builds those
// starts: slots = opening hours ∩ ¬busy, generated in the merchant's IANA zone
// with Luxon. Every busy interval is padded at its end by `default_buffer_min`;
// a candidate occupies [start, start + duration + service buffer), matching
// the event span the gateway creates.
// DST: candidates are stepped in real instants inside each local hours range,
// so spring-forward gap times never appear and fall-back repeated wall times
// yield each real instant exactly once.

import { DateTime } from "luxon";
import type { Config } from "./config.js";
import { ownBookingSpan } from "./cancel.js";
import type { BookingConnector, FindSlotsOptions } from "./connectors/types.js";
import { err, ok, type Result } from "./errors.js";
import { connectorErr, findService } from "./services.js";
import type { Store } from "./store/sqlite.js";
import type { Cents, FindSlotsRequest, FindSlotsResult, PricedSlot, Service, Slot, Weekday } from "./types.js";

/** Candidate start granularity, in minutes. */
export const SLOT_STEP_MIN = 15;
/** Clock-skew grace for "window start is in the past". */
const PAST_GRACE_MS = 5 * 60_000;

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Parse an RFC 3339 timestamp that carries an offset. Bare local times return null. */
export function parseRfc3339(s: unknown): DateTime | null {
  if (typeof s !== "string" || !RFC3339_WITH_OFFSET.test(s)) return null;
  const dt = DateTime.fromISO(s, { setZone: true });
  return dt.isValid ? dt : null;
}

/** Format an instant as RFC 3339 in the merchant zone (offset included). */
export function formatInZone(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true })!;
}

/** Returns a price for the slot, or null when a rule blocks it (skip the slot). */
export type SlotPricer = (service: Service, slot: Slot) => Cents | null;

export interface FindSlotsDeps {
  config: Config;
  connector: BookingConnector;
  now?: () => Date;
  /** The rules engine plugs in here; defaults to the base price. */
  price?: SlotPricer;
  /** Needed to honour req.booking_id (moving a booking). */
  store?: Store;
}

interface MsInterval {
  start: number;
  end: number;
}

/** Pad each busy interval at its end by the merchant default buffer. */
export function padBusy(busy: MsInterval[], bufferMin: number): MsInterval[] {
  return busy.map((b) => ({ start: b.start, end: b.end + bufferMin * 60_000 }));
}

/**
 * Pure slot generator. `range` bounds the slot [start, end) (window ± flexibility,
 * clamped to now). `busy` must already be padded.
 */
export function computeSlots(service: Service, config: Config, range: MsInterval, busy: MsInterval[]): Slot[] {
  const zone = config.timezone;
  const blackout = new Set(config.blackout_days);
  const durMs = service.duration_min * 60_000;
  const spanMs = (service.duration_min + service.buffer_min) * 60_000;
  const stepMs = SLOT_STEP_MIN * 60_000;
  const seen = new Set<number>();
  const out: Slot[] = [];

  // Walk local calendar days covering the range (one day of slack each side).
  let day = DateTime.fromMillis(range.start, { zone }).startOf("day").minus({ days: 1 });
  const lastDay = DateTime.fromMillis(range.end, { zone }).startOf("day").plus({ days: 1 });
  while (day <= lastDay) {
    const date = day.toISODate()!;
    const wd = WEEKDAYS[day.weekday - 1]!;
    if (!blackout.has(date)) {
      for (const h of config.hours[wd]) {
        const [sh, sm] = h.start.split(":").map(Number) as [number, number];
        const [eh, em] = h.end.split(":").map(Number) as [number, number];
        // Luxon shifts a gap wall time forward; a repeated wall time resolves to one instant.
        const open = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: sh, minute: sm }, { zone }).toMillis();
        const close = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: eh, minute: em }, { zone }).toMillis();
        for (let t = open; t + durMs <= close; t += stepMs) {
          if (t < range.start || t + durMs > range.end) continue;
          if (seen.has(t)) continue;
          const spanEnd = t + spanMs;
          if (busy.some((b) => b.start < spanEnd && t < b.end)) continue;
          seen.add(t);
          out.push({ service_id: service.id, start: formatInZone(t, zone), end: formatInZone(t + durMs, zone) });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return out;
}

export async function findSlots(req: FindSlotsRequest, deps: FindSlotsDeps): Promise<Result<FindSlotsResult>> {
  const { config, connector } = deps;
  const limits = config.limits;
  const now = (deps.now ?? (() => new Date()))().getTime();

  if (!req || typeof req.service_id !== "string" || !req.window || typeof req.window !== "object") {
    return err("invalid_request", "service_id and window {start, end} are required");
  }
  let service: Service | undefined;
  try {
    service = await findService(connector, req.service_id);
  } catch (e) {
    return connectorErr(e, "service lookup");
  }
  if (!service) return err("unknown_service", `Unknown service "${req.service_id}". Call list_services for valid ids.`);

  const ws = parseRfc3339(req.window.start);
  const we = parseRfc3339(req.window.end);
  if (!ws || !we) {
    return err("invalid_time", "window.start and window.end must be RFC 3339 with an offset, e.g. 2026-10-08T09:00:00-07:00");
  }
  const flex = req.flexibility_min ?? 0;
  if (!Number.isInteger(flex) || flex < 0 || flex > limits.max_flexibility_min) {
    return err("invalid_window", `flexibility_min must be an integer from 0 to ${limits.max_flexibility_min}`);
  }
  const start = ws.toMillis();
  const end = we.toMillis();
  if (end <= start) return err("invalid_window", "window.end must be after window.start");
  if (end - start > limits.max_window_days * 86_400_000) {
    return err("invalid_window", `window may span at most ${limits.max_window_days} days; page forward with a later window`);
  }
  if (start < now - PAST_GRACE_MS) return err("invalid_window", "window.start is in the past");

  // Moving a booking: its own span counts as free.
  let opts: FindSlotsOptions | undefined;
  if (req.booking_id !== undefined && req.booking_id !== null) {
    if (!deps.store) return err("invalid_request", "booking_id is not accepted here");
    const own = ownBookingSpan(req, { config, store: deps.store });
    if (!own.ok) return own;
    if (own.data) opts = { ignoreBooking: own.data.ignore };
  }

  const range = { start: Math.max(start - flex * 60_000, now), end: end + flex * 60_000 };
  if (range.end <= range.start) return ok({ timezone: config.timezone, slots: [] });

  let found: Slot[];
  try {
    found = await connector.findSlots(
      service,
      { start: formatInZone(range.start, config.timezone), end: formatInZone(range.end, config.timezone) },
      opts,
    );
  } catch (e) {
    return connectorErr(e, "calendar lookup");
  }

  // Platforms that set their own prices bypass the rules engine.
  const pricer: SlotPricer = connector.pricesServices ? (svc) => svc.price_cents : (deps.price ?? ((svc) => svc.price_cents));
  const slots: PricedSlot[] = [];
  for (const slot of found) {
    const p = pricer(service, slot);
    if (p !== null) slots.push({ ...slot, price_cents: p });
  }
  return ok({ timezone: config.timezone, slots });
}
