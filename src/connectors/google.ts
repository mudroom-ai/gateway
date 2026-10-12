// Google Calendar connector. Service-account auth via a signed JWT
// (no googleapis dependency), plain fetch with a per-request timeout.
//
// - getBusy: freebusy.query, timeout (default 8 s), one jittered retry on
//   timeout / network / 429 / 5xx, then ConnectorError("calendar_unavailable").
// - insertEvent: client-chosen id; 409 -> "already_exists"; never retried in-request.
// - getEvent: 404/410 -> null.
// - checkAccess: startup check with a fix hint.

import { createSign } from "node:crypto";
import type { Interval } from "../types.js";
import { ConnectorError, type CalendarConnector, type CalendarEvent, type NewCalendarEvent } from "./types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GoogleConnectorOptions {
  /** Raw JSON of the service account key (GOOGLE_SERVICE_ACCOUNT_JSON). */
  serviceAccountJson: string;
  /** GOOGLE_CALENDAR_ID, e.g. the merchant's email or a calendar id. */
  calendarId: string;
  /** Per-request timeout (config limits.connector_timeout_ms). Default 8000. */
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

type HttpResult = { status: number; body: unknown; retryAfterS: number | undefined };

class TransportError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export function parseServiceAccountJson(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConnectorError("calendar_auth_failed", "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON", { cause: e });
  }
  const k = parsed as Partial<ServiceAccountKey>;
  if (typeof k?.client_email !== "string" || typeof k?.private_key !== "string") {
    throw new ConnectorError(
      "calendar_auth_failed",
      "GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key (download a JSON key for the service account)",
    );
  }
  return { client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class GoogleCalendarConnector implements CalendarConnector {
  private readonly key: ServiceAccountKey;
  private readonly calendarId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(opts: GoogleConnectorOptions) {
    this.key = parseServiceAccountJson(opts.serviceAccountJson);
    this.calendarId = opts.calendarId;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** The service account address the merchant must share the calendar with. */
  get clientEmail(): string {
    return this.key.client_email;
  }

  private get shareHint(): string {
    return `Share calendar "${this.calendarId}" with ${this.key.client_email} ("Make changes to events") and check GOOGLE_CALENDAR_ID.`;
  }

  // ---- auth ----

  private signJwt(): string {
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.key.client_email,
        scope: SCOPE,
        aud: this.key.token_uri ?? TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const input = `${header}.${claims}`;
    let sig: Buffer;
    try {
      sig = createSign("RSA-SHA256").update(input).sign(this.key.private_key);
    } catch (e) {
      throw new ConnectorError("calendar_auth_failed", "Service account private_key could not sign a JWT", { cause: e });
    }
    return `${input}.${b64url(sig)}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: this.signJwt(),
    });
    const res = await this.send(this.key.token_uri ?? TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ConnectorError("calendar_auth_failed", `Google rejected the service account key (${res.status}). Check GOOGLE_SERVICE_ACCOUNT_JSON.`);
    }
    if (res.status >= 300) throw this.unavailable(`token endpoint returned ${res.status}`, res.retryAfterS);
    const b = res.body as { access_token?: string; expires_in?: number };
    if (!b?.access_token) throw this.unavailable("token endpoint returned no access_token");
    this.token = { value: b.access_token, expiresAt: this.now() + (b.expires_in ?? 3600) * 1000 };
    return b.access_token;
  }

  // ---- transport ----

  /** One HTTP attempt with timeout. Throws TransportError on timeout/network failure. */
  private async send(url: string, init: RequestInit): Promise<HttpResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: ac.signal });
      const text = await res.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const ra = Number(res.headers.get("retry-after"));
      return { status: res.status, body, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined };
    } catch (e) {
      if (ac.signal.aborted) throw new TransportError(`timed out after ${this.timeoutMs} ms`, true, e);
      throw new TransportError(`network error: ${(e as Error)?.message ?? String(e)}`, false, e);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authenticated API call; maps transport errors to calendar_unavailable and 401/403 to calendar_auth_failed. */
  private async api(path: string, init: RequestInit = {}): Promise<HttpResult> {
    const token = await this.accessTokenMapped();
    let res: HttpResult;
    try {
      res = await this.send(`${API_BASE}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    } catch (e) {
      if (e instanceof TransportError) throw this.unavailable(e.message, undefined, e);
      throw e;
    }
    if (res.status === 401) this.token = undefined;
    if (res.status === 401 || res.status === 403) {
      // 403 can also be rateLimitExceeded; treat that as unavailable.
      if (isRateLimit(res.body)) throw this.unavailable(`Google rate limited (${res.status})`, res.retryAfterS);
      throw new ConnectorError("calendar_auth_failed", `Google Calendar denied access (${res.status}). ${this.shareHint}`);
    }
    return res;
  }

  private async accessTokenMapped(): Promise<string> {
    try {
      return await this.accessToken();
    } catch (e) {
      if (e instanceof TransportError) throw this.unavailable(`token request ${e.message}`, undefined, e);
      throw e;
    }
  }

  private unavailable(detail: string, retryAfterS?: number, cause?: unknown): ConnectorError {
    return new ConnectorError("calendar_unavailable", `Google Calendar unavailable: ${detail}`, {
      retry_after_s: retryAfterS ?? 5,
      cause,
    });
  }

  // ---- CalendarConnector ----

  async getBusy(range: Interval): Promise<Interval[]> {
    try {
      return await this.freebusyOnce(range);
    } catch (e) {
      if (!(e instanceof ConnectorError) || e.code !== "calendar_unavailable") throw e;
      // One jittered retry: 250-750 ms.
      await this.sleep(250 + Math.floor(this.random() * 500));
      return await this.freebusyOnce(range);
    }
  }

  private async freebusyOnce(range: Interval): Promise<Interval[]> {
    const res = await this.api("/freeBusy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeMin: range.start, timeMax: range.end, items: [{ id: this.calendarId }] }),
    });
    if (res.status === 429 || res.status >= 500) throw this.unavailable(`freebusy returned ${res.status}`, res.retryAfterS);
    if (res.status >= 300) throw this.unavailable(`freebusy returned ${res.status}`);
    const cal = (res.body as FreeBusyResponse)?.calendars?.[this.calendarId];
    if (!cal) throw this.unavailable("freebusy response missing calendar");
    if (cal.errors?.length) {
      const reasons = cal.errors.map((x) => x.reason).join(", ");
      if (cal.errors.some((x) => x.reason === "notFound" || x.reason === "forbidden")) {
        throw new ConnectorError("calendar_auth_failed", `Calendar not accessible (${reasons}). ${this.shareHint}`);
      }
      throw this.unavailable(`freebusy calendar error (${reasons})`);
    }
    return (cal.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }

  async insertEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    const res = await this.api(`/calendars/${enc(this.calendarId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: event.id,
        start: { dateTime: event.start },
        end: { dateTime: event.end },
        summary: event.title,
        description: event.description,
      }),
    });
    if (res.status === 409) {
      throw new ConnectorError("already_exists", `Calendar event ${event.id} already exists`);
    }
    if (res.status === 429 || res.status >= 500) throw this.unavailable(`events.insert returned ${res.status}`, res.retryAfterS);
    if (res.status >= 300) throw this.unavailable(`events.insert returned ${res.status}: ${errMessage(res.body)}`);
    return toEvent(res.body as GoogleEvent, event);
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    const res = await this.api(`/calendars/${enc(this.calendarId)}/events/${enc(id)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (res.status >= 300) throw this.unavailable(`events.get returned ${res.status}`, res.retryAfterS);
    const g = res.body as GoogleEvent;
    // A deleted event is still served, as status "cancelled". It is not on the calendar.
    if (g?.status === "cancelled") return null;
    return toEvent(g);
  }

  /** Delete an event by id (used by the setup wizard's write test). Missing events count as deleted. */
  async deleteEvent(id: string): Promise<void> {
    const res = await this.api(`/calendars/${enc(this.calendarId)}/events/${enc(id)}`, { method: "DELETE" });
    if (res.status === 404 || res.status === 410) return;
    if (res.status >= 300) throw this.unavailable(`events.delete returned ${res.status}: ${errMessage(res.body)}`, res.retryAfterS);
  }

  async checkAccess(): Promise<void> {
    let res: HttpResult;
    try {
      res = await this.api(`/calendars/${enc(this.calendarId)}`);
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "calendar_auth_failed") {
        throw new ConnectorError("calendar_auth_failed", e.message.includes(this.key.client_email) ? e.message : `${e.message} ${this.shareHint}`, { cause: e });
      }
      throw e;
    }
    if (res.status === 404) {
      throw new ConnectorError("calendar_auth_failed", `Calendar not found or not shared. ${this.shareHint}`);
    }
    if (res.status >= 300) throw this.unavailable(`calendars.get returned ${res.status}`, res.retryAfterS);
  }
}

// ---- helpers ----

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { domain?: string; reason: string }[] }>;
}

