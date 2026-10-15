// Square Appointments connector (buyer-level access, works on Square's free plan).
// Plain fetch with a per-request timeout, no SDK.
//
// - Services: SearchCatalogItems (APPOINTMENTS_SERVICE); one gateway service per
//   bookable, fixed-price item variation. Cached for CATALOG_TTL_MS.
// - Slots: SearchAvailability, any team member. Square needs a 24 h..31 d range,
//   so the query is widened and results filtered back to the asked range. When
//   moving a booking, the filter is its booking_id instead, so Square ignores it.
// - Book: create a customer (Square needs a phone; never reuse a profile, see
//   customerId), re-search the exact
//   start to get a team member and the variation version (this is also the
//   slot re-check), then CreateBooking with the agent's idempotency key.
// - Cancel / reschedule: CancelBooking / UpdateBooking with the booking version.
//
// Square sets prices, so pricesServices = true: quotes carry the catalog price.
// Services with a no-show fee cannot be booked via the API; Square rejects the
// booking and the error is passed on. Errors map to the shared connector codes.

import { createHash } from "node:crypto";
import { formatInZone } from "../slots.js";
import type { Customer, Interval, Service, Slot } from "../types.js";
import { SquareTokenSource } from "./square-oauth.js";
import { ConnectorError, type BookingConnector, type BookingRequest, type ExternalBooking, type FindSlotsOptions } from "./types.js";

export const SQUARE_VERSION = "2026-09-16";
const CATALOG_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export interface SquareConnectorOptions {
  /** A token, or a source that returns a fresh one (see SquareTokenSource). */
  accessToken: string | (() => Promise<string>);
  locationId: string;
  environment: "sandbox" | "production";
  /** Merchant IANA zone, used to format slot times. */
  timezone: string;
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (msg: string) => void;
}

interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
}

interface HttpResult {
  status: number;
  body: { errors?: SquareError[] } & Record<string, unknown>;
  retryAfterS: number | undefined;
}

interface Variation {
  id: string;
  version: number;
  service: Service;
}

interface SquareBooking {
  id: string;
  version: number;
  status: string;
  start_at: string;
  appointment_segments?: { duration_minutes?: number; service_variation_id?: string; team_member_id?: string; service_variation_version?: number }[];
}

interface Availability {
  start_at: string;
  appointment_segments?: { duration_minutes?: number; service_variation_id?: string; team_member_id?: string; service_variation_version?: number }[];
}

const CANCELLED = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED"]);

export class SquareConnector implements BookingConnector {
  readonly pricesServices = true;
  readonly requiresPhone = true;

  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private catalog: { at: number; variations: Variation[] } | undefined;

