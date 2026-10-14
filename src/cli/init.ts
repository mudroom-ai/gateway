// Setup wizard: `npm run init`. Writes config.json and .env (mode 0600), then
// checks access to the booking system: Google Calendar (service account),
// Square Appointments (OAuth in the browser, buyer-level scopes only) or
// GlossGenius in shadow mode (public booking page + Google Calendar). With any
// of them it can also set up the owner channel (src/cli/init-channel.ts): Slack,
// where agent messages arrive and the owner replies in the thread, or a Twilio
// text to the merchant about each agent booking, cancel and reschedule.
// Built-ins only, plus Luxon/Zod already in deps.
//
// Interactive by default. The first question asks whether to continue in the
// terminal or complete setup in a browser on this machine (src/cli/setup-mode.ts,
// src/cli/setup-server.ts). Either way a first run opens with a short introduction,
// offers to read the merchant's website and use what it finds as the default
// answers (src/cli/init-website.ts), asks what agents should do (GOAL_ITEMS) and
// which booking system is in use, shows that system's setup guide (SETUP_GUIDES),
// then connects it or stops there.
// `--non-interactive` reads answers from flags/env (see --help), for scripts and tests.
// `--web` skips the first question and opens the browser.

import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { DateTime, IANAZone } from "luxon";
import { AskServiceSchema, HoursSchema, parseConfig, type AskServiceConfig, type Config } from "../config.js";
import { base32hex } from "../book.js";
import { GlossGeniusConnector } from "../connectors/glossgenius.js";
import { GoogleCalendarConnector, parseServiceAccountJson } from "../connectors/google.js";
import { SquareConnector } from "../connectors/square.js";
import {
  DEFAULT_CALLBACK_PORT,
  SQUARE_SCOPES,
  authorizeUrl,
  callbackUrl,
  listLocations,
  newState,
  obtainToken,
  waitForCallback,
  type SquareEnv,
  type SquareLocation,
  type SquareTokens,
} from "../connectors/square-oauth.js";
import { ConnectorError, type CalendarConnector } from "../connectors/types.js";
import { maskPhone } from "../connectors/twilio.js";
import {
  SLACK_ENV_KEYS,
  askOwnerChannel,
  channelEnvLines,
  channelFromFlags,
  checkSlack,
  defaultSlackFactory,
  type OwnerSms,
  type SlackAnswer,
  type SlackCheckFactory,
} from "./init-channel.js";
import { docUrl, openBrowser, showGuide, type SetupGuide } from "./guide.js";
import { askWebsite, type WebsiteDeps } from "./init-website.js";
import { pick, style, type PickItem } from "./picker.js";
import { askSetupMode } from "./setup-mode.js";
import { startSetupServer, type WebSetup } from "./setup-server.js";
import { cleanLine } from "./profile.js";
import { collectWebSetup } from "./setup-flow.js";
import { isTimeZone, selectTerminalTimeZone, type TimeZoneSource } from "./time-zones.js";
import { readSecret } from "./secret.js";

export { READY_ITEMS } from "./guide.js";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Day = (typeof WEEKDAYS)[number];
const DEFAULT_HOURS = "mon-fri 09:00-17:00";
const SHARE_STEPS = [
  "Google Calendar on the web -> hover the calendar -> ⋮ -> Settings and sharing",
  "Share with specific people or groups -> Add people and groups -> paste the address above",
  'Permission: "Make changes to events" (not "See all event details")',
  "Settings and sharing -> Integrate calendar -> copy the Calendar ID",
];
/** Printed when the wizard ends with no booking system: what to get before running it again. */
export const GOOGLE_SETUP_STEPS = [
  "Enable the Google Calendar API in a Google Cloud project",
  "Create a service account and download a JSON key",
  'Share the calendar with the service account email ("Make changes to events") and copy the Calendar ID',
];

/** Printed before the first question of a first run (no saved config.json or .env). */
export const INTRO = [
  "Gateway",
  "Lets AI agents book with your business over plain HTTP.",
  "It sits in front of the calendar or booking system you already use.",
  "",
  "This wizard writes config.json and .env in this folder, then checks access.",
  "Credentials stay in .env on this machine.",
  "Have ready: a Google service account key, or a Square developer app (docs/connectors/).",
  "Press Enter to accept [defaults]. Ctrl+C to stop.",
];
/** The first question: what the merchant wants set up. The wizard then runs only the matching steps. */
export const GOAL_ITEMS: PickItem[] = [
  { emoji: "🕒", label: "Book appointments" },
  { emoji: "💬", label: "Book appointments and message me" },
];
export const GOAL_DESCRIPTION = [
  "  Book appointments: agents find times, quote, book, cancel and reschedule",
  "  ...and message me: agents also leave you a message you answer in Slack, or you get a text per booking",
];
const [GOAL_BOOK, GOAL_MESSAGE] = [0, 1];
/** Asked first when config.json or .env is already there: nothing saved is kept or dropped without the merchant choosing. */
export const EXISTING_ITEMS: PickItem[] = [
  { emoji: "👍", label: "Keep it as it is" },
  { emoji: "✏️", label: "Review and update" },
  { emoji: "🧹", label: "Start over" },
];
export const EXISTING_DESCRIPTION = [
  "  Keep it as it is: change nothing and exit",
  "  Review and update: go through the questions with your saved answers as the defaults",
  "  Start over: ignore the saved answers; config.json and .env are replaced when the wizard finishes",
];
const [EXISTING_KEEP, , EXISTING_RESET] = [0, 1, 2];

/** What a merchant needs before the wizard can connect each booking system (the owner channels: CHANNEL_GUIDES). */
export const SETUP_GUIDES = {
  google: (_port: number): SetupGuide => ({ label: "Google Calendar", doc: "google", steps: GOOGLE_SETUP_STEPS }),
  square: (port: number): SetupGuide => ({
    label: "Square Appointments",
    doc: "square",
    steps: [
      "Create an application at https://developer.squareup.com/console/en/apps",
      `On its OAuth page set the Redirect URL to ${callbackUrl(port)}`,
      "Copy the Application ID and Application secret",
    ],
  }),
  glossgenius: (_port: number): SetupGuide => ({
    label: "GlossGenius",
    doc: "glossgenius",
    steps: ["In GlossGenius: Online Booking -> Share booking link, and copy the https://<yourname>.glossgenius.com link", ...GOOGLE_SETUP_STEPS],
  }),
};
export type GuideKind = keyof typeof SETUP_GUIDES;
const GUIDE_KINDS: GuideKind[] = ["google", "square", "glossgenius"]; // same order as the Booking system picker
export const guideUrl = (kind: GuideKind) => docUrl(SETUP_GUIDES[kind](DEFAULT_CALLBACK_PORT).doc);

