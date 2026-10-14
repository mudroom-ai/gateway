// Demo mode keeps the calendar clean: every event title starts with "[demo]",
// and every booking cancels itself DEMO_BOOKING_TTL_MIN after it was made.
// The schedule is the bookings table itself (created_at), so a restart loses
// nothing: the janitor runs once at boot and then every minute.

import type { BookingConnector, BookingRequest } from "../connectors/types.js";
import { formatInZone } from "../slots.js";
import type { Store } from "../store/sqlite.js";
import type { Booking } from "../types.js";

export const DEMO_TITLE_PREFIX = "[demo] ";
export const JANITOR_EVERY_MS = 60_000;

/** The same connector, with "[demo]" in front of the service name it writes into the calendar. */
export function demoConnector(c: BookingConnector): BookingConnector {
  const tag = (req: BookingRequest): BookingRequest => ({ ...req, service: { ...req.service, name: DEMO_TITLE_PREFIX + req.service.name } });
  const book = (req: BookingRequest) => c.book(tag(req));
  const reschedule = (id: string, req: BookingRequest) => c.reschedule(id, tag(req));
  return new Proxy(c, {
    get(target, prop) {
      if (prop === "book") return book;
      if (prop === "reschedule") return reschedule;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Booked rows made before `cutoffIso` (ISO strings sort by time). */
export function dueDemoBookings(store: Store, merchantId: string, cutoffIso: string): { booking_id: string; event_id: string; response: Booking }[] {
  const rows = store.db
    .prepare("SELECT booking_id, event_id, response FROM bookings WHERE merchant_id = ? AND state = 'booked' AND created_at < ? ORDER BY created_at")
    .all(merchantId, cutoffIso) as { booking_id: string; event_id: string; response: string | null }[];
  return rows.filter((r) => r.response).map((r) => ({ booking_id: r.booking_id, event_id: r.event_id, response: JSON.parse(r.response!) as Booking }));
}

export interface JanitorDeps {
  store: Store;
  connector: BookingConnector;
  merchantId: string;
  timezone: string;
  ttlMs: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Cancel every overdue demo booking (event removed, row cancelled). A failed cancel stays due and is retried next pass. Returns the ids cancelled. */
export async function cancelDueDemoBookings(d: JanitorDeps): Promise<string[]> {
  const now = (d.now ?? Date.now)();
  const log = d.log ?? ((l: string) => console.log(l));
  const done: string[] = [];
  for (const b of dueDemoBookings(d.store, d.merchantId, new Date(now - d.ttlMs).toISOString())) {
    try {
      await d.connector.cancel(b.event_id);
    } catch (e) {
      log(`[demo] auto-cancel failed booking=${b.booking_id}: ${(e as Error).message}`);
      continue;
    }
    const cancelled: Booking = { ...b.response, state: "cancelled", cancelled_at: formatInZone(now, d.timezone) };
    d.store.markCancelled(b.booking_id, cancelled, new Date(now).toISOString());
    log(`[demo] auto-cancelled booking=${b.booking_id}`);
    done.push(b.booking_id);
  }
  return done;
}

/** Run the janitor now and every minute. Returns a stop function. */
export function startDemoJanitor(d: JanitorDeps): () => void {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = cancelDueDemoBookings(d)
      .catch((e) => console.error(`[demo] janitor failed: ${(e as Error).message}`))
      .finally(() => (running = null));
  };
  tick();
  const h = setInterval(tick, JANITOR_EVERY_MS);
  h.unref();
  return () => clearInterval(h);
}
