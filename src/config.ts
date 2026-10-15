// Owner config (file) + runtime env.
// Merchant data lives in a JSON file (CONFIG_PATH). Secrets and switches come
// from env vars only and are never written to the config file.

import { readFileSync } from "node:fs";
import { z } from "zod";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm (24h)");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const int = () => z.number().int();

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local time-of-day range, merchant zone, [start, end). */
export const TimeRangeSchema = z
  .object({ start: HHMM, end: HHMM })
  .refine((r) => r.start < r.end, { message: "start must be before end" });

export const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  duration_min: int().positive().max(24 * 60),
  buffer_min: int().nonnegative().default(0),
  price_cents: int().nonnegative(),
});

/**
 * One line of merchant text that is rendered into the markdown served to AI agents: no control or
 * format characters, no line breaks, no backticks, no angle brackets and no "](", the middle of a
 * markdown link or image. Length is in code points.
 */
const UNSAFE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}`<>]|\]\(/u;
const plainLine = (max: number) =>
  z
    .string()
    .refine((s) => [...s].length <= max, { message: `at most ${max} characters` })
    .refine((s) => !UNSAFE_LINE.test(s), { message: "one line of plain text: no control characters, backticks, angle brackets or markdown links" });

/** Offered but not bookable online (no fixed price or duration): agents see it and message the owner about it. */
export const AskServiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/, "lowercase letters, digits and hyphens, 1 to 64 characters"),
  name: plainLine(80).refine((s) => s.trim().length > 0, { message: "must not be empty" }),
  price_note: plainLine(60).optional(),
});

/** Every condition is optional; all present conditions must hold. Merchant-local. */
export const DiscountSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  pct: z.number().gt(0).max(100),
  days_of_week: z.array(WeekdaySchema).min(1).optional(),
  starts_within_hours: z.number().positive().optional(),
  time_of_day: TimeRangeSchema.optional(),
});

export const HoursSchema = z.object(
  Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(TimeRangeSchema).default([])])) as Record<
    (typeof WEEKDAYS)[number],
    z.ZodDefault<z.ZodArray<typeof TimeRangeSchema>>
  >,
);

export const LimitsSchema = z.object({
  max_window_days: int().positive().default(14),
  max_flexibility_min: int().nonnegative().default(240),
  connector_timeout_ms: int().positive().default(8000),
  /** Anonymous per-IP and keyed-agent request limits, per minute. */
  per_ip_per_min: int().positive().default(60),
  per_key_per_min: int().positive().default(600),
  /** Per customer contact (phone/email). */
  per_contact_per_hour: int().positive().default(10),
  max_open_bookings_per_contact: int().positive().default(3),
  /** leave_message + follow_up, merchant-wide: bounds what a flood of agents can push into the owner's channel. */
  max_messages_per_hour: int().positive().default(30),
  /** Open (not closed) message threads per customer contact. */
  max_open_threads_per_contact: int().positive().default(3),
  /** A thread the owner answered closes this long after the last owner reply when the agent sends nothing more. */
  thread_close_after_reply_hours: int().positive().default(24),
  /** A thread still waiting for the owner closes this long after the last agent message. */
  thread_close_unanswered_days: int().positive().default(7),
  /**
   * Longest hold for get_thread with wait (long-poll); a larger wait is clamped to it. 0 turns long-polling off.
   * At most 240: Railway's edge cuts a request at about 300 s, and agents' own curl gives up at 61-270 s.
   */
  thread_wait_max_seconds: int().min(0).max(240).default(25),
  /** Held get_thread requests across all threads; over it, a request answers at once and the agent falls back to plain polling. */
  max_waiting_requests: int().positive().default(200),
});

export const ConfigSchema = z.object({
  merchant_id: z.string().min(1).default("default"),
  name: z.string().min(1),
  timezone: z.string().refine(isIanaZone, { message: "must be an IANA time zone, e.g. America/Los_Angeles" }),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD"),
  /** Google mode needs at least one; in Square mode services come from the catalog and this may be empty. */
  services: z.array(ServiceSchema).default([]),
  /** Listed for agents with every booking system, never bookable; an id that is also a bookable service is ignored. */
  ask_services: z.array(AskServiceSchema).max(50).default([]),
  hours: HoursSchema,
  /** Padding applied to every busy interval from the calendar before slot search. */
  default_buffer_min: int().nonnegative().default(0),
  /** Merchant-local dates; no slot is offered on these days. */
  blackout_days: z.array(DATE).default([]),
  /** Applied in listed order. */
  discounts: z.array(DiscountSchema).default([]),
  /** Cap on total discount, measured against base price. */
  max_total_discount_pct: z.number().min(0).max(100).default(100),
  /** Price floor, applied last; the floor always wins. */
  floor_cents: int().nonnegative().default(0),
  quote_ttl_min: int().positive().default(15),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  /** Kill switch default; env BOOKING_ENABLED overrides. */
  booking_enabled: z.boolean().default(true),
  /** Public playground (src/demo/): live feed at /, "[demo]" events that cancel themselves, templated owner-away replies. Env DEMO_MODE overrides. */
  demo: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type AskServiceConfig = z.infer<typeof AskServiceSchema>;
export type DiscountConfig = z.infer<typeof DiscountSchema>;
export type Limits = z.infer<typeof LimitsSchema>;

const boolEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** Runtime settings and secrets, from env only. */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  /** Comma-separated hostnames allowed in the Host header (tunnel / public domain). */
  ALLOWED_HOSTS: z.string().optional(),
  CONFIG_PATH: z.string().default("config.json"),
  DB_PATH: z.string().default("gateway.sqlite"),
  BOOKING_ENABLED: boolEnv.optional(),
  /** Playground mode (see Config.demo); overrides the config's `demo`. */
  DEMO_MODE: boolEnv.optional(),
  /** Kill switch for leave_message / get_thread / follow_up. Default true whenever an owner channel is configured. */
  MESSAGES_ENABLED: boolEnv.optional(),
  /** Comma-separated optional bearer keys. */
  API_KEYS: z.string().optional(),
  /** Express "trust proxy": hop count, or comma list of proxy IPs/CIDRs/loopback/uniquelocal; "false" = none. */
  TRUST_PROXY: z.string().default("loopback"),
  /** Log how each anonymous caller's IP was resolved (to verify TRUST_PROXY). */
  TRUST_PROXY_DEBUG: boolEnv.optional(),
  /** Honor CF-Connecting-IP from trusted peers. Only safe when the trusted proxy is Cloudflare/cloudflared, which overwrites it. */
  TRUST_CF_CONNECTING_IP: boolEnv.optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Path to the key file; used when GOOGLE_SERVICE_ACCOUNT_JSON is unset. */
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  /** Square Appointments (buyer-level access token). When set, Square wins over Google. */
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  SQUARE_LOCATION_ID: z.string().optional(),
  /** From `npm run init` (Square OAuth). With the app id + secret the gateway refreshes the 30-day access token itself. */
  SQUARE_REFRESH_TOKEN: z.string().optional(),
  SQUARE_APP_ID: z.string().optional(),
  SQUARE_APP_SECRET: z.string().optional(),
  SQUARE_ENV: z
    .string()
    .default("production")
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(["sandbox", "production"])),
  /** GlossGenius shadow mode: the merchant's public booking page. Needs the GOOGLE_* vars too (bookings land there). */
  GLOSSGENIUS_BOOKING_URL: z.string().optional(),
  /** Slots closer than this many hours are never offered in GlossGenius mode. */
  GLOSSGENIUS_MIN_LEAD_HOURS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^\d+$/, "must be a whole number of hours, e.g. 48")
      .transform(Number)
      .pipe(z.number().int().positive("must be at least 1 hour"))
      .optional(),
  ),
  /** Owner channel (src/connectors/twilio.ts): texts the merchant about agent bookings with any booking system. All four or none. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  OWNER_PHONE: z.string().optional(),
  /** Slack owner channel (src/connectors/slack.ts): notices plus two-way threads over Socket Mode. The first three or none; Slack wins over Twilio. */
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_CHANNEL_ID: z.string().optional(),
  /** Comma-separated Slack user ids whose thread replies count as the owner's; unset = anyone in the channel. */
  SLACK_OWNER_USER_IDS: z.string().optional(),
  /** WhatsApp owner channel (src/connectors/whatsapp.ts): notices plus two-way replies over Meta's Cloud API webhook. The four plus OWNER_PHONE, or none. */
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** Optional approved template `name` or `name:lang` for messages outside the 24-hour window. */
  WHATSAPP_TEMPLATE: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface RuntimeSettings {
  port: number;
  host: string;
  allowed_hosts: string[];
  config_path: string;
  db_path: string;
  booking_enabled: boolean;
  messages_enabled: boolean;
  demo: boolean;
  api_keys: string[];
  trust_proxy: TrustProxy;
  trust_proxy_debug: boolean;
  trust_cf_connecting_ip: boolean;
  google_service_account_json: string | undefined;
  google_calendar_id: string | undefined;
  square_access_token: string | undefined;
  square_location_id: string | undefined;
  square_refresh_token: string | undefined;
  square_app_id: string | undefined;
  square_app_secret: string | undefined;
  square_env: "sandbox" | "production";
  glossgenius_booking_url: string | undefined;
  glossgenius_min_lead_hours: number;
  twilio_account_sid: string | undefined;
  twilio_auth_token: string | undefined;
  twilio_from: string | undefined;
  owner_phone: string | undefined;
  slack_bot_token: string | undefined;
  slack_app_token: string | undefined;
  slack_channel_id: string | undefined;
  slack_owner_user_ids: string[];
  whatsapp_access_token: string | undefined;
  whatsapp_phone_number_id: string | undefined;
  whatsapp_app_secret: string | undefined;
  whatsapp_verify_token: string | undefined;
  whatsapp_template: string | undefined;
}

const csv = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Express "trust proxy" value: false (none), a hop count, or proxy addresses/CIDRs/names. */
export type TrustProxy = false | number | string[];

export function parseTrustProxy(raw: string): TrustProxy {
  const v = raw.trim();
  if (/^(false|none|0)$/i.test(v)) return false;
  if (/^true$/i.test(v)) {
    throw new Error("TRUST_PROXY=true would trust a client-supplied X-Forwarded-For; set a hop count (e.g. 1) or the proxy's IP/CIDR");
  }
  if (/^\d+$/.test(v)) return Number(v);
  const list = csv(v);
  return list.length ? list : ["loopback"];
}

/** Parse and validate a config object. Throws a readable error on failure. */
export function parseConfig(raw: unknown): Config {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  const ids = new Set<string>();
  for (const s of r.data.services) {
    if (ids.has(s.id)) throw new Error(`Invalid config:\n  - services: duplicate id "${s.id}"`);
    ids.add(s.id);
  }
  const askIds = new Set<string>();
  for (const s of r.data.ask_services) {
    if (askIds.has(s.id)) throw new Error(`Invalid config:\n  - ask_services: duplicate id "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`Invalid config:\n  - ask_services: duplicate id "${s.id}" (already in services)`);
    askIds.add(s.id);
  }
  return r.data;
}