const HELP = `Usage: npm run init [-- options]

Writes config.json and .env in the current directory (or --dir), then checks
access to Google Calendar, Square Appointments or GlossGenius. config.json follows CONFIG_PATH
when it is set. An interactive run asks first whether to continue in the terminal or complete
setup in a browser on this machine; the questions and the files are the same either way.
A first run starts with a short introduction and offers to read
your website (Enter skips) so the later questions start from what it says. It then
asks what agents should do and which booking system you use, shows what that system
needs (with a link to its guide) and asks whether you are ready to connect; "Not yet"
writes the files and connects nothing. Run again on existing files, it offers their saved
answers as defaults and keeps everything it does not ask about; it first asks
whether to keep the setup as it is, review and update it, or start over.

Options (env fallback in brackets, used with --non-interactive):
  --non-interactive        Take answers from flags/env; never prompt
  --web                    Open the same questions in a browser on this machine.
                           Without this flag, an interactive run asks first whether
                           to continue in the terminal or complete setup in the browser
  --force                  Start over: overwrite an existing config.json / .env
  --dir <path>             Where to write the files (default: current directory)
  --website <url>          First run or "Start over" only: answers the website question, e.g. example.com.
                           The wizard reads a few public pages and offers what it finds (name, time zone,
                           currency, hours, services) as defaults you confirm. Ignored with --non-interactive
  --name <text>            Business or your name [GATEWAY_NAME]
  --timezone <iana>        e.g. America/Los_Angeles [GATEWAY_TIMEZONE] (default: this machine's)
  --currency <code>        ISO 4217, default USD [GATEWAY_CURRENCY]
  --service <spec>         "Name:duration_min:buffer_min:price", repeatable,
                           e.g. "Haircut:45:15:40.00" or "Intro call:30:0:0" (free)
                           [GATEWAY_SERVICES, ";"-separated]
  --hours <spec>           e.g. "mon-fri 09:00-17:00; sat 10:00-14:00" [GATEWAY_HOURS]
                           (default: "${DEFAULT_HOURS}")
  --google-key-file <path> Service account JSON key [GOOGLE_SERVICE_ACCOUNT_FILE]
  --calendar-id <id>       Google Calendar ID [GOOGLE_CALENDAR_ID]
  --no-backend             Write config and .env without a booking system; the gateway will not start until one is set
                           (alias: --skip-google)
  --write-test             Create and delete a test event to prove write access (Google)
  --square                 Use Square Appointments instead of Google. Interactive: runs the OAuth flow
                           in your browser. Non-interactive: takes SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
                           and optionally SQUARE_REFRESH_TOKEN, SQUARE_APP_ID, SQUARE_APP_SECRET from env
  --square-env <env>       sandbox or production [SQUARE_ENV] (default production)
  --glossgenius-url <url>  Use GlossGenius in shadow mode: your public booking page, e.g.
                           https://yourname.glossgenius.com [GLOSSGENIUS_BOOKING_URL]. Bookings land in
                           Google Calendar, so --google-key-file and --calendar-id are required too; no --service
  --slack-bot-token <t>    Owner channel (slack), any booking system: agent messages and booking notices
                           go to a Slack channel and the owner replies in the thread. Bot User OAuth
                           Token, xoxb-... [SLACK_BOT_TOKEN]
  --slack-app-token <t>    App-level token with connections:write, xapp-... [SLACK_APP_TOKEN]
  --slack-channel <id>     Channel ID the app is invited to, C... [SLACK_CHANNEL_ID]
  --slack-owner-ids <ids>  Optional comma-separated Slack user ids whose replies count as the owner's
                           [SLACK_OWNER_USER_IDS] (first three all or none; Slack wins over Twilio)
  --owner-phone <e164>     Owner SMS (twilio), any booking system: text this phone about each agent
                           booking, cancel and reschedule [OWNER_PHONE]
  --twilio-sid <sid>       Twilio Account SID for that SMS [TWILIO_ACCOUNT_SID]
  --twilio-token <token>   Twilio Auth Token [TWILIO_AUTH_TOKEN]
  --twilio-from <e164>     Twilio number the SMS comes from [TWILIO_FROM]
                           (all four or none; with none, no texts are sent and GlossGenius
                           bookings are only logged)
  --square-app-id <id>     Square application id [SQUARE_APP_ID]
  --callback-port <n>      Local port for the OAuth redirect (default ${DEFAULT_CALLBACK_PORT}); the app's
                           Redirect URL in the Square Developer Console must be http://localhost:<n>/callback
  --port <n>               Port shown in the next steps [PORT] (default 3000)
`;

// ---------- parsing helpers (exported for tests) ----------

export interface ServiceAnswer {
  name: string;
  duration_min: number;
  buffer_min: number;
  price_cents: number;
}

export function parsePriceCents(raw: string): number {
  const v = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error(`invalid price "${raw}" (use e.g. 40 or 39.50)`);
  return Math.round(Number(v) * 100);
}

export function parseIntIn(raw: string, what: string, min: number, max: number): number {
  const v = raw.trim();
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`invalid ${what} "${raw}" (whole number ${min}-${max})`);
  return Number(v);
}

export function parseServiceSpec(spec: string): ServiceAnswer {
  const parts = spec.split(":");
  if (parts.length !== 4 || !parts[0]?.trim()) throw new Error(`invalid service "${spec}" (expected Name:duration_min:buffer_min:price)`);
  return {
    name: parts[0].trim(),
    duration_min: parseIntIn(parts[1]!, "duration", 1, 1440),
    buffer_min: parseIntIn(parts[2]!, "buffer", 0, 1440),
    price_cents: parsePriceCents(parts[3]!),
  };
}

function parseDays(spec: string): Day[] {
  const out: Day[] = [];
  for (const part of spec.toLowerCase().split(",")) {
    const [a, b] = part.trim().split("-") as [string, string | undefined];
    const i = WEEKDAYS.indexOf(a as Day);
    const j = b === undefined ? i : WEEKDAYS.indexOf(b as Day);
    if (i < 0 || j < 0 || j < i) throw new Error(`invalid days "${part.trim()}" (use e.g. mon-fri or sat,sun)`);
    out.push(...WEEKDAYS.slice(i, j + 1));
  }
  return out;
}

/** "mon-fri 09:00-17:00; sat 10:00-14:00" -> config hours. Unlisted days are closed. */
export function parseHours(spec: string): Config["hours"] {
  const hours = Object.fromEntries(WEEKDAYS.map((d) => [d, [] as { start: string; end: string }[]])) as Config["hours"];
  for (const group of spec.split(";").map((g) => g.trim()).filter(Boolean)) {
    const m = /^(\S+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(group);
    if (!m) throw new Error(`invalid hours "${group}" (use e.g. "mon-fri 09:00-17:00")`);
    for (const d of parseDays(m[1]!)) hours[d].push({ start: m[2]!, end: m[3]! });
  }
  return hours;
}

/** Inverse of parseHours: consecutive days with identical ranges share a group, e.g. "mon-fri 09:00-17:00; sat 10:00-14:00". */
export function renderHours(hours: Config["hours"]): string {
  const key = (d: Day) => JSON.stringify((hours[d] ?? []).map((r) => [r.start, r.end]));
  const groups: string[] = [];
  for (let i = 0; i < WEEKDAYS.length; ) {
    let j = i;
    while (j + 1 < WEEKDAYS.length && key(WEEKDAYS[j + 1]!) === key(WEEKDAYS[i]!)) j++;
    const days = i === j ? WEEKDAYS[i]! : `${WEEKDAYS[i]}-${WEEKDAYS[j]}`;
    for (const r of hours[WEEKDAYS[i]!] ?? []) groups.push(`${days} ${r.start}-${r.end}`);
    i = j + 1;
  }
  return groups.join("; ");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";

export interface Answers {
  name: string;
  timezone: string;
  currency: string;
  services: ServiceAnswer[];
  hours: string;
  /** Services agents can read and message the owner about but not book. undefined = keep what is saved. */
  ask_services?: { name: string; price_note?: string | undefined }[] | undefined;
}

// The config schema's limits for ask_services (src/config.ts).
const ASK_SERVICES_MAX = 50;
const ASK_ID_MAX = 64;

/**
 * ask_services for config.json. An entry with an id (a saved one) keeps it; a new one gets
 * slug(name), capped and made unique. An entry whose id is now a bookable service id is dropped
 * (bookable wins, and parseConfig rejects an id in both lists), as is one the schema does not accept.
 */
function buildAskServices(entries: readonly { id?: string | undefined; name: string; price_note?: string | undefined }[], bookableIds: ReadonlySet<string>): AskServiceConfig[] {
  const out: AskServiceConfig[] = [];
  const used = new Set<string>();
  for (const e of entries) {
    if (out.length >= ASK_SERVICES_MAX) break;
    const base = e.id ?? slug(e.name).slice(0, ASK_ID_MAX).replace(/-+$/, "");
    if (bookableIds.has(base)) continue;
    let id = base;
    for (let n = 2; used.has(id) || bookableIds.has(id); n++) id = `${base.slice(0, ASK_ID_MAX - `-${n}`.length)}-${n}`;
    const withNote = AskServiceSchema.safeParse({ id, name: e.name, ...(e.price_note ? { price_note: e.price_note } : {}) });
    const entry = withNote.success ? withNote : AskServiceSchema.safeParse({ id, name: e.name });
    if (!entry.success) continue;
    used.add(id);
    out.push(entry.data);
  }
  return out;
}

/**
 * Build and validate config.json from answers.
 * First run: `base` is config.example.json; its demo blackout days, discounts and floor are cleared.
 * Resume (`saved` = the merchant's parsed config, also the base): only the answered fields change,
 * merchant_id stays (quotes and bookings are stored under it), and a service whose name is
 * unchanged keeps its id and other fields (e.g. description).
 * ask_services is always written: the answered list, else the saved one, else none (never the
 * base's on a first run), minus any entry whose id is now bookable.
 */
export function buildConfig(a: Answers, base: Record<string, unknown>, saved?: Config): Config {
  const old = saved?.services ?? [];
  const kept = a.services.map((s) => old.find((o) => o.name === s.name));
  const used = new Set(kept.flatMap((o) => (o ? [o.id] : [])));
  const services = a.services.map((s, i) => {
    const prev = kept[i];
    if (prev && kept.indexOf(prev) === i) return { ...prev, ...s, id: prev.id };
    let id = slug(s.name);
    for (let n = 2; used.has(id); n++) id = `${slug(s.name)}-${n}`;
    used.add(id);
    return { id, ...s };
  });
  const ask_services = buildAskServices(a.ask_services ?? saved?.ask_services ?? [], new Set(services.map((s) => s.id)));
  const answered = { name: a.name, timezone: a.timezone, currency: a.currency, services, ask_services, hours: parseHours(a.hours) };
  if (saved) return parseConfig({ ...base, merchant_id: saved.merchant_id, ...answered });
  return parseConfig({
    ...base,
    merchant_id: slug(a.name),
    ...answered,
    // The example's blackout days, discounts and floor belong to the demo groomer.
    blackout_days: [],
    discounts: [],
    floor_cents: 0,
  });
}

/** The files a resumed run starts from. Throws (the Invalid config text) when the config does not validate. */
export function loadExisting(dir: string, configPath: string): { config?: Config; env?: Record<string, string> } {
  const out: { config?: Config; env?: Record<string, string> } = {};
  if (existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`${configPath}: Invalid config:\n  - (root): ${(e as Error).message}\nFix the file, or pass --force to start over. Nothing was written.`);
    }
    try {
      out.config = parseConfig(raw);
    } catch (e) {
      throw new Error(`${configPath}: ${(e as Error).message}\nFix the file, or pass --force to start over. Nothing was written.`);
    }
  }
  const envPath = resolve(dir, ".env");
  if (existsSync(envPath)) {
    out.env = Object.fromEntries(Object.entries(parseEnv(readFileSync(envPath, "utf8"))).filter((e): e is [string, string] => e[1] !== undefined));
  }
  return out;
}