interface GoogleEvent {
  id?: string;
  /** "confirmed" | "tentative" | "cancelled"; Google keeps deleted events around as cancelled. */
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  summary?: string;
  description?: string;
}

const enc = encodeURIComponent;

function toEvent(g: GoogleEvent, fallback?: NewCalendarEvent): CalendarEvent {
  const ev: CalendarEvent = {
    id: g?.id ?? fallback?.id ?? "",
    start: g?.start?.dateTime ?? g?.start?.date ?? fallback?.start ?? "",
    end: g?.end?.dateTime ?? g?.end?.date ?? fallback?.end ?? "",
  };
  const title = g?.summary ?? fallback?.title;
  const description = g?.description ?? fallback?.description;
  if (title !== undefined) ev.title = title;
  if (description !== undefined) ev.description = description;
  return ev;
}

function errorReasons(body: unknown): string[] {
  const errs = (body as { error?: { errors?: { reason?: string }[] } })?.error?.errors ?? [];
  return errs.map((e) => e.reason ?? "");
}

function isRateLimit(body: unknown): boolean {
  return errorReasons(body).some((r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded");
}

function errMessage(body: unknown): string {
  return (body as { error?: { message?: string } })?.error?.message ?? "";
}

/** Build from runtime settings. Returns undefined when Google env vars are not set. */
export function createGoogleConnector(
  settings: { google_service_account_json: string | undefined; google_calendar_id: string | undefined },
  opts: { timeoutMs?: number } = {},
): GoogleCalendarConnector | undefined {
  if (!settings.google_service_account_json || !settings.google_calendar_id) return undefined;
  return new GoogleCalendarConnector({
    serviceAccountJson: settings.google_service_account_json,
    calendarId: settings.google_calendar_id,
    timeoutMs: opts.timeoutMs,
  });
}
