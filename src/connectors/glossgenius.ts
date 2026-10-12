// GlossGenius connector, shadow mode. GlossGenius has no public API, but its
// public booking page reads services and availability from api.glossgenius.com
// with no cookies and no auth. This connector replays those reads over plain
// HTTP and never writes to GlossGenius:
//
// - Identifiers: one GET of https://<slug>.glossgenius.com/services; the
//   business, space and location tokens come from the page's __NEXT_DATA__
//   JSON (regex fallback). Minted lazily, cached for the process, re-minted
//   once when the API answers 401/403/404.
// - Services: POST /v4/web/services/search. Hidden or variable prices are
//   skipped (the gateway must quote a fixed price). Cached 5 minutes.
// - Slots: POST /v4/web/bookings/availabilities/search, one calendar month
//   (merchant zone) per call, cached per service+month. Filtered by the
//   minimum lead time and by the Google Calendar's own busy time, which is
//   where the gateway's earlier shadow bookings live.
// - Book / cancel / reschedule: written to the Google Calendar exactly like
//   CalendarBookingConnector, after a fresh availability re-check. The core
//   ops then tell the merchant through the CommunicationConnector; `ownerNotes` asks
//   them to key the change into GlossGenius by hand.
//
// Errors use the existing codes: vendor trouble is calendar_unavailable with
// a message naming the cause (blocked_by_vendor, connector_drift).

import { DateTime } from "luxon";
import { formatInZone, parseRfc3339 } from "../slots.js";
import type { Interval, Service, Slot } from "../types.js";
import { newEvent, toExternal } from "./calendar.js";
import {
  ConnectorError,
  type BookingConnector,
  type BookingRequest,
  type CalendarConnector,
  type ExternalBooking,
  type FindSlotsOptions,
} from "./types.js";

export const GLOSSGENIUS_API = "https://api.glossgenius.com";
const SERVICES_TTL_MS = 5 * 60_000;
const DEFAULT_RETRY_S = 30;
const MAX_SERVICE_PAGES = 20;

export interface GlossGeniusConnectorOptions {
  /** The merchant's public booking URL, e.g. https://studio.glossgenius.com/services. */
  bookingUrl: string;
  /** Where shadow bookings are written (Google Calendar). */
  calendar: CalendarConnector;
  /** Merchant IANA zone. */
  timezone: string;
  /** Slots closer than this are never offered (the vendor read can be stale). Default 48. */
  minLeadHours?: number;
  /** Availability cache TTL. Default 300_000. */
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (m: string) => void;
}

/** Tokens the booking page hands its own API. */
export interface GlossGeniusIds {
  slug: string;
  businessToken: string;
  spaceToken: string;
  locationToken: string;
}

export interface GlossGeniusService {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  total_duration?: unknown;
  price_varies?: unknown;
  price_hidden?: unknown;
  token?: unknown;
}

export interface GlossGeniusAvailability {
  starts_at?: unknown;
}

// ---- pure helpers ----

/** The booking URL's first host label: https://luna-studio.glossgenius.com/services -> "luna-studio". */
export function slugFromUrl(bookingUrl: string): string {
  const host = new URL(bookingUrl).hostname;
  const slug = host.split(".")[0] ?? "";
  if (!slug || !host.endsWith("glossgenius.com")) throw new Error(`Not a GlossGenius booking URL: ${bookingUrl}`);
  return slug;
}

/**
 * Pull the business, space and (first) location token out of the booking page
 * HTML. Tries __NEXT_DATA__ first, then regexes over the raw HTML. Null when
 * any token is missing.
 */