/**
 * Value for a .env line, quoted so "#" and spaces survive Node's parser: single quotes when the
 * value has no ', else double quotes (not when it holds a literal \\n, which Node expands there),
 * else backticks.
 */
export function envValue(v: string, key = "value"): string {
  if (/[\r\n]/.test(v)) throw new Error(`${key} in .env cannot contain newlines`);
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes("\\n")) return `"${v}"`;
  if (!v.includes("`")) return `\`${v}\``;
  throw new Error(`${key} cannot be written to .env: it contains ', " and \` together. Edit .env by hand.`);
}

/** Booking-system keys the wizard writes from its answers (plus PORT); on resume every other key is carried over. */
const BACKEND_KEYS = [
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_FILE",
  "GOOGLE_CALENDAR_ID",
  "SQUARE_ENV",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_REFRESH_TOKEN",
  "SQUARE_APP_ID",
  "SQUARE_APP_SECRET",
  "GLOSSGENIUS_BOOKING_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "OWNER_PHONE",
  ...SLACK_ENV_KEYS,
] as const;
const WIZARD_KEYS: readonly string[] = [...BACKEND_KEYS, "PORT"];
/**
 * Removed from the environment of a model CLI the website step runs (`npm run init` loads .env):
 * every booking-system and owner-channel key, plus the agents' bearer keys. Not WIZARD_KEYS,
 * which decides what a resume carries over in .env.
 */
export const CHILD_SECRET_KEYS: readonly string[] = [...BACKEND_KEYS, "API_KEYS"];

/** For the website step: true only when parseHours reads the spec and the config schema accepts the result. */
export const validHoursSpec = (spec: string): boolean => {
  try {
    return HoursSchema.safeParse(parseHours(spec)).success;
  } catch {
    return false;
  }
};

/** True when a saved .env already names a booking system. */
export const hasSavedBackend = (env: Record<string, string>) =>
  !!(env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) ||
  !!((env.GOOGLE_SERVICE_ACCOUNT_FILE || env.GOOGLE_SERVICE_ACCOUNT_JSON) && env.GOOGLE_CALENDAR_ID);

export type { OwnerSms, SlackAnswer } from "./init-channel.js";

export type Backend = (
  | { kind: "google"; keyFile: string; calendarId: string }
  | { kind: "glossgenius"; bookingUrl: string; keyFile: string; calendarId: string }
  | {
      kind: "square";
      env: SquareEnv;
      accessToken: string;
      locationId: string;
      refreshToken?: string | undefined;
      appId?: string | undefined;
      appSecret?: string | undefined;
    }
) & { owner?: OwnerSms | undefined; slack?: SlackAnswer | undefined };

/**
 * .env contents. Wizard-owned keys come from the answers; writing one backend drops the other
 * backend's keys (and GOOGLE_SERVICE_ACCOUNT_JSON). With no backend answered, a booking system
 * already in `carried` (the existing .env) is kept. Every other carried key follows as KEY=value;
 * the commented template lines appear only for keys not already set.
 */