export function loadConfigFile(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Service account key contents: GOOGLE_SERVICE_ACCOUNT_JSON, else the file at
 * GOOGLE_SERVICE_ACCOUNT_FILE. JSON wins when both are set (with a warning).
 */
export function resolveServiceAccountJson(
  e: { GOOGLE_SERVICE_ACCOUNT_JSON?: string | undefined; GOOGLE_SERVICE_ACCOUNT_FILE?: string | undefined },
  warn: (msg: string) => void = console.warn,
): string | undefined {
  const json = e.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() ? e.GOOGLE_SERVICE_ACCOUNT_JSON : undefined;
  const file = e.GOOGLE_SERVICE_ACCOUNT_FILE?.trim() ? e.GOOGLE_SERVICE_ACCOUNT_FILE.trim() : undefined;
  if (json) {
    if (file) warn("[gateway] both GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SERVICE_ACCOUNT_FILE are set; using GOOGLE_SERVICE_ACCOUNT_JSON");
    return json;
  }
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_FILE: cannot read "${file}": ${(err as Error).message}`);
  }
}

export function loadEnv(env: NodeJS.ProcessEnv, config?: Config): RuntimeSettings {
  const e = EnvSchema.parse(env);
  return {
    port: e.PORT,
    host: e.HOST,
    allowed_hosts: csv(e.ALLOWED_HOSTS),
    config_path: e.CONFIG_PATH,
    db_path: e.DB_PATH,
    booking_enabled: e.BOOKING_ENABLED ?? config?.booking_enabled ?? true,
    messages_enabled: e.MESSAGES_ENABLED ?? true,
    demo: e.DEMO_MODE ?? config?.demo ?? false,
    api_keys: csv(e.API_KEYS),
    trust_proxy: parseTrustProxy(e.TRUST_PROXY),
    trust_proxy_debug: e.TRUST_PROXY_DEBUG ?? false,
    trust_cf_connecting_ip: e.TRUST_CF_CONNECTING_IP ?? false,
    // Read the key file only once the config is known (main() calls loadEnv twice).
    google_service_account_json: config ? resolveServiceAccountJson(e) : e.GOOGLE_SERVICE_ACCOUNT_JSON,
    google_calendar_id: e.GOOGLE_CALENDAR_ID,
    square_access_token: e.SQUARE_ACCESS_TOKEN,
    square_location_id: e.SQUARE_LOCATION_ID,
    square_refresh_token: e.SQUARE_REFRESH_TOKEN?.trim() || undefined,
    square_app_id: e.SQUARE_APP_ID?.trim() || undefined,
    square_app_secret: e.SQUARE_APP_SECRET?.trim() || undefined,
    square_env: e.SQUARE_ENV,
    glossgenius_booking_url: e.GLOSSGENIUS_BOOKING_URL?.trim() || undefined,
    glossgenius_min_lead_hours: e.GLOSSGENIUS_MIN_LEAD_HOURS ?? 48,
    twilio_account_sid: e.TWILIO_ACCOUNT_SID?.trim() || undefined,
    twilio_auth_token: e.TWILIO_AUTH_TOKEN?.trim() || undefined,
    twilio_from: e.TWILIO_FROM?.trim() || undefined,
    owner_phone: e.OWNER_PHONE?.trim() || undefined,
    slack_bot_token: e.SLACK_BOT_TOKEN?.trim() || undefined,
    slack_app_token: e.SLACK_APP_TOKEN?.trim() || undefined,
    slack_channel_id: e.SLACK_CHANNEL_ID?.trim() || undefined,
    slack_owner_user_ids: csv(e.SLACK_OWNER_USER_IDS),
    whatsapp_access_token: e.WHATSAPP_ACCESS_TOKEN?.trim() || undefined,
    whatsapp_phone_number_id: e.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined,
    whatsapp_app_secret: e.WHATSAPP_APP_SECRET?.trim() || undefined,
    whatsapp_verify_token: e.WHATSAPP_VERIFY_TOKEN?.trim() || undefined,
    whatsapp_template: e.WHATSAPP_TEMPLATE?.trim() || undefined,
  };
}
