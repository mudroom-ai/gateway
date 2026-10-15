// Adapts a plain CalendarConnector (Google) to BookingConnector: services
// and prices come from the config, slots from the gateway's own engine
// (opening hours minus padded busy intervals), and a booking is one calendar
// event with a deterministic id. Cancel deletes the event; reschedule inserts
// the new event first and deletes the old one, so the customer never loses
// both.

import type { Config } from "../config.js";
import { toService } from "../services.js";
import { computeSlots, formatInZone, padBusy, parseRfc3339 } from "../slots.js";
import type { Customer, Interval, Service, Slot } from "../types.js";
import {
  ConnectorError,
  type BookingConnector,
  type BookingRequest,
  type CalendarConnector,
  type CalendarEvent,
  type ExternalBooking,
  type FindSlotsOptions,
} from "./types.js";

interface MsInterval {
  start: number;
  end: number;
}

export class CalendarBookingConnector implements BookingConnector {
  readonly pricesServices = false;
  readonly requiresPhone = false;

  constructor(
    private readonly config: Config,
    readonly calendar: CalendarConnector,
  ) {}

  async listServices(): Promise<Service[]> {
    return this.config.services.map(toService);
  }

  async findSlots(service: Service, range: Interval, opts?: FindSlotsOptions): Promise<Slot[]> {
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    const padMs = this.config.default_buffer_min * 60_000;
    const longestSpan = (service.duration_min + service.buffer_min) * 60_000;
    // Widen the query so a busy block ending just before the range still pads into it.
    const busyRaw = await this.calendar.getBusy({
      start: formatInZone(start - padMs, this.config.timezone),
      end: formatInZone(end + longestSpan, this.config.timezone),
    });
    const busy: MsInterval[] = [];
    for (const b of busyRaw) {
      const s = parseRfc3339(b.start);
      const e = parseRfc3339(b.end);
      if (s && e) busy.push({ start: s.toMillis(), end: e.toMillis() });
    }
    // Moving a booking: drop the busy block that is its own event, before padding.
    const own = opts?.ignoreBooking;
    if (own) {
      const ev = await this.calendar.getEvent(own.id);
      const os = Date.parse(ev?.start ?? own.start);
      const oe = Date.parse(ev?.end ?? own.end);
      const i = busy.findIndex((b) => b.start === os && b.end === oe);
      if (i >= 0) busy.splice(i, 1);
    }
    return computeSlots(service, this.config, { start, end }, padBusy(busy, this.config.default_buffer_min));
  }

  /** Re-check the calendar, then insert. */
  async book(req: BookingRequest): Promise<ExternalBooking> {
    await this.assertFree(req);
    return this.insert(req);
  }

  /** An existing event with this id counts as created. */
  private async insert(req: BookingRequest): Promise<ExternalBooking> {
    try {
      return toExternal(await this.calendar.insertEvent(newEvent(req)));
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "already_exists") {
        return { id: req.event_id, start: req.slot.start, end: req.block_end };
      }
      throw e;
    }
  }

  async getBooking(id: string): Promise<ExternalBooking | null> {
    const ev = await this.calendar.getEvent(id);
    return ev ? toExternal(ev) : null;
  }

  async cancel(id: string): Promise<void> {
    await this.calendar.deleteEvent(id);
  }

  async reschedule(id: string, req: BookingRequest): Promise<ExternalBooking> {
    // The old event still sits on the calendar; its own span must not count as a clash.
    const old = await this.calendar.getEvent(id);
    await this.assertFree(req, old ? { start: old.start, end: old.end } : undefined);
    const created = await this.insert(req);
    if (created.id !== id) await this.calendar.deleteEvent(id);
    return created;
  }

  async checkAccess(): Promise<void> {
    await this.calendar.checkAccess();
  }

  private async assertFree(req: BookingRequest, ignore?: Interval): Promise<void> {
    const padMs = this.config.default_buffer_min * 60_000;
    const startMs = Date.parse(req.slot.start);
    const blockEndMs = Date.parse(req.block_end);
    const busy = (
      await this.calendar.getBusy({
        start: formatInZone(startMs - padMs, this.config.timezone),
        end: req.block_end,
      })
    ).filter((b) => !(ignore && Date.parse(b.start) === Date.parse(ignore.start) && Date.parse(b.end) === Date.parse(ignore.end)));
    // Our own event (a retry after a crash) is not a clash.
    const clash = busy.some((b) => Date.parse(b.start) < blockEndMs && startMs < Date.parse(b.end) + padMs);
    if (clash && !(await this.calendar.getEvent(req.event_id))) {
      throw new ConnectorError("slot_unavailable", "The slot was just taken");
    }
  }
}

/** The calendar event the gateway writes for one booking. Shared with shadow-mode connectors. */
export function newEvent(req: BookingRequest) {
  const c: Customer = req.customer;
  const contact = [c.phone, c.email].filter(Boolean).join(" / ");
  return {
    id: req.event_id,
    start: req.slot.start,
    end: req.block_end,
    title: `${req.service.name} - ${c.name}`,
    description: [
      `Customer: ${c.name}`,
      `Contact: ${contact}`,
      c.notes ? `Notes: ${c.notes}` : "",
      `Price: ${(req.price_cents / 100).toFixed(2)} ${req.currency}`,
      `Booking: ${req.booking_id} (quote ${req.quote_id})`,
      "Booked by Mudroom",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export const toExternal = (ev: CalendarEvent): ExternalBooking => ({ id: ev.id, start: ev.start, end: ev.end });