  constructor(private readonly opts: SquareConnectorOptions) {
    this.base = opts.environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  // ---- transport ----

  private async api(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      const token = typeof this.opts.accessToken === "string" ? this.opts.accessToken : await this.opts.accessToken();
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "square-version": SQUARE_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (e instanceof ConnectorError) throw e; // token refresh failed
      const why = ac.signal.aborted ? `timed out after ${this.timeoutMs} ms` : `network error: ${(e as Error)?.message ?? e}`;
      throw this.unavailable(`${method} ${path} ${why}`, undefined, e);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    const ra = Number(res.headers.get("retry-after"));
    const out: HttpResult = {
      status: res.status,
      body: (parsed && typeof parsed === "object" ? parsed : {}) as HttpResult["body"],
      retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined,
    };
    if (out.status === 401 || out.status === 403) {
      const detail = firstError(out);
      if (/not onboarded to appointments/i.test(detail)) {
        throw new ConnectorError(
          "calendar_auth_failed",
          "This Square seller has not set up Square Appointments. In the Square Dashboard open Appointments, finish the setup, and add at least one bookable service.",
        );
      }
      throw new ConnectorError(
        "calendar_auth_failed",
        `Square denied access (${out.status}: ${detail}). Check SQUARE_ACCESS_TOKEN, SQUARE_ENV and that the token has APPOINTMENTS_READ/WRITE, CUSTOMERS_READ/WRITE and ITEMS_READ.`,
      );
    }
    if (out.status === 429 || out.status >= 500) throw this.unavailable(`${method} ${path} returned ${out.status}: ${firstError(out)}`, out.retryAfterS);
    return out;
  }

  private unavailable(detail: string, retryAfterS?: number, cause?: unknown): ConnectorError {
    return new ConnectorError("calendar_unavailable", `Square unavailable: ${detail}`, { retry_after_s: retryAfterS ?? 5, cause });
  }

  // ---- catalog ----

  private async variations(): Promise<Variation[]> {
    if (this.catalog && this.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.variations;
    const out: Variation[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.api("POST", "/v2/catalog/search-catalog-items", {
        product_types: ["APPOINTMENTS_SERVICE"],
        enabled_location_ids: [this.opts.locationId],
        archived_state: "ARCHIVED_STATE_NOT_ARCHIVED",
        ...(cursor ? { cursor } : {}),
      });
      if (res.status >= 300) throw this.unavailable(`catalog search returned ${res.status}: ${firstError(res)}`);
      for (const item of (res.body.items as CatalogObject[] | undefined) ?? []) out.push(...toVariations(item, this.warn));
      cursor = typeof res.body.cursor === "string" && res.body.cursor ? res.body.cursor : undefined;
    } while (cursor);
    this.catalog = { at: this.now(), variations: out };
    return out;
  }

  async listServices(): Promise<Service[]> {
    return (await this.variations()).map((v) => v.service);
  }

  // ---- availability ----

  /** With `bookingId`, Square searches for that booking and ignores its own time (location and segments come from it). */
  private async availabilities(variationId: string, startMs: number, endMs: number, bookingId?: string): Promise<Availability[]> {
    // Square: start in the future, range between 24 h and 31 d.
    const start = Math.max(startMs, this.now() + 60_000);
    const end = Math.min(Math.max(endMs, start + DAY_MS + 60_000), start + 31 * DAY_MS);
    const res = await this.api("POST", "/v2/bookings/availability/search", {
      query: {
        filter: {
          start_at_range: { start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() },
          ...(bookingId
            ? { booking_id: bookingId }
            : { location_id: this.opts.locationId, segment_filters: [{ service_variation_id: variationId }] }),
        },
      },
    });
    if (res.status >= 300) throw this.unavailable(`availability search returned ${res.status}: ${firstError(res)}`);
    return (res.body.availabilities as Availability[] | undefined) ?? [];
  }

  async findSlots(service: Service, range: Interval, opts?: FindSlotsOptions): Promise<Slot[]> {
    const startMs = Date.parse(range.start);
    const endMs = Date.parse(range.end);
    const zone = this.opts.timezone;
    const seen = new Set<number>();
    const out: Slot[] = [];
    for (const a of await this.availabilities(service.id, startMs, endMs, opts?.ignoreBooking?.id)) {
      const t = Date.parse(a.start_at);
      if (!Number.isFinite(t) || t < startMs || t + service.duration_min * 60_000 > endMs || seen.has(t)) continue;
      seen.add(t);
      out.push({ service_id: service.id, start: formatInZone(t, zone), end: formatInZone(t + service.duration_min * 60_000, zone) });
    }
    return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  /** The availability Square offers at exactly `startIso`, or null. Doubles as the slot re-check. */
  private async segmentAt(variationId: string, startIso: string, bookingId?: string) {
    const t = Date.parse(startIso);
    const hit = (await this.availabilities(variationId, t, t + 60_000, bookingId)).find((a) => Date.parse(a.start_at) === t);
    const seg = hit?.appointment_segments?.find((s) => s.service_variation_id === variationId) ?? hit?.appointment_segments?.[0];
    if (!seg?.team_member_id) return null;
    return {
      service_variation_id: variationId,
      service_variation_version: seg.service_variation_version,
      team_member_id: seg.team_member_id,
    };
  }

  // ---- customers ----

  /**
   * Always create a fresh Square customer (idempotent on the booking key).
   * Contacts are unverified, so looking up an existing profile by phone or
   * email would let a caller attach bookings to a stranger's record. The
   * merchant can merge duplicates in Square.
   */
  private async customerId(c: Customer, idemKey: string): Promise<string> {
    const phone = normalizePhone(c.phone ?? "");
    const [given, ...rest] = c.name.split(/\s+/);
    const res = await this.api("POST", "/v2/customers", {
      idempotency_key: shortKey(`customer:${idemKey}`),
      given_name: given,
      ...(rest.length ? { family_name: rest.join(" ") } : {}),
      ...(c.email ? { email_address: c.email } : {}),
      ...(phone ? { phone_number: phone } : {}),
      note: "Created by Mudroom",
    });
    if (res.status >= 300) {
      const code = firstCode(res);
      if (code === "INVALID_PHONE_NUMBER") throw new ConnectorError("invalid_customer", "The phone number was rejected; use 9 to 16 digits with the country code");
      if (code === "INVALID_EMAIL_ADDRESS") throw new ConnectorError("invalid_customer", "The email address was rejected");
      throw this.unavailable(`customer create returned ${res.status}: ${firstError(res)}`);
    }
    const id = (res.body.customer as { id?: string } | undefined)?.id;
    if (!id) throw this.unavailable("customer create returned no id");
    return id;
  }

  // ---- bookings ----

  async book(req: BookingRequest): Promise<ExternalBooking> {
    if (!req.customer.phone) throw new ConnectorError("invalid_customer", "This merchant books through Square, which needs the customer's phone number");
    const segment = await this.segmentAt(req.service.id, req.slot.start);
    if (!segment) throw new ConnectorError("slot_unavailable", "The slot is no longer offered by Square");
    const customerId = await this.customerId(req.customer, req.idempotency_key);
    const res = await this.api("POST", "/v2/bookings", {
      idempotency_key: shortKey(`booking:${req.idempotency_key}`),
      booking: {
        location_id: this.opts.locationId,
        customer_id: customerId,
        start_at: new Date(Date.parse(req.slot.start)).toISOString(),
        appointment_segments: [segment],
        customer_note: note(req),
      },
    });
    if (res.status >= 300) throw this.bookingError(res, "create");
    return toExternal(res.body.booking as SquareBooking, req.service.duration_min, this.opts.timezone);
  }

  async getBooking(id: string): Promise<ExternalBooking | null> {
    const res = await this.api("GET", `/v2/bookings/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (res.status >= 300) throw this.unavailable(`booking lookup returned ${res.status}: ${firstError(res)}`);
    const b = res.body.booking as SquareBooking;
    if (CANCELLED.has(b.status)) return null;
    const minutes = b.appointment_segments?.[0]?.duration_minutes ?? 0;
    return toExternal(b, minutes, this.opts.timezone);
  }

  private async current(id: string): Promise<SquareBooking | null> {
    const res = await this.api("GET", `/v2/bookings/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (res.status >= 300) throw this.unavailable(`booking lookup returned ${res.status}: ${firstError(res)}`);
    return res.body.booking as SquareBooking;
  }

  async cancel(id: string): Promise<void> {
    const b = await this.current(id);
    if (!b || CANCELLED.has(b.status)) return;
    const res = await this.api("POST", `/v2/bookings/${encodeURIComponent(id)}/cancel`, {
      idempotency_key: shortKey(`cancel:${id}:${b.version}`),
      booking_version: b.version,
    });
    if (res.status >= 300) throw this.bookingError(res, "cancel");
  }

  async reschedule(id: string, req: BookingRequest): Promise<ExternalBooking> {
    const b = await this.current(id);
    if (!b) throw new ConnectorError("unknown_booking", "Square has no such booking");
    if (CANCELLED.has(b.status)) throw new ConnectorError("cancel_forbidden", "This booking was cancelled in Square");
    // Buyer-level apps may move start_at but not rewrite appointment_segments once written.
    // booking_id: the booking's own time must not count against a nearby or overlapping move.
    if (!(await this.segmentAt(req.service.id, req.slot.start, id))) {
      throw new ConnectorError("slot_unavailable", "The new slot is no longer offered by Square");
    }
    const res = await this.api("PUT", `/v2/bookings/${encodeURIComponent(id)}`, {
      idempotency_key: shortKey(`reschedule:${id}:${req.quote_id}`),
      booking: { version: b.version, start_at: new Date(Date.parse(req.slot.start)).toISOString() },
    });
    if (res.status >= 300) throw this.bookingError(res, "update");
    return toExternal(res.body.booking as SquareBooking, req.service.duration_min, this.opts.timezone);
  }

  /** Map a failed booking write to a connector error. Square's own text goes to the log, not to the caller. */
  private bookingError(res: HttpResult, what: "create" | "cancel" | "update"): ConnectorError {
    const detail = firstError(res);
    const code = firstCode(res);
    const lower = detail.toLowerCase();
    this.warn(`[gateway] Square booking ${what} failed (${res.status}): ${detail}`);
    if (what === "create" && (lower.includes("not available") || lower.includes("unavailable") || lower.includes("no longer") || code === "CONFLICT")) {
      return new ConnectorError("slot_unavailable", "The slot is no longer available");
    }
    if (what !== "create" && (lower.includes("cancel") || lower.includes("window") || lower.includes("policy") || res.status === 400 || res.status === 409)) {
      return new ConnectorError("cancel_forbidden", `The merchant's booking system refused the ${what === "cancel" ? "cancellation" : "change"}; it may be outside the cancellation window`);
    }
    if (res.status === 404 || code === "NOT_FOUND") return new ConnectorError("unknown_booking", "No such booking");
    const field = res.body.errors?.[0]?.field ?? "";
    if (what === "create" && res.status === 400 && /email|phone|customer/i.test(field)) {
      return new ConnectorError("invalid_customer", `The merchant's booking system rejected the customer's ${/email/i.test(field) ? "email address" : /phone/i.test(field) ? "phone number" : "details"}`);
    }
    return this.unavailable(`booking ${what} returned ${res.status}`);
  }

  async checkAccess(): Promise<void> {
    const profile = await this.api("GET", "/v2/bookings/business-booking-profile");
    if (profile.status >= 300) throw this.unavailable(`booking profile returned ${profile.status}: ${firstError(profile)}`);
    const p = profile.body.business_booking_profile as { booking_enabled?: boolean; allow_user_cancel?: boolean } | undefined;
    if (p?.booking_enabled === false) this.warn("[gateway] Square: the seller's online booking site is off; API bookings still work in the sandbox, check in production");
    if (p?.allow_user_cancel === false) this.warn("[gateway] Square: customers may not cancel or reschedule; cancel/reschedule will be refused");
    const loc = await this.api("GET", `/v2/locations/${encodeURIComponent(this.opts.locationId)}`);
    if (loc.status === 404) throw new ConnectorError("calendar_auth_failed", `Square location "${this.opts.locationId}" not found. Check SQUARE_LOCATION_ID.`);
    if (loc.status >= 300) throw this.unavailable(`location lookup returned ${loc.status}: ${firstError(loc)}`);
    const services = await this.listServices();
    if (services.length === 0) {
      throw new ConnectorError(
        "calendar_auth_failed",
        "Square has no bookable fixed-price appointment services at this location. Add a service in Square Appointments and mark it bookable online.",
      );
    }
  }
}

// ---- helpers ----

interface CatalogObject {
  id?: string;
  version?: number;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    description_plaintext?: string;
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    name?: string;
    pricing_type?: string;
    price_money?: { amount?: number; currency?: string };
    service_duration?: number;
    available_for_booking?: boolean;
    team_member_ids?: string[];
  };
}

/** One gateway service per bookable, fixed-price variation of an item. */
export function toVariations(item: CatalogObject, warn: (m: string) => void): Variation[] {
  const out: Variation[] = [];
  const itemName = item.item_data?.name ?? "Service";
  const variations = (item.item_data?.variations ?? []).filter((v) => !v.is_deleted);
  for (const v of variations) {
    const d = v.item_variation_data ?? {};
    if (!v.id || d.available_for_booking === false) continue;
    const label = variations.length > 1 && d.name && d.name !== "Regular" ? `${itemName}: ${d.name}` : itemName;
    if (d.pricing_type === "VARIABLE_PRICING" || typeof d.price_money?.amount !== "number") {
      warn(`[gateway] Square: skipping "${label}": it has no fixed price`);
      continue;
    }
    const duration = Math.round((d.service_duration ?? 0) / 60_000);
    if (duration <= 0) {
      warn(`[gateway] Square: skipping "${label}": it has no duration`);
      continue;
    }
    const service: Service = { id: v.id, name: label, duration_min: duration, buffer_min: 0, price_cents: d.price_money.amount };
    const desc = item.item_data?.description_plaintext ?? item.item_data?.description;
    if (desc) service.description = desc;
    out.push({ id: v.id, version: v.version ?? 0, service });
  }
  return out;
}

/** Square accepts 9-16 digits with an optional leading +. Strip formatting, keep the +. */
export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits ? (p.trim().startsWith("+") ? `+${digits}` : digits) : "";
}

/** Square idempotency keys are 1-255 chars; ours may be anything, so hash them. */
function shortKey(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 48);
}

function note(req: BookingRequest): string {
  const lines = [req.customer.notes ?? "", `Booked via Mudroom (ref ${req.booking_id})`].filter(Boolean);
  return lines.join("\n").slice(0, 4096);
}

function toExternal(b: SquareBooking, durationMin: number, zone: string): ExternalBooking {
  const start = Date.parse(b.start_at);
  return { id: b.id, start: formatInZone(start, zone), end: formatInZone(start + durationMin * 60_000, zone) };
}

function firstError(res: HttpResult): string {
  const e = res.body.errors?.[0];
  return e ? [e.code, e.detail, e.field ? `(${e.field})` : ""].filter(Boolean).join(" ") : `HTTP ${res.status}`;
}

function firstCode(res: HttpResult): string | undefined {
  return res.body.errors?.[0]?.code;
}

/** Build from env. Returns undefined when SQUARE_* is not set. */
export function createSquareConnector(
  settings: {
    square_access_token: string | undefined;
    square_refresh_token: string | undefined;
    square_app_id: string | undefined;
    square_app_secret: string | undefined;
    square_location_id: string | undefined;
    square_env: "sandbox" | "production";
  },
  opts: { timezone: string; timeoutMs?: number },
): SquareConnector | undefined {
  if (!settings.square_access_token || !settings.square_location_id) return undefined;
  const app = settings.square_app_id && settings.square_app_secret ? { appId: settings.square_app_id, appSecret: settings.square_app_secret, env: settings.square_env } : undefined;
  if (settings.square_refresh_token && !app) {
    console.warn("[gateway] SQUARE_REFRESH_TOKEN is set but SQUARE_APP_ID / SQUARE_APP_SECRET are not: the access token will not be refreshed and expires 30 days after it was issued");
  }
  const source = new SquareTokenSource({ accessToken: settings.square_access_token, refreshToken: settings.square_refresh_token, app });
  return new SquareConnector({
    accessToken: source.canRefresh ? () => source.get() : settings.square_access_token,
    locationId: settings.square_location_id,
    environment: settings.square_env,
    timezone: opts.timezone,
    timeoutMs: opts.timeoutMs,
  });
}