export function buildEnvFile(backend: Backend | undefined, port: number, carried: Record<string, string> = {}): string {
  const lines = ["# Written by `npm run init`. `npm start` loads it (node --env-file-if-exists=.env).", "# Keep it private: it holds your booking system's credentials."];
  const kv = (k: string, v: string) => `${k}=${envValue(v, k)}`;
  if (!backend && hasSavedBackend(carried)) {
    for (const k of BACKEND_KEYS) if (carried[k] !== undefined) lines.push(kv(k, carried[k]));
  } else if (backend?.kind === "google") {
    lines.push(kv("GOOGLE_SERVICE_ACCOUNT_FILE", backend.keyFile), kv("GOOGLE_CALENDAR_ID", backend.calendarId));
  } else if (backend?.kind === "glossgenius") {
    lines.push(
      "# GlossGenius shadow mode: reads the booking page, writes agent bookings to Google Calendar.",
      kv("GLOSSGENIUS_BOOKING_URL", backend.bookingUrl),
      kv("GOOGLE_SERVICE_ACCOUNT_FILE", backend.keyFile),
      kv("GOOGLE_CALENDAR_ID", backend.calendarId),
    );
  } else if (backend?.kind === "square") {
    lines.push(`SQUARE_ENV=${backend.env}`, kv("SQUARE_ACCESS_TOKEN", backend.accessToken), kv("SQUARE_LOCATION_ID", backend.locationId));
    if (backend.refreshToken && backend.appId && backend.appSecret) {
      lines.push(
        "# With these three the gateway renews the 30-day access token by itself.",
        kv("SQUARE_REFRESH_TOKEN", backend.refreshToken),
        kv("SQUARE_APP_ID", backend.appId),
        kv("SQUARE_APP_SECRET", backend.appSecret),
      );
    } else {
      lines.push("# No refresh token: the access token expires 30 days after it was issued. Re-run `npm run init` to renew it.");
    }
  } else {
    lines.push(
      "# No booking system yet: the gateway refuses to start until one is set.",
      "# GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json",
      "# GOOGLE_CALENDAR_ID=owner@example.com",
      "# or run `npm run init -- --square` for Square Appointments.",
    );
  }
  if (backend) lines.push(...channelEnvLines(backend, kv, backend.kind === "glossgenius"));
  lines.push("", port === 3000 ? "# PORT=3000" : `PORT=${port}`);
  for (const [k, v] of Object.entries(carried)) if (!WIZARD_KEYS.includes(k)) lines.push(kv(k, v));
  if (carried.ALLOWED_HOSTS === undefined) {
    lines.push("# Behind a tunnel, list the public hostname(s), e.g. from cloudflared:", "# ALLOWED_HOSTS=<random-words>.trycloudflare.com,localhost,127.0.0.1");
  }
  if (carried.TRUST_PROXY === undefined) {
    lines.push(
      "# Which proxies may set the client IP. The default (loopback) is right for cloudflared",
      "# on this machine; behind Docker or a PaaS see docs/deploy.md:",
      "# TRUST_PROXY=loopback",
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- calendar checks ----------

export type InitConnector = CalendarConnector;
export type ConnectorFactory = (serviceAccountJson: string, calendarId: string) => InitConnector;

const defaultFactory: ConnectorFactory = (json, calendarId) => new GoogleCalendarConnector({ serviceAccountJson: json, calendarId });

/** Insert a short event 30+ days out with an id computed up front, then delete it. */
export async function writeTest(c: InitConnector, calendarId: string, timezone: string, now = DateTime.now()): Promise<{ ok: boolean; message: string }> {
  const start = now.setZone(timezone).plus({ days: 31 }).set({ hour: 3, minute: 0, second: 0, millisecond: 0 });
  const end = start.plus({ minutes: 5 });
  // Deterministic id (Google alphabet a-v0-9, so no "w" in the prefix): if the insert response is lost we can still delete it.
  const id = `init${base32hex(createHash("sha256").update(`${calendarId}\u0000${start.toISO()}`).digest()).slice(0, 26)}`;
  const when = start.toFormat("yyyy-MM-dd HH:mm ZZZZ");
  try {
    await c.insertEvent({ id, start: start.toISO()!, end: end.toISO()!, title: "gateway setup test (safe to delete)", description: "Created and deleted by npm run init." });
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "calendar_auth_failed") {
      return { ok: false, message: `Write test FAILED: the service account can read but not create events. Change its permission to "Make changes to events". (${e.message})` };
    }
    if (!(e instanceof ConnectorError && e.code === "already_exists")) {
      // The insert may still have landed (e.g. timeout); try to clean up below either way.
      const cleanup = await c.deleteEvent(id).then(
        () => "",
        () => ` If an event "gateway setup test" appears on ${when}, delete it.`,
      );
      return { ok: false, message: `Write test FAILED: ${(e as Error).message}.${cleanup}` };
    }
  }
  try {
    await c.deleteEvent(id);
  } catch (e) {
    return { ok: false, message: `Write test created the test event but could NOT delete it (${(e as Error).message}). Delete "gateway setup test" on ${when} by hand.` };
  }
  return { ok: true, message: "Write test passed: created and deleted a test event." };
}

// ---------- Square OAuth ----------

/** The parts of the browser flow a test replaces. */
export interface SquareOAuth {
  waitForCallback: typeof waitForCallback;
  obtainToken: typeof obtainToken;
  listLocations: typeof listLocations;
  /** Open the URL in the user's browser; best effort. */
  open: (url: string) => void;
}

const defaultOAuth: SquareOAuth = { waitForCallback, obtainToken, listLocations, open: openBrowser };

export type GlossGeniusCheckFactory = (opts: { bookingUrl: string; calendar: CalendarConnector; timezone: string }) => Pick<GlossGeniusConnector, "checkAccess" | "listServices">;
const defaultGlossGeniusFactory: GlossGeniusCheckFactory = (o) => new GlossGeniusConnector(o);

export type SquareCheckFactory = (opts: { accessToken: string; locationId: string; environment: SquareEnv; timezone: string }) => Pick<SquareConnector, "checkAccess" | "listServices">;
const defaultSquareFactory: SquareCheckFactory = (o) => new SquareConnector(o);

/** Run the OAuth dance: listener up, link out, code in, tokens back. */
export async function squareAuthorize(app: { appId: string; appSecret: string; env: SquareEnv }, port: number, oauth: SquareOAuth, log: (m: string) => void): Promise<SquareTokens> {
  const state = newState();
  const url = authorizeUrl(app, state);
  const pending = oauth.waitForCallback(port, state);
  pending.catch(() => {}); // surfaced below
  if (app.env === "sandbox") {
    log("\nSandbox: Square shows a blank page unless the seller test account is already open in this browser.");
    log("In the Developer Console go to Sandbox test accounts and click Open on the test account first, then use the link.");
  }
  log(`\nOpen this link, sign in as the Square seller and click Allow (asks for: ${SQUARE_SCOPES.join(", ")}):\n\n  ${url}\n`);
  log(`Waiting for Square to redirect to ${callbackUrl(port)} ...`);
  oauth.open(url);
  const code = await pending;
  return oauth.obtainToken(app, code, undefined);
}

// ---------- prompting ----------

export interface Prompter {
  /** `shown` replaces the default in the prompt (for secrets). */
  ask(q: string, def?: string, shown?: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  /** Pick one of `items`; resolves with its index. `def` is pre-selected and is the answer to Enter, and to ESC unless `cancel` names the row ESC answers with. */
  choose(q: string, items: PickItem[], def?: number, description?: string[], cancel?: number): Promise<number>;
  /** Masked input for a secret that is used once and not saved; "" when skipped (or when there is no terminal to hide it on). */
  secret(q: string): Promise<string>;
  timeZone?(suggested: string, source: TimeZoneSource): Promise<string>;
  close(): void;
}

// One readline interface per question: a long-lived one would echo and
// line-edit the raw keystrokes the picker reads between questions.
async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function ttyPrompter(): Prompter {
  return {
    async ask(q, def, shown) {
      const label = shown ?? def;
      const a = await question(`${style.question(q)}${label !== undefined && label !== "" ? ` ${style.dim(`[${label}]`)}` : ""}: `);
      return a || def || "";
    },
    async confirm(q) {
      return /^y(es)?$/i.test(await question(`${style.question(q)} ${style.dim("[y/N]")}: `));
    },
    async choose(q, items, def = 0, description, cancel) {
      const i = await pick(q, items, def, { description, cancel });
      // A question that ends in "?" is not given a colon as well.
      console.log(`${style.question(q)}${q.endsWith("?") ? "" : ":"} ${style.answer(`${items[i]!.emoji ? `${items[i]!.emoji} ` : ""}${items[i]!.label}`)}`);
      return i;
    },
    timeZone(suggested, source) { return selectTerminalTimeZone(this, suggested, source); },
    secret: (q) => readSecret(q),
    close() {},
  };
}

/** Ask until `parse` accepts the answer. Failures go to `log` so the browser page shows them too. */
async function askValid<T>(log: (m: string) => void, p: Prompter, q: string, def: string | undefined, parse: (s: string) => T, shown?: string): Promise<T> {
  for (;;) {
    const a = await p.ask(q, def, shown);
    try {
      return parse(a);
    } catch (e) {
      log(`  ${(e as Error).message}`);
    }
  }
}

export const nonEmpty = (what: string) => (s: string) => {
  if (!s.trim()) throw new Error(`${what} is required`);
  return s.trim();
};
export const validZone = (s: string) => {
  if (!IANAZone.isValidZone(s)) throw new Error(`"${s}" is not an IANA time zone (e.g. America/New_York)`);
  return s;
};
export const validSquareEnv = (s: string): SquareEnv => {
  const v = s.trim().toLowerCase();
  if (v !== "sandbox" && v !== "production") throw new Error(`"${s}" is not sandbox or production`);
  return v;
};
export const validCurrency = (s: string) => {
  const v = s.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw new Error(`"${s}" is not a 3-letter currency code`);
  return v;
};
/** A GlossGenius booking page: https://<name>.glossgenius.com (scheme optional). Returns the https URL. */
export const validGlossGeniusUrl = (s: string): string => {
  const v = s.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    throw new Error(`"${s}" is not a URL (expected https://yourname.glossgenius.com)`);
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".glossgenius.com") || host === "www.glossgenius.com") {
    throw new Error(`"${s}" is not a GlossGenius booking page (expected https://yourname.glossgenius.com)`);
  }
  return `https://${host}${u.pathname === "/" ? "" : u.pathname}`;
};
/** The booking page the website step found, as a default for the "Booking page URL" prompt; undefined unless it is a valid GlossGenius page. */
export const siteBookingUrl = (vendor: { kind: string; url?: string | undefined } | undefined): string | undefined => {
  if (vendor?.kind !== "glossgenius" || !vendor.url) return undefined;
  try {
    return validGlossGeniusUrl(vendor.url);
  } catch {
    return undefined;
  }
};

export const validKeyFile = (cwd: string) => (s: string) => {
  const path = resolve(cwd, s.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  parseServiceAccountJson(raw);
  return path;
};

// ---------- main flow ----------

export interface InitDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  makeConnector?: ConnectorFactory;
  makeSquare?: SquareCheckFactory;
  makeGlossGenius?: GlossGeniusCheckFactory;
  /** Slack startup check (tests inject a fake); default: the real connector. */
  makeSlack?: SlackCheckFactory;
  oauth?: SquareOAuth;
  log?: (msg: string) => void;
  /** Opens the setup guide when the merchant asks for it (tests observe the URL); default: the system browser. */
  openUrl?: (url: string) => void;
  /** Answers for the interactive wizard (tests); default: prompt on the terminal. */
  prompter?: Prompter;
  /** The website step's crawl, model detection and model call (tests script them); default: the real ones. */
  website?: WebsiteDeps | undefined;
  /** Browser setup (tests substitute a fake). Default: a page on 127.0.0.1. */
  startWebSetup?: (opts: { openUrl?: ((url: string) => void) | undefined; allowBack?: boolean }) => Promise<WebSetup>;
}

export async function runInit(argv: string[], deps: InitDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  let sink = deps.log ?? ((m: string) => console.log(m));
  const log = (m: string) => sink(m);
  const askChecked = <T>(p: Prompter, q: string, def: string | undefined, parse: (s: string) => T, shown?: string) => askValid(log, p, q, def, parse, shown);
  const makeConnector = deps.makeConnector ?? defaultFactory;
  const makeSquare = deps.makeSquare ?? defaultSquareFactory;
  const makeGlossGenius = deps.makeGlossGenius ?? defaultGlossGeniusFactory;
  const makeSlack = deps.makeSlack ?? defaultSlackFactory;
  const oauth = deps.oauth ?? defaultOAuth;
  const { values: f } = parseArgs({
    args: argv,
    options: {
      "non-interactive": { type: "boolean" },
      force: { type: "boolean" },
      dir: { type: "string" },
      website: { type: "string" },
      name: { type: "string" },
      timezone: { type: "string" },
      currency: { type: "string" },
      service: { type: "string", multiple: true },
      hours: { type: "string" },
      "google-key-file": { type: "string" },
      "calendar-id": { type: "string" },
      "no-backend": { type: "boolean" },
      "skip-google": { type: "boolean" }, // older spelling of --no-backend
      "write-test": { type: "boolean" },
      square: { type: "boolean" },
      "square-env": { type: "string" },
      "square-app-id": { type: "string" },
      "glossgenius-url": { type: "string" },
      "owner-phone": { type: "string" },
      "twilio-sid": { type: "string" },
      "twilio-token": { type: "string" },
      "twilio-from": { type: "string" },
      "slack-bot-token": { type: "string" },
      "slack-app-token": { type: "string" },
      "slack-channel": { type: "string" },
      "slack-owner-ids": { type: "string" },
      "callback-port": { type: "string" },
      port: { type: "string" },
      web: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (f.help) {
    log(HELP);
    return 0;
  }
  const dir = resolve(deps.cwd ?? process.cwd(), f.dir ?? ".");
  // Same file the server reads (CONFIG_PATH, which `npm run init` loads from .env).
  const configPath = resolve(dir, env.CONFIG_PATH ?? "config.json");
  const envPath = resolve(dir, ".env");
  if (env.CONFIG_PATH) log(`Using ${configPath} (CONFIG_PATH)`);
  let port = parseIntIn(f.port ?? env.PORT ?? "3000", "port", 1, 65535);
  const callbackPort = parseIntIn(f["callback-port"] ?? String(DEFAULT_CALLBACK_PORT), "callback port", 1, 65535);
  const example = JSON.parse(readFileSync(new URL("../../config.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Next steps, in the wizard's palette: numbered titles, commands in the answer colour, notes dim.
  const cmd = (c: string) => `       ${style.answer(c)}`;
  const note = (n: string) => `     ${style.dim(n)}`;
  const nextSteps = (steps: [title: string, ...lines: string[]][], footer?: string) =>
    ["", style.question("Next steps:"), ...steps.flatMap(([title, ...lines], i) => ["", `  ${i + 1}. ${title}`, ...lines]), ...(footer ? ["", style.dim(footer)] : [])].join("\n");
  // Canonical text for a connected gateway; install.sh prints a matching trailer when the wizard did not run.
  const startSteps = () =>
    nextSteps(
      [
        ["Go to your gateway folder", cmd(`cd ${dir}`)],
        [
          `Open a tunnel so Muse or Grok can reach it ${style.dim("(skip if you only call it locally)")}`,
          cmd(`cloudflared tunnel --url http://localhost:${port}`),
          note("install: brew install cloudflared, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"),
          note("ChatGPT and Claude.ai don't work through a tunnel; host the gateway on a real domain for them (docs/deploy.md)"),
          "     It prints https://<tunnel-host>.trycloudflare.com. Add that host to .env:",
          cmd("ALLOWED_HOSTS=<tunnel-host>.trycloudflare.com,localhost,127.0.0.1"),
        ],
        ["Start the gateway", cmd("npm start"), "     Check it locally:", cmd(`curl localhost:${port}/api/services`)],
        ["Point your agent at the entry page", cmd("https://<tunnel-host>.trycloudflare.com")],
      ],
      "Details: docs/deploy.md",
    );
  // Nothing connected: the gateway cannot start yet, so the steps are the system's setup, then this wizard again.
  const setupSteps = (g: SetupGuide) =>
    nextSteps(
      [
        ["Go to your gateway folder", cmd(`cd ${dir}`)],
        [`Set up ${g.label}`, ...g.steps.map((st, i) => `       ${String.fromCharCode(97 + i)}. ${st}`), note(`Guide: ${docUrl(g.doc)}`), note(`       (local copy: docs/connectors/${g.doc}.md)`)],
        [`Run the wizard again ${style.dim("(it keeps your answers; press Enter through them)")}`, cmd("npm run init")],
      ],
    );

  let answers: Answers;
  let backend: Backend | undefined;
  let doWriteTest = false;
  let p: Prompter | undefined;
  let webSession: WebSetup | undefined;
  const finish = async (code: number): Promise<number> => {
    if (!webSession) return code;
    log(code === 0 ? "\nSetup finished. Click Close in the browser, or press Enter here. Then close the tab." : "\nSetup stopped. Click Close in the browser, or press Enter here. Then close the tab.");
    webSession.markDone(code === 0);
    await webSession.waitForExit();
    await webSession.close();
    webSession = undefined;
    return code;
  };
  // Resume (interactive, no --force): the saved files are the starting point.
  let saved: Config | undefined;
  let savedEnv: Record<string, string> | undefined;
  let keptBackend = false;
  // The booking system picked interactively; when it is not connected yet the ending shows its guide.
  let planned: GuideKind | undefined;

  try {
    if (f["non-interactive"]) {
      const existing = [configPath, envPath].filter((x) => existsSync(x));
      if (existing.length && !f.force) throw new Error(`${existing.join(" and ")} already exist(s); pass --force to overwrite`);
      // No website step here: nothing read from a site reaches config.json without someone confirming it at a prompt.
      if (f.website !== undefined) log("Note: --website is ignored with --non-interactive.");
      if (f.web) log("Note: --web is ignored with --non-interactive.");
      const specs = f.service?.length ? f.service : (env.GATEWAY_SERVICES ?? "").split(";").filter((s) => s.trim());
      const ggUrl = f.square || f["no-backend"] || f["skip-google"] ? undefined : (f["glossgenius-url"] ?? env.GLOSSGENIUS_BOOKING_URL)?.trim() || undefined;
      if (!specs.length && !f.square && !ggUrl) throw new Error("at least one --service is required");
      answers = {
        name: nonEmpty("--name")(f.name ?? env.GATEWAY_NAME ?? ""),
        timezone: validZone(f.timezone ?? env.GATEWAY_TIMEZONE ?? localZone),
        currency: validCurrency(f.currency ?? env.GATEWAY_CURRENCY ?? "USD"),
        services: specs.map(parseServiceSpec),
        hours: f.hours ?? env.GATEWAY_HOURS ?? DEFAULT_HOURS,
      };
      const keyFile = f["google-key-file"] ?? env.GOOGLE_SERVICE_ACCOUNT_FILE;
      const calendarId = f["calendar-id"] ?? env.GOOGLE_CALENDAR_ID;
      if (f.square) {
        const accessToken = env.SQUARE_ACCESS_TOKEN?.trim();
        const locationId = env.SQUARE_LOCATION_ID?.trim();
        if (!accessToken || !locationId) throw new Error("--square without a terminal needs SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID in the environment (run the OAuth flow interactively to get them)");
        backend = {
          kind: "square",
          env: validSquareEnv(f["square-env"] ?? env.SQUARE_ENV ?? "production"),
          accessToken,
          locationId,
          refreshToken: env.SQUARE_REFRESH_TOKEN?.trim() || undefined,
          appId: (f["square-app-id"] ?? env.SQUARE_APP_ID)?.trim() || undefined,
          appSecret: env.SQUARE_APP_SECRET?.trim() || undefined,
        };
      } else if (ggUrl) {
        if (!keyFile || !calendarId) throw new Error("--glossgenius-url needs --google-key-file and --calendar-id: agent bookings are written to that Google Calendar");
        backend = {
          kind: "glossgenius",
          bookingUrl: validGlossGeniusUrl(ggUrl),
          keyFile: validKeyFile(dir)(keyFile),
          calendarId: calendarId.trim(),
        };
      } else if (!f["no-backend"] && !f["skip-google"] && (keyFile || calendarId)) {
        if (!keyFile || !calendarId) throw new Error("--google-key-file and --calendar-id go together (or pass --no-backend)");
        backend = { kind: "google", keyFile: validKeyFile(dir)(keyFile), calendarId: calendarId.trim() };
      }
      // The owner channel works with every booking system: Slack (three or none) and/or Twilio (four or none), from flags or env.
      const channels = channelFromFlags(f, env);
      if (backend) Object.assign(backend, channels);
      else if (channels.owner || channels.slack) log("Note: owner channel settings ignored: there is no booking system to report on.");
      doWriteTest = !!f["write-test"];
    } else {
      if (!deps.prompter && !f.web && !process.stdin.isTTY) throw new Error("no terminal to prompt on; run it in a terminal, pass --web, or pass --non-interactive (see --help)");
      if (!f.force) ({ config: saved, env: savedEnv } = loadExisting(dir, configPath));
      const known = (k: string) => env[k] ?? savedEnv?.[k];
      if (deps.prompter) {
        p = deps.prompter;
      } else if (f.web || (await askSetupMode(ttyPrompter())) === "web") {
        const session = await (deps.startWebSetup ?? ((opts) => startSetupServer(opts)))({ openUrl: deps.openUrl, allowBack: true });
        webSession = session;
        const terminal = sink;
        sink = (m: string) => {
          terminal(m);
          session.pushLog(m);
        };
        terminal(`\nOpening the setup page. Leave this terminal open until setup finishes.\n${session.url}\n`);
        p = session.prompter;
      } else {
        p = ttyPrompter();
      }
      if (webSession) {
        const result = await collectWebSetup(webSession, {
          flags: f, env, saved, savedEnv, dir, configPath, envPath, port, callbackPort, example, localZone,
          oauth, website: deps.website, openUrl: deps.openUrl, log,
        });
        saved = result.saved;
        savedEnv = result.savedEnv;
        if (!f.port && !env.PORT && savedEnv?.PORT) port = parseIntIn(savedEnv.PORT, "PORT in .env", 1, 65535);
        answers = result.answers;
        backend = result.backend;
        planned = result.planned;
        if (result.keep) {
          log("Kept your setup; nothing was changed.");
          if (hasSavedBackend(savedEnv ?? {})) log(startSteps());
          else log("No booking system is connected yet. Run `npm run init` to connect one.");
          return await finish(0);
        }
      } else {
        const ask = p;
        const found = [saved ? configPath : "", savedEnv ? envPath : ""].filter(Boolean);
        if (found.length) {
          // An existing setup: keep, review or start over. Keep is the default once a booking system is connected.
          log(`Found ${found.join(" and ")}.\n`);
          const connected = hasSavedBackend(savedEnv ?? {});
          const existing = await p.choose("Existing setup", EXISTING_ITEMS, connected ? EXISTING_KEEP : 1, EXISTING_DESCRIPTION);
          if (existing === EXISTING_KEEP) {
            if (savedEnv?.PORT && !f.port && !env.PORT) port = parseIntIn(savedEnv.PORT, "PORT in .env", 1, 65535);
            log("\nKept your setup; nothing was changed.");
            if (connected) log(startSteps());
            else log("No booking system is connected yet, so the gateway will not start. Run `npm run init` again and pick \"Review and update\" to connect one.");
            return await finish(0);
          }
          if (existing === EXISTING_RESET) saved = savedEnv = undefined;
          log("");
        }
        if (!f.port && !env.PORT && savedEnv?.PORT) port = parseIntIn(savedEnv.PORT, "PORT in .env", 1, 65535);
        // Optional first step of a first run (or "Start over"): what the merchant's website says. It only ever
        // supplies the lowest default of a question below; nothing from it is written without passing a prompt.
        let site: Awaited<ReturnType<typeof askWebsite>>;
        if (saved || savedEnv) {
          log("gateway setup. Press Enter to keep each saved answer.\n");
          if (f.website !== undefined) log('Note: --website is only used on a first run or after "Start over".\n');
        } else {
          log(`${style.question(INTRO[0]!)}\n${INTRO.slice(1).join("\n")}\n`);
          site = await askWebsite(p, { flag: f.website, given: { name: f.name, timezone: f.timezone, currency: f.currency, hours: f.hours }, env, log, validHours: validHoursSpec, secretKeys: CHILD_SECRET_KEYS, deps: deps.website });
          log("");
        }
        const channelKnown = !!((known("SLACK_BOT_TOKEN") && known("SLACK_APP_TOKEN") && known("SLACK_CHANNEL_ID")) || known("OWNER_PHONE"));
        const goal = await p.choose("What do you want agents to do?", GOAL_ITEMS, f["slack-bot-token"] || f["owner-phone"] || channelKnown ? GOAL_MESSAGE : GOAL_BOOK, GOAL_DESCRIPTION);
        log("");
        const configured = (yes: boolean) => (yes ? "configured" : "not configured");
        // Same rule as hasSavedBackend: a key given inline (GOOGLE_SERVICE_ACCOUNT_JSON, the Docker/PaaS form) counts.
        const googleKnown = !!((known("GOOGLE_SERVICE_ACCOUNT_FILE") || known("GOOGLE_SERVICE_ACCOUNT_JSON")) && known("GOOGLE_CALENDAR_ID"));
        const systemKnown = [googleKnown, !!(known("SQUARE_ACCESS_TOKEN") && known("SQUARE_LOCATION_ID")), !!(known("GLOSSGENIUS_BOOKING_URL") && googleKnown)];
        // The system the site itself books through sets the default only when nothing else has: no flag, nothing configured.
        const vendor = site?.vendor;
        const vendorLabel = vendor ? cleanLine(vendor.label, 40) : "";
        const systemFlagged = !!(f.square || f["glossgenius-url"] || f["google-key-file"] || f["calendar-id"]);
        const vendorSystem = !vendor || systemFlagged || systemKnown.some(Boolean) ? undefined : vendor.kind === "square" ? 1 : vendor.kind === "glossgenius" ? 2 : undefined;
        if (vendorSystem !== undefined) log(`Your site books through ${vendorLabel}, so it is selected below.\n`);
        else if (vendor && vendor.kind !== "square" && vendor.kind !== "glossgenius") {
          log(`Your site books through ${vendorLabel}, which Gateway cannot connect to yet. Agents can still book into a Google Calendar and message you.\n`);
        }
        const system = await p.choose(
          "Booking system",
          [
            { emoji: "📅", label: "Google Calendar", status: configured(systemKnown[0]!) },
            { emoji: "⬛", label: "Square Appointments", status: configured(systemKnown[1]!) },
            { emoji: "💅", label: "GlossGenius (shadow mode: reads your booking page, writes to Google Calendar)", status: configured(systemKnown[2]!) },
          ],
          f.square || savedEnv?.SQUARE_ACCESS_TOKEN ? 1 : f["glossgenius-url"] || savedEnv?.GLOSSGENIUS_BOOKING_URL ? 2 : (vendorSystem ?? 0),
          [
            "  Google Calendar: services and hours live in config.json",
            "  Square Appointments: services and hours come from Square",
            "  GlossGenius: services, prices and open times come from your booking page; you get a text per booking",
          ],
        );
        const useSquare = system === 1;
        const useGlossGenius = system === 2;
        planned = GUIDE_KINDS[system]!;
        // A system not set up yet: show what it needs, then ask whether to connect now. "Not yet" writes
        // the files without a booking system; the guide is opened in the browser only when asked for.
        const guided = !systemKnown[system];
        let notReady = !!(f["no-backend"] || f["skip-google"]);
        const guideIO = { env, log, openUrl: deps.openUrl };
        if (guided && !notReady) {
          notReady = !(await showGuide(p, SETUP_GUIDES[planned](callbackPort), guideIO));
          // "Finish later" does not end the wizard: say what the remaining questions are for.
          if (notReady) log("Nothing is connected for now. The next answers are saved, so `npm run init` starts from them next time.");
        }
        log("");
        const name = await askChecked(p, "Business or your name", f.name ?? saved?.name ?? site?.name, nonEmpty("Name"));
        const siteZone = (f.timezone ?? saved?.timezone) === undefined ? site?.timezone : undefined;
        if (siteZone && siteZone !== localZone) log(`Your site points to the time zone ${cleanLine(siteZone, 64)}; this machine is set to ${localZone}.`);
        // After a site was read, a default that is only this machine's zone is labelled as such: it follows the site's summary and could be taken for the site's.
        const zoneKnown = f.timezone ?? saved?.timezone ?? siteZone;
        const zoneSuggestion = zoneKnown && isTimeZone(zoneKnown) ? zoneKnown : localZone;
        if (zoneKnown && zoneSuggestion !== zoneKnown) log(`"${zoneKnown}" is not an IANA time zone (e.g. America/New_York). Choose another.`);
        const zoneSource: TimeZoneSource = zoneSuggestion !== zoneKnown ? "device" : f.timezone ? "provided" : saved?.timezone ? "saved" : siteZone ? "website" : "device";
        const timezone = p.timeZone ? validZone(await p.timeZone(zoneSuggestion, zoneSource)) :
          await askChecked(p, "Time zone", zoneSuggestion, validZone, zoneKnown === undefined && site ? `${localZone}, this machine's` : undefined);
        const currency = await askChecked(p, "Currency", f.currency ?? saved?.currency ?? site?.currency ?? "USD", validCurrency);
        // Square and GlossGenius set services, prices and hours themselves. Not ready, they are asked on the next
        // run, unless the website step found services or hours: those are asked about now, or the reading is lost.
        const store = useSquare || useGlossGenius;
        const siteCatalog = !!site && (site.bookable.length > 0 || site.ask.length > 0 || site.hours !== undefined);
        const platform = store || (notReady && !siteCatalog);
        // Buffer and price are explained once, at the first service that is asked about: not above a prompt left empty.
        let explained = false;
        const askService = async (sname: string, prev?: ServiceAnswer): Promise<ServiceAnswer> => {
          if (!explained) {
            log(style.dim("    Buffer after: minutes kept free once a booking ends (clean-up, travel, a breather) before the next one can start; 0 for none."));
            log(style.dim("    Price: 0 is a free service."));
            explained = true;
          }
          return {
            name: sname,
            duration_min: await askChecked(ask, "    Duration (minutes)", String(prev?.duration_min ?? 60), (s) => parseIntIn(s, "duration", 1, 1440)),
            buffer_min: await askChecked(ask, "    Buffer after (minutes)", String(prev?.buffer_min ?? 0), (s) => parseIntIn(s, "buffer", 0, 1440)),
            price_cents: await askChecked(ask, `    Price (${currency})`, prev ? (prev.price_cents / 100).toFixed(2) : "0", parsePriceCents),
          };
        };
        const services: ServiceAnswer[] = [];
        const savedServices = (saved?.services ?? []).map(({ name, duration_min, buffer_min, price_cents }) => ({ name, duration_min, buffer_min, price_cents }));
        // Fixed-price services from the site are offered like saved ones; there are none when anything is saved.
        // A price the page wrote in a currency ("US$40") is not offered once the merchant picked another: it goes to the ask list.
        const siteBookable = (site?.bookable ?? []).filter((b) => !b.price_currency || b.price_currency === currency);
        const siteAsk = [...(site?.ask ?? []), ...(site?.bookable ?? []).filter((b) => !siteBookable.includes(b)).map((b) => ({ name: b.name, price_note: undefined }))].slice(0, 50);
        const siteServices = siteBookable.map((b) => ({ name: b.name, duration_min: b.duration_min ?? 60, buffer_min: 0, price_cents: b.price_cents }));
        const prefilled = [...savedServices, ...siteServices];
        let askServices: Answers["ask_services"];
        // What the site lists with no single fixed price, so not bookable. One yes or no for all of them,
        // so every one is shown (50 at most): nothing is written that was not on screen.
        const offerAskServices = async (also: boolean) => {
          if (platform || !siteAsk.length) return;
          const shown = siteAsk.map((s) => `  - ${cleanLine(s.name, 80)}${s.price_note ? ` (${cleanLine(s.price_note, 60)})` : ""}`);
          log(`\nYour site ${also ? "also " : ""}lists ${siteAsk.length === 1 ? "a service" : `${siteAsk.length} services`} the wizard could not read one fixed price for:\n${shown.join("\n")}`);
          log(style.dim("As ask-the-owner services, agents can read them and message you about them, but cannot book them."));
          if (await ask.confirm("List them as ask-the-owner services?")) {
            askServices = siteAsk;
            if (goal === GOAL_BOOK && !channelKnown) {
              log('Note: with "Book appointments" alone, agents can only tell customers to contact you about these. Run `npm run init` again and pick "Book appointments and message me" to let them leave you a message.');
            }
          }
        };
        if (platform) {
          services.push(...savedServices); // Not asked here; a resume leaves them as they were.
          if (store && site && (site.bookable.length || site.ask.length)) {
            log(`${useSquare ? "Square" : "GlossGenius"} supplies your services, so the ones found on your site were not added.`);
          }
        } else {
          // With nothing to walk through first, what the site lists is shown before the empty "Service 1 name" prompt, not after it.
          if (!prefilled.length) await offerAskServices(false);
          log(style.dim("\nServices (what people can book: a haircut, a paid consult, a free intro call). Leave the name empty when done."));
          if (savedServices.length) log("Saved services come first: Enter keeps an answer, a new name renames the service, - removes it.");
          else if (siteServices.length) log("Services from your site come first: Enter keeps an answer, a new name renames the service, - removes it.");
          for (const prev of prefilled) {
            const sname = (await p.ask(`  Service ${services.length + 1} name`, prev.name)).trim();
            if (sname === "-") {
              log(`    Removed ${prev.name}.`);
              continue;
            }
            services.push(await askService(sname, prev));
          }
        }
        while (!platform) {
          const sname = await p.ask(`  Service ${services.length + 1} name`);
          if (!sname) {
            if (services.length || notReady) break; // nothing connected yet: the list can be filled in on the next run
            log("  Add at least one service.");
            continue;
          }
          services.push(await askService(sname));
        }
        if (prefilled.length) await offerAskServices(true);
        const hoursKept = f.hours ?? (saved ? renderHours(saved.hours) : undefined);
        let hours = hoursKept ?? DEFAULT_HOURS;
        if (!platform) {
          log('\nOpening hours, e.g. "mon-fri 09:00-17:00; sat 10:00-14:00". Unlisted days are closed.');
          // The site's hours are a default for this prompt only: where hours are not asked they are never written.
          hours = await askChecked(p, "Hours", hoursKept ?? site?.hours ?? DEFAULT_HOURS, (s) => {
            parseHours(s);
            return s;
          });
        }
        answers = { name, timezone, currency, services, hours, ask_services: askServices };
        if (notReady) {
          // Nothing to connect: a booking system already in .env is kept (buildEnvFile).
        } else if (useSquare) {
          if (!guided) {
            log(style.dim("\nSquare: create an application at https://developer.squareup.com/console/en/apps, and on its OAuth page set the"));
            log(style.dim(`Redirect URL to ${callbackUrl(callbackPort)} (Sandbox or Production, matching the environment below).`));
          } else log(style.dim("\nSquare: the Redirect URL goes on the Sandbox or Production tab, matching the environment below."));
          const sqEnv = await askChecked(p, "Square environment (sandbox or production)", f["square-env"] ?? known("SQUARE_ENV") ?? "production", validSquareEnv);
          const appId = await askChecked(p, "Application ID", f["square-app-id"] ?? known("SQUARE_APP_ID"), nonEmpty("Application ID"));
          const secretFromEnv = known("SQUARE_APP_SECRET")?.trim() || undefined;
          const appSecret = await askChecked(p, "Application secret", secretFromEnv, nonEmpty("Application secret"), secretFromEnv ? "from .env" : undefined);
          const tokens = await squareAuthorize({ appId, appSecret, env: sqEnv }, callbackPort, oauth, log);
          log("Square authorised.");
          const locations = await oauth.listLocations(sqEnv, tokens.accessToken);
          const active = locations.filter((l) => l.status !== "INACTIVE");
          if (!active.length) throw new Error("this Square account has no active locations");
          let loc: SquareLocation;
          if (active.length === 1) {
            loc = active[0]!;
            log(`Location: ${loc.name} (${loc.id})`);
          } else {
            log("");
            loc = active[await p.choose("Book at location", active.map((l) => ({ emoji: "📍", label: l.name, status: l.id + (l.timezone ? `, ${l.timezone}` : "") })))]!;
          }
          if (loc.timezone && loc.timezone !== timezone) log(`Note: Square has this location in ${loc.timezone}; the gateway will use ${timezone}.`);
          backend = { kind: "square", env: sqEnv, accessToken: tokens.accessToken, locationId: loc.id, refreshToken: tokens.refreshToken, appId, appSecret };
        } else if (useGlossGenius) {
          if (!guided) log(style.dim("\nGlossGenius: open GlossGenius -> Online Booking -> Share booking link, and copy the https://<yourname>.glossgenius.com link."));
          const bookingUrl = await askChecked(p, "Booking page URL", f["glossgenius-url"] ?? known("GLOSSGENIUS_BOOKING_URL") ?? siteBookingUrl(vendor), validGlossGeniusUrl);
          log(style.dim("\nAgent bookings are written to a Google Calendar you share with a service account (see docs/connectors/google.md)."));
          const keyFile = await askChecked(p, "Path to the service account JSON key", f["google-key-file"] ?? known("GOOGLE_SERVICE_ACCOUNT_FILE"), validKeyFile(dir));
          const calendarId = await askChecked(p, "Calendar ID", f["calendar-id"] ?? known("GOOGLE_CALENDAR_ID"), nonEmpty("Calendar ID"));
          backend = { kind: "glossgenius", bookingUrl, keyFile, calendarId };
        } else {
          log(style.dim("\nGoogle Calendar (service account key + shared calendar; see docs/connectors/google.md)."));
          const keyFile = await askChecked(p, "Path to the service account JSON key", f["google-key-file"] ?? known("GOOGLE_SERVICE_ACCOUNT_FILE"), validKeyFile(dir));
          const calendarId = await askChecked(p, "Calendar ID", f["calendar-id"] ?? known("GOOGLE_CALENDAR_ID"), nonEmpty("Calendar ID"));
          backend = { kind: "google", keyFile, calendarId };
        }
        // Owner channel (none, Slack or Twilio), for any booking system: src/cli/init-channel.ts.
        // Asked for the "message me" goal, and always for GlossGenius, whose bookings are otherwise only logged.
        if (backend && (goal === GOAL_MESSAGE || backend.kind === "glossgenius")) {
          Object.assign(backend, await askOwnerChannel(p, { known, flags: f, log, glossgenius: backend.kind === "glossgenius", askValid: askChecked, preferSlack: goal === GOAL_MESSAGE, guide: guideIO }));
        } else if (backend) {
          // Not asked: a channel already in .env stays as it is.
          try {
            Object.assign(backend, channelFromFlags(f, { ...savedEnv, ...env }));
          } catch (e) {
            log(`Note: owner channel settings in .env ignored: ${(e as Error).message}`);
          }
        }
      }
    }

    // Build both files before writing either, so a value .env cannot hold leaves both untouched.
    const config = saved ? buildConfig(answers, saved, saved) : buildConfig(answers, example);
    if (answers.ask_services) {
      // buildConfig leaves out an entry that shares its id with a bookable service; say so, since the merchant said yes to the whole list.
      const listed = new Set(config.ask_services.map((s) => s.name));
      const left = answers.ask_services.filter((s) => !listed.has(s.name)).map((s) => cleanLine(s.name, 80));
      if (left.length) log(`\nNot listed as ask-the-owner (a bookable service already has the same id, or config.json cannot hold the entry): ${left.join(", ")}.`);
    }
    const carried = savedEnv ?? {};
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const envText = buildEnvFile(backend, port, carried);
    writeFileSync(configPath, configText);
    writeFileSync(envPath, envText, { mode: 0o600 });
    chmodSync(envPath, 0o600); // mode only applies to new files
    log(`\nWrote ${configPath}\nWrote ${envPath} (mode 600)`);
    if (saved) {
      const ids = new Set(config.services.map((s) => s.id));
      const oldIds = new Set(saved.services.map((s) => s.id));
      if (saved.services.some((s) => !ids.has(s.id)) && config.services.some((s) => !oldIds.has(s.id))) {
        log("Renamed services get a new id; agents need to call list_services again.");
      }
    }
    keptBackend = !backend && hasSavedBackend(carried);
    if (backend?.slack) {
      log(`Slack owner channel on: agent messages and booking notices go to channel ${backend.slack.channelId}.`);
      if (backend.owner) log("Twilio is set too; the gateway uses Slack and ignores the TWILIO_* vars.");
      await checkSlack(backend.slack, makeSlack, log);
    } else if (backend?.owner) {
      log(`Owner SMS on: agent bookings, cancels and reschedules are texted to ${maskPhone(backend.owner.phone)} from ${backend.owner.from}.`);
    }

    if (keptBackend) {
      log("\nKept the booking system settings already in .env; `npm start` checks access when it starts.");
    } else if (!backend && planned) {
      log(`\n${SETUP_GUIDES[planned](callbackPort).label} is not connected yet, so the gateway will not start.`);
    } else if (!backend) {
      log("\nWARNING: no booking system configured. The gateway will not start until GOOGLE_SERVICE_ACCOUNT_FILE and");
      log("GOOGLE_CALENDAR_ID (or SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID, or GLOSSGENIUS_BOOKING_URL plus the Google pair)");
      log("are set in .env. Re-run `npm run init` to connect one.");
    } else if (backend.kind === "square") {
      const c = makeSquare({ accessToken: backend.accessToken, locationId: backend.locationId, environment: backend.env, timezone: answers.timezone });
      log(`\nChecking Square access (${backend.env}, location ${backend.locationId}) ...`);
      try {
        await c.checkAccess();
        const services = await c.listServices();
        log(`Square access OK. Bookable services: ${services.map((s) => `${s.name} (${s.duration_min} min)`).join(", ")}`);
      } catch (e) {
        log(`Square check FAILED: ${(e as Error).message}`);
        log("Fix it in Square (Appointments enabled, at least one bookable fixed-price service), then run `npm start`, which checks again.");
      }
    } else if (backend.kind === "glossgenius") {
      const json = readFileSync(backend.keyFile, "utf8");
      const email = parseServiceAccountJson(json).client_email;
      const c = makeGlossGenius({ bookingUrl: backend.bookingUrl, calendar: makeConnector(json, backend.calendarId), timezone: answers.timezone });
      log(`\nChecking the GlossGenius booking page ${backend.bookingUrl} and calendar "${backend.calendarId}" as ${email} ...`);
      try {
        await c.checkAccess();
        const services = await c.listServices();
        log(`GlossGenius access OK. Bookable services: ${services.map((s) => `${s.name} (${s.duration_min} min)`).join(", ") || "none with a fixed, visible price"}`);
      } catch (e) {
        const msg = (e as Error).message;
        log(`GlossGenius check FAILED: ${msg}`);
        if (!msg.startsWith("Could not read the GlossGenius booking page")) {
          log(`\nShare the calendar with: ${email}`);
          SHARE_STEPS.forEach((s, i) => log(`  ${i + 1}. ${s}`));
        }
        log("Then re-run `npm run init` (or just `npm start`, which checks again).");
      }
      if (!backend.owner && !backend.slack) log("No owner channel configured: agent bookings are logged, not sent to you (docs/connectors/slack.md, docs/connectors/twilio.md).");
    } else {
      const google = backend;
      const json = readFileSync(google.keyFile, "utf8");
      const email = parseServiceAccountJson(json).client_email;
      const c = makeConnector(json, google.calendarId);
      log(`\nChecking access to calendar "${google.calendarId}" as ${email} ...`);
      let readable = false;
      try {
        await c.checkAccess();
        readable = true;
        log("Read access OK.");
      } catch (e) {
        log(`Calendar check FAILED: ${(e as Error).message}`);
        log(`\nShare the calendar with: ${email}`);
        SHARE_STEPS.forEach((s, i) => log(`  ${i + 1}. ${s}`));
        log("Then re-run `npm run init` (or just `npm start`, which checks again).");
      }
      if (readable) {
        if (p) {
          log("\nOptional write test: creates a 5-minute event about 31 days out and deletes it at once.");
          doWriteTest = await p.confirm("Run the write test?");
        }
        if (doWriteTest) {
          const r = await writeTest(c, google.calendarId, answers.timezone);
          log(r.message);
        } else {
          log("Skipped the write test. Read access does not prove the share allows \"Make changes to events\".");
        }
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code === "ABORT_ERR") {
      log("\nAborted.");
      return await finish(1);
    }
    log(`error: ${(e as Error).message}`);
    return await finish(1);
  } finally {
    p?.close();
  }

  if (!backend && !keptBackend) {
    // --non-interactive --no-backend names no system: point at Google, the one that needs nothing but a calendar.
    log(setupSteps(SETUP_GUIDES[planned ?? "google"](callbackPort)));
    return await finish(0);
  }

  log(startSteps());
  return await finish(0);
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  runInit(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