export function parseBookingPage(html: string): Omit<GlossGeniusIds, "slug"> | null {
  let businessToken: string | undefined;
  let spaceToken: string | undefined;
  let locationToken: string | undefined;

  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (m) {
    try {
      const data = JSON.parse(m[1]!) as Record<string, unknown>;
      const user = dig(data, ["props", "serverContext", "publicUser"]);
      if (user && typeof user === "object") {
        const u = user as Record<string, unknown>;
        if (typeof u.business_token === "string") businessToken = u.business_token;
        if (typeof u.space_token === "string") spaceToken = u.space_token;
      }
      locationToken = findLocationToken(data);
    } catch {
      // fall through to the regexes
    }
  }

  // Fallback: tokens may also sit in window.__LOCATIONS__ or escaped JSON strings.
  const q = String.raw`\\?"`;
  const grab = (key: string, prefix: string) =>
    new RegExp(`${q}${key}${q}\\s*:\\s*${q}(${prefix}-[^"\\\\]+)`).exec(html)?.[1];
  businessToken ??= grab("business_token", "10016");
  spaceToken ??= grab("space_token", "1001a") ?? grab("spaceToken", "1001a");
  locationToken ??= grab("token", "1003d");

  if (!businessToken || !spaceToken || !locationToken) return null;
  return { businessToken, spaceToken, locationToken };
}

function dig(v: unknown, path: string[]): unknown {
  let cur = v;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** First object anywhere in the tree that looks like a location: a `token` next to a `spaceToken`. */
function findLocationToken(v: unknown, depth = 0): string | undefined {
  if (!v || typeof v !== "object" || depth > 12) return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = findLocationToken(x, depth + 1);
      if (t) return t;
    }
    return undefined;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.token === "string" && typeof o.spaceToken === "string") return o.token;
  for (const x of Object.values(o)) {
    const t = findLocationToken(x, depth + 1);
    if (t) return t;
  }
  return undefined;
}

/** Map vendor services to gateway services, skipping ones the gateway cannot quote a fixed price for. */
export function mapServices(raw: GlossGeniusService[], skip: (name: string, why: string) => void = () => {}): Service[] {
  const out: Service[] = [];
  for (const s of raw) {
    const name = typeof s.name === "string" ? s.name : String(s.token ?? "?");
    if (typeof s.token !== "string" || !s.token) {
      skip(name, "no token");
      continue;
    }
    if (s.price_hidden === true) {
      skip(name, "price is hidden");
      continue;
    }
    if (s.price_varies === true) {
      skip(name, "price varies");
      continue;
    }
    const price = Number(s.price);
    if (s.price === null || s.price === undefined || s.price === "" || !Number.isFinite(price) || price < 0) {
      skip(name, "price is not a number");
      continue;
    }
    const dur = Number(s.total_duration);
    if (!Number.isFinite(dur) || dur <= 0) {
      skip(name, "no duration");
      continue;
    }
    const svc: Service = { id: s.token, name, duration_min: Math.round(dur), buffer_min: 0, price_cents: Math.round(price * 100) };
    if (typeof s.description === "string" && s.description.trim()) svc.description = s.description.trim();
    out.push(svc);
  }
  return out;
}

