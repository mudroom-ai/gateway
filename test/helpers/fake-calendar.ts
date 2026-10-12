// In-memory CalendarConnector for the test suite only: the gateway itself
// never runs on it. Created events count as busy.

import type { Interval } from "../../src/types.js";
import { ConnectorError, type CalendarConnector, type CalendarEvent, type NewCalendarEvent } from "../../src/connectors/types.js";

export class FakeCalendarConnector implements CalendarConnector {
  readonly events = new Map<string, CalendarEvent>();
  insertCalls = 0;

  constructor(public busy: Interval[] = []) {}

  async getBusy(range: Interval): Promise<Interval[]> {
    const s = Date.parse(range.start);
    const e = Date.parse(range.end);
    const all = [...this.busy, ...[...this.events.values()].map((ev) => ({ start: ev.start, end: ev.end }))];
    return all.filter((b) => Date.parse(b.start) < e && s < Date.parse(b.end));
  }

  async insertEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    this.insertCalls++;
    if (this.events.has(event.id)) throw new ConnectorError("already_exists", `event ${event.id} already exists`);
    const ev: CalendarEvent = { ...event };
    this.events.set(event.id, ev);
    return ev;
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    return this.events.get(id) ?? null;
  }

  async deleteEvent(id: string): Promise<void> {
    this.events.delete(id);
  }

  async checkAccess(): Promise<void> {}
}