/** Vendor availability starts as instants (ms), invalid ones dropped. */
export function availabilityStarts(data: GlossGeniusAvailability[]): number[] {
  const out: number[] = [];
  for (const a of data) {
    const t = typeof a.starts_at === "string" ? Date.parse(a.starts_at) : NaN;
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** One slot per start, formatted in the merchant zone. */
export function toSlots(service: Service, starts: number[], timezone: string): Slot[] {
  return starts.map((t) => ({
    service_id: service.id,
    start: formatInZone(t, timezone),
    end: formatInZone(t + service.duration_min * 60_000, timezone),
  }));
}

/** The calendar months (merchant zone) a range touches, as inclusive YYYY-MM-DD windows. */
export function monthsInRange(range: { start: number; end: number }, timezone: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let m = DateTime.fromMillis(range.start, { zone: timezone }).startOf("month");
  // The range is half-open; an end exactly at midnight on the 1st does not touch that month.
  const last = DateTime.fromMillis(Math.max(range.start, range.end - 1), { zone: timezone }).startOf("month");
  while (m <= last) {
    out.push({ from: m.toISODate()!, to: m.endOf("month").toISODate()! });
    m = m.plus({ months: 1 });
  }
  return out;
}

// ---- connector ----

interface HttpResult {
  status: number;
  json: unknown;
  /** True when the body was not JSON (an HTML challenge page, say). */
  notJson: boolean;
  retryAfterS: number | undefined;
}

export class GlossGeniusConnector implements BookingConnector {
  readonly pricesServices = true;
  readonly requiresPhone = false;
  readonly ownerNotes = {
    booked: "Not in GlossGenius yet, please add it by hand.",
    cancelled: "Please remove it from GlossGenius.",
    rescheduled: "Please move it in GlossGenius.",
  };

  readonly calendar: CalendarConnector;
  private readonly slug: string;
  private readonly origin: string;
  private readonly minLeadMs: number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (m: string) => void;
  private ids: Promise<GlossGeniusIds> | undefined;
  private services: { at: number; list: Service[] } | undefined;
  private readonly months = new Map<string, { at: number; starts: number[] }>();
  private readonly warnedSkips = new Set<string>();

  constructor(private readonly opts: GlossGeniusConnectorOptions) {
    this.slug = slugFromUrl(opts.bookingUrl);
    this.origin = `https://${this.slug}.glossgenius.com`;
    this.calendar = opts.calendar;
    this.minLeadMs = (opts.minLeadHours ?? 48) * 3_600_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  // ---- transport ----

  private async http(method: string, url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult & { text: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      const why = name === "TimeoutError" || name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : `network error: ${(e as Error)?.message ?? e}`;
      throw unavailable(`GlossGenius unreachable (${method} ${new URL(url).pathname} ${why})`, undefined, e);
    }
    const text = await res.text();
    let json: unknown;
    let notJson = false;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      notJson = true;
    }
    const ra = Number(res.headers.get("retry-after"));
    return { status: res.status, json, notJson, text, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  }

  /** Booking-page GET, then token extraction. Throws calendar_unavailable with the reason. */
  private async mint(): Promise<GlossGeniusIds> {
    const url = `${this.origin}/services`;
    const r = await this.http("GET", url, undefined, { Accept: "text/html,application/xhtml+xml" });
    if (r.status === 429 || r.status >= 500) throw unavailable(`GlossGenius booking page returned ${r.status}`, r.retryAfterS);
    if (r.status === 401 || r.status === 403) throw unavailable(`GlossGenius refused the request (blocked_by_vendor): booking page returned ${r.status}`);
    if (r.status >= 300) throw unavailable(`GlossGenius booking page returned ${r.status}`);
    const ids = parseBookingPage(r.text);
    if (!ids) throw unavailable("GlossGenius response changed shape (connector_drift): booking page has no business, space or location token");
    return { slug: this.slug, ...ids };
  }

  private identifiers(): Promise<GlossGeniusIds> {
    if (!this.ids) {
      const p = this.mint();
      this.ids = p;
      // A failed mint is not cached: the next call tries again.
      p.catch(() => {
        if (this.ids === p) this.ids = undefined;
      });
    }
    return this.ids;
  }

  /** One API call; re-mints identifiers once on 401/403/404. */
  private async api(method: "GET" | "POST", build: (ids: GlossGeniusIds) => { path: string; body?: unknown }): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const ids = await this.identifiers();
      const { path, body } = build(ids);
      const r = await this.http(method, `${GLOSSGENIUS_API}${path}`, body, {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        app_name: "GlossGenius",
        Origin: this.origin,
        Referer: `${this.origin}/`,
      });
      const p = path.split("?")[0];
      if (r.status === 429 || r.status >= 500) throw unavailable(`GlossGenius unavailable (${method} ${p} returned ${r.status})`, r.retryAfterS);
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        if (attempt === 0) {
          this.ids = undefined;
          continue;
        }
        if (r.status === 404) throw unavailable(`GlossGenius response changed shape (connector_drift): ${method} ${p} returned 404`);
        throw unavailable(`GlossGenius refused the request (blocked_by_vendor): ${method} ${p} returned ${r.status}`);
      }
      if (r.status >= 300) throw unavailable(`GlossGenius unavailable (${method} ${p} returned ${r.status})`);
      if (r.notJson) throw unavailable(`GlossGenius refused the request (blocked_by_vendor): ${method} ${p} returned a non-JSON page`);
      if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) {
        throw unavailable(`GlossGenius response changed shape (connector_drift): ${method} ${p} did not return an object`);
      }
      return r.json as Record<string, unknown>;
    }
  }

  // ---- services ----

  async listServices(): Promise<Service[]> {
    if (this.services && this.now() - this.services.at < SERVICES_TTL_MS) return this.services.list;
    const raw: GlossGeniusService[] = [];
    let cursor: unknown;
    for (let page = 0; page < MAX_SERVICE_PAGES; page++) {
      const body = await this.api("POST", (ids) => ({
        path: "/v4/web/services/search",
        body: { location_token: ids.locationToken, slug: ids.slug, ...(cursor ? { cursor } : {}) },
      }));
      if (!Array.isArray(body.services)) throw unavailable("GlossGenius response changed shape (connector_drift): services search has no services array");
      raw.push(...(body.services as GlossGeniusService[]));
      const pg = body.pagination as { has_next_page?: unknown; next_cursor?: unknown } | undefined;
      if (pg?.has_next_page !== true || !pg.next_cursor || pg.next_cursor === cursor) break;
      cursor = pg.next_cursor;
    }
    const list = mapServices(raw, (name, why) => {
      const key = `${name}:${why}`;
      if (this.warnedSkips.has(key)) return;
      this.warnedSkips.add(key);
      this.warn(`[gateway] GlossGenius service "${name}" skipped: ${why}`);
    });
    this.services = { at: this.now(), list };
    return list;
  }

  // ---- availability ----

  /** Vendor starts for one service in one month window. Cached unless `fresh`. */
  private async monthStarts(serviceId: string, month: { from: string; to: string }, fresh = false): Promise<number[]> {
    const key = `${serviceId}|${month.from}`;
    const hit = this.months.get(key);
    if (!fresh && hit && this.now() - hit.at < this.cacheTtlMs) return hit.starts;
    const body = await this.api("POST", (ids) => ({
      path: "/v4/web/bookings/availabilities/search",
      body: {
        business_token: ids.businessToken,
        slug: ids.slug,
        space_token: ids.spaceToken,
        location_tokens: [ids.locationToken],
        availability_window: { from: month.from, to: month.to },
        events: [{ service_token: serviceId, space_member_tokens: [] }],
      },
    }));
    if (!Array.isArray(body.data)) throw unavailable("GlossGenius response changed shape (connector_drift): availability search has no data array");
    const starts = availabilityStarts(body.data as GlossGeniusAvailability[]);
    this.months.set(key, { at: this.now(), starts });
    return starts;
  }

  async findSlots(service: Service, range: Interval, opts?: FindSlotsOptions): Promise<Slot[]> {
    const startMs = Date.parse(range.start);
    const endMs = Date.parse(range.end);
    const durMs = service.duration_min * 60_000;
    const earliest = this.now() + this.minLeadMs;
    if (!(endMs > startMs) || endMs <= earliest) return [];

    const starts: number[] = [];
    for (const month of monthsInRange({ start: startMs, end: endMs }, this.opts.timezone)) {
      starts.push(...(await this.monthStarts(service.id, month)));
    }
    const candidates = [...new Set(starts)]
      .filter((t) => t >= earliest && t >= startMs && t + durMs <= endMs)
      .sort((a, b) => a - b);
    if (!candidates.length) return [];

    // The calendar holds the gateway's earlier shadow bookings (and anything else the merchant blocked).
    const busy = await this.busy({ start: startMs - durMs, end: endMs + durMs });
    const own = opts?.ignoreBooking;
    if (own) {
      const ev = await this.calendar.getEvent(own.id);
      const os = Date.parse(ev?.start ?? own.start);
      const oe = Date.parse(ev?.end ?? own.end);
      const i = busy.findIndex((b) => b.start === os && b.end === oe);
      if (i >= 0) busy.splice(i, 1);
    }
    const free = candidates.filter((t) => !busy.some((b) => b.start < t + durMs && t < b.end));
    return toSlots(service, free, this.opts.timezone);
  }

  private async busy(range: { start: number; end: number }): Promise<{ start: number; end: number }[]> {
    const raw = await this.calendar.getBusy({ start: formatInZone(range.start, this.opts.timezone), end: formatInZone(range.end, this.opts.timezone) });
    const out: { start: number; end: number }[] = [];
    for (const b of raw) {
      const s = parseRfc3339(b.start);
      const e = parseRfc3339(b.end);
      if (s && e) out.push({ start: s.toMillis(), end: e.toMillis() });
    }
    return out;
  }

  /** Fresh vendor read: is `req.slot.start` still offered? */
  private async assertVendorOffers(req: BookingRequest): Promise<void> {
    const t = Date.parse(req.slot.start);
    const [month] = monthsInRange({ start: t, end: t + 1 }, this.opts.timezone);
    const starts = await this.monthStarts(req.service.id, month!, true);
    if (!starts.includes(t)) throw new ConnectorError("slot_unavailable", "The slot is no longer offered");
  }

  // ---- writes (calendar only) ----

  async book(req: BookingRequest): Promise<ExternalBooking> {
    await this.assertVendorOffers(req);
    await this.assertFree(req);
    return this.insert(req);
  }

  async getBooking(id: string): Promise<ExternalBooking | null> {
    const ev = await this.calendar.getEvent(id);
    return ev ? toExternal(ev) : null;
  }

  async cancel(id: string): Promise<void> {
    const ev = await this.calendar.getEvent(id);
    if (!ev) return; // already gone: nothing to delete
    await this.calendar.deleteEvent(id);
  }

  async reschedule(id: string, req: BookingRequest): Promise<ExternalBooking> {
    const old = await this.calendar.getEvent(id);
    await this.assertVendorOffers(req);
    await this.assertFree(req, old ? { start: old.start, end: old.end } : undefined);
    const created = await this.insert(req);
    if (created.id !== id) await this.calendar.deleteEvent(id);
    return created;
  }

  async checkAccess(): Promise<void> {
    try {
      this.ids = undefined;
      await this.identifiers();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new ConnectorError(
        "calendar_auth_failed",
        `Could not read the GlossGenius booking page at ${this.opts.bookingUrl} (${reason}). Check GLOSSGENIUS_BOOKING_URL opens in a browser and shows your services.`,
        { cause: e },
      );
    }
    await this.calendar.checkAccess();
  }

  /** An existing event with this id counts as created. */
  private async insert(req: BookingRequest): Promise<ExternalBooking> {
    try {
      return toExternal(await this.calendar.insertEvent(newEvent(req)));
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "already_exists") return { id: req.event_id, start: req.slot.start, end: req.block_end };
      throw e;
    }
  }

  private async assertFree(req: BookingRequest, ignore?: Interval): Promise<void> {
    const startMs = Date.parse(req.slot.start);
    const blockEndMs = Date.parse(req.block_end);
    const busy = (await this.busy({ start: startMs, end: blockEndMs })).filter(
      (b) => !(ignore && b.start === Date.parse(ignore.start) && b.end === Date.parse(ignore.end)),
    );
    const clash = busy.some((b) => b.start < blockEndMs && startMs < b.end);
    // Our own event (a retry after a crash) is not a clash.
    if (clash && !(await this.calendar.getEvent(req.event_id))) throw new ConnectorError("slot_unavailable", "The slot was just taken");
  }
}

function unavailable(message: string, retryAfterS?: number, cause?: unknown): ConnectorError {
  return new ConnectorError("calendar_unavailable", message, { retry_after_s: retryAfterS ?? DEFAULT_RETRY_S, cause });
}

/** Build the connector from settings, or undefined when GlossGenius is not configured. */
export function createGlossGeniusConnector(
  settings: { glossgenius_booking_url: string | undefined; glossgenius_min_lead_hours?: number },
  deps: { calendar: CalendarConnector | undefined; timezone: string; timeoutMs?: number },
): GlossGeniusConnector | undefined {
  const url = settings.glossgenius_booking_url;
  if (!url) return undefined;
  if (!deps.calendar) {
    throw new Error("GlossGenius shadow mode needs Google Calendar: set GOOGLE_SERVICE_ACCOUNT_JSON (or _FILE) and GOOGLE_CALENDAR_ID");
  }
  return new GlossGeniusConnector({
    bookingUrl: url,
    calendar: deps.calendar,
    timezone: deps.timezone,
    ...(settings.glossgenius_min_lead_hours !== undefined ? { minLeadHours: settings.glossgenius_min_lead_hours } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
}
