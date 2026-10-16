// Browser-owned state and navigation. The CLI shares validators, serializers and
// connector operations with this flow, but its prompt loop never runs here.
import type { Config } from "../config.js";
import type { SquareLocation, SquareTokens } from "../connectors/square-oauth.js";
import {
  CHILD_SECRET_KEYS, GOAL_ITEMS, SETUP_GUIDES,
  buildConfig, buildEnvFile, changeSummary, existingItems, hasSavedBackend, nonEmpty, parseHours, parseIntIn, parsePriceCents, partItems, renderHours, savedSystem,
  siteBookingUrl, squareAuthorize, validCurrency, validGlossGeniusUrl, validHoursSpec, validKeyFile, validSquareEnv, validZone,
  type Answers, type Backend, type ExistingAction, type PartKey, type ServiceAnswer, type SquareOAuth,
} from "./init.js";
import { CHANNEL_GUIDES, channelFromFlags, ownerSms, slackAnswer, validWhatsappPhone, validWhatsappPhoneId, whatsappAnswer, type ChannelAnswers, type ChannelFlags } from "./init-channel.js";
import { READY_ITEMS, type SetupGuide } from "./guide.js";
import { WEBSITE_NOTES, type WebsiteDeps } from "./init-website.js";
import { buildProfile, detectLlm, extractWithLlm, keyCandidate, type LlmCandidate, type SiteProfile } from "./profile.js";
import { crawlSite, normalizeWebsiteUrl, type CrawlResult } from "./website.js";
import { SetupBackError, type WebSetup, type SetupNote } from "./setup-server.js";
import { zoneOption, isTimeZone } from "./time-zones.js";
import { connectionNotes } from "./setup-copy.js";
import type { PickItem } from "./picker.js";

type GuideKind = "google" | "square" | "glossgenius";
type Flags = ChannelFlags & Record<string, string | string[] | boolean | undefined>;
interface Context {
  flags: Flags;
  env: NodeJS.ProcessEnv;
  saved?: Config;
  savedEnv?: Record<string, string>;
  dir: string;
  configPath: string;
  envPath: string;
  port: number;
  callbackPort: number;
  example: Record<string, unknown>;
  localZone: string;
  oauth: SquareOAuth;
  website?: WebsiteDeps;
  openUrl?: (url: string) => void;
  log: (text: string) => void;
}
interface Result {
  answers: Answers;
  backend?: Backend;
  saved?: Config;
  savedEnv?: Record<string, string>;
  planned: GuideKind;
  keep?: boolean;
  /** "Change one part": the part picked, the parts that ran (it plus a part it needs) and the owner channel to write. */
  change?: PartKey;
  ran?: PartKey[];
  channel?: ChannelAnswers | "keep";
}
interface Step {
  key: string;
  interactive: boolean;
  notes: SetupNote[];
  run(): Promise<void>;
}
const kinds: GuideKind[] = ["google", "square", "glossgenius"];
/** Value keys the four parts answer (prefixes, as set() matches them). */
const PART_OWNED = ["system", "ready", "name", "timezone", "service-", "hours", "ask-services", "square-", "google-key", "calendar", "booking-url", "channel", "slack-", "twilio-", "whatsapp-", "owner-phone"];
const requireLine = (what: string) => (value: string) => {
  const result = nonEmpty(what)(value);
  if (/[\r\n\0]/.test(result)) throw new Error(`${what} must be one line.`);
  return result;
};
const prefix = (what: string, starts: string) => (value: string) => {
  const result = requireLine(what)(value);
  if (!result.startsWith(starts)) throw new Error(`${what} starts with ${starts}`);
  return result;
};

export async function collectWebSetup(session: WebSetup, ctx: Context): Promise<Result> {
  const p = session.prompter;
  const f = ctx.flags;
  const flag = (key: string) => typeof f[key] === "string" ? f[key] as string : undefined;
  const values = new Map<string, string | number | boolean>();
  const text = (key: string, fallback = "") => String(values.get(key) ?? fallback);
  const number = (key: string, fallback = 0) => Number(values.get(key) ?? fallback);
  const effects = new Map<string, Promise<unknown>>();
  async function effect<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (!effects.has(key)) effects.set(key, run().catch((error) => { effects.delete(key); throw error; }));
    return await effects.get(key) as T;
  }
  let crawl: CrawlResult | undefined;
  let crawlUrl = "";
  let site: SiteProfile | undefined;
  let candidates: LlmCandidate[] = [];
  let square: { key: string; tokens: SquareTokens; locations: SquareLocation[] } | undefined;
  let position = 0;
  let error = "";
  let completed: Result | undefined;
  let reportedWebsite: string | undefined;

  function set(key: string, value: string | number | boolean) {
    if (values.get(key) !== value) {
      const remove = (prefixes: string[]) => { for (const name of values.keys()) if (prefixes.some((prefix) => name.startsWith(prefix))) values.delete(name); };
      if (key === "system") remove(["ready", "channel", "google-key", "calendar", "booking-url", "square-", "service-", "hours"]);
      if (key === "goal") remove(["channel"]);
      if (key === "channel") remove(["channel-ready", "slack-", "twilio-", "whatsapp-", "owner-phone"]);
      if (key === "provider") remove(["key-kind", "model-key", "profile-key"]);
      if (key === "key-kind") remove(["model-key", "profile-key"]);
      if (key === "website" || key === "existing") remove(["provider", "key-kind", "model-key", "profile-key", "service-", "hours"]);
      // Leaving or re-picking a part drops what it answered, so a part backed out of is never written.
      if (key === "part" || (key === "existing" && (values.get(key) === "part" || value === "part"))) remove(["part", ...PART_OWNED]);
      if (["square-id", "square-secret", "square-env"].includes(key)) values.delete("square-location");
    }
    values.set(key, value);
  }

  function buildSteps(): Step[] {
    const steps: Step[] = [];
    const add = (key: string, run: () => Promise<void>, notes: SetupNote[] = [], interactive = true) => steps.push({ key, run, notes, interactive });
    function ask<T>(key: string, question: string, def: string | undefined, parse: (value: string) => T, notes: SetupNote[] = [], secret = false) {
      add(key, async () => {
        const previous = values.has(key) ? text(key) : def;
        const answer = secret && !previous ? await p.secret(question) : await p.ask(question, previous, secret ? values.has(key) ? "Previously entered; leave blank to keep it" : "from .env" : undefined);
        set(key, parse(answer) as string | number | boolean);
      }, notes);
    }
    function choose(key: string, question: string, items: PickItem[], def = 0, descriptions?: string[], notes: SetupNote[] = [], cancel?: number) {
      add(key, async () => { set(key, await p.choose(question, items, Math.min(items.length - 1, number(key, def)), descriptions, cancel)); }, notes);
    }
    function ready(key: string, guide: SetupGuide) {
      const yes = { ...READY_ITEMS.yes, label: "Ready to connect" };
      const later = { ...READY_ITEMS.later, label: "Finish later" };
      const items = [yes, later];
      add(key, async () => {
        set(key, await p.choose("Ready to connect?", items, number(key)));
      }, connectionNotes(guide, ctx.callbackPort));
      return items[number(key)] === later;
    }
    const existing = !!(ctx.saved || ctx.savedEnv);
    const existingMenu = existingItems(!!ctx.saved);
    const action = (values.get("existing") as ExistingAction | undefined) ?? (hasSavedBackend(ctx.savedEnv ?? {}) ? "keep" : "review");
    if (existing) add("existing", async () => {
      set("existing", existingMenu.actions[await p.choose("Existing setup", existingMenu.items, existingMenu.actions.indexOf(action), existingMenu.description)]!);
    }, [`Found ${[ctx.saved && ctx.configPath, ctx.savedEnv && ctx.envPath].filter(Boolean).join(" and ")}.`]);
    const reset = existing && action === "reset";
    const saved = reset ? undefined : ctx.saved;
    const savedEnv = reset ? undefined : ctx.savedEnv;
    const known = (key: string) => ctx.env[key] ?? savedEnv?.[key];
    const planned = kinds[number("system")] ?? "google";
    const blank: Answers = { name: saved?.name ?? "", timezone: saved?.timezone ?? ctx.localZone, currency: saved?.currency ?? "USD", services: saved?.services ?? [], hours: saved ? renderHours(saved.hours) : "mon-fri 09:00-17:00" };
    if (existing && action === "keep") {
      add("keep", async () => { completed = { answers: blank, saved, savedEnv, planned, keep: true }; }, [], false);
      return steps;
    }
    // "Change one part": the part is stored by key, not index, because the menu depends on the saved setup.
    let change: PartKey | undefined;
    if (existing && action === "part" && saved) {
      const parts = partItems(saved, savedEnv ?? {});
      change = (values.get("part") as PartKey | undefined) ?? parts.keys[0]!;
      const current = change;
      add("part", async () => { set("part", parts.keys[await p.choose("What do you want to change?", parts.items, Math.max(0, parts.keys.indexOf(current)), parts.description)]!); });
    }
    const ran: PartKey[] = change ? [change] : [];
    // The full walk runs every part; "Change one part" only the picked one and a part it needs.
    const runs = (part: PartKey) => !change || ran.includes(part);

    let currentSite: SiteProfile | undefined;
    if (!saved && !savedEnv) {
      if (flag("website") === undefined) ask("website", "Your website (Enter to skip)", undefined, (value) => value ? normalizeWebsiteUrl(value).href : "",
        [{ text: "Use your website to suggest business details. Leave blank to skip." }, { text: "Credentials stay on this machine. Files are saved only when you finish." }]);
      const website = flag("website") ?? text("website");
      let url: URL | undefined;
      if (website) {
        try { url = normalizeWebsiteUrl(website); }
        catch (e) {
          if (reportedWebsite !== website) {
            reportedWebsite = website;
            ctx.log(`--website: ${(e as Error).message} ${WEBSITE_NOTES.carryOn}`);
          }
        }
      }
      if (url) {
        const siteUrl = url;
        add("crawl", async () => {
          crawlUrl = siteUrl.href;
          try {
            crawl = await effect(`crawl:${siteUrl.href}`, () => (ctx.website?.crawl ?? crawlSite)(siteUrl));
            try { candidates = (ctx.website?.detect ?? detectLlm)(ctx.env); } catch { candidates = []; }
          } catch {
            crawl = undefined;
            candidates = [];
          }
        }, [`Reading ${siteUrl.hostname}…`], false);
        if (crawl && crawlUrl === siteUrl.href) {
          currentSite = { ...(crawl.vendor ? { vendor: crawl.vendor } : {}), bookable: [], ask: [], products: [], shop: false };
          if (crawl.pages.some((page) => page.text.trim()) || crawl.jsonLd.length) {
            const skip = candidates.length + 1;
            const store = crawl.vendor?.kind === "square" || crawl.vendor?.kind === "glossgenius";
            choose("provider", "Read the pages with", [...candidates.map((c) => ({ label: c.label, status: c.status })), { label: "Paste an API key" }, { label: "Skip" }], candidates.length && !store ? 0 : skip, undefined,
              [{ text: "Your public page text goes to the selected provider. You can edit its suggestions." }], skip);
            const provider = number("provider", candidates.length && !store ? 0 : skip);
            if (provider !== skip) {
              if (provider === candidates.length) {
                choose("key-kind", "API key from", [{ label: "Anthropic" }, { label: "OpenAI" }, { label: "DeepSeek" }]);
                const kind = (["anthropic", "openai", "deepseek"] as const)[number("key-kind")]!;
                ask("model-key", `${kind === "openai" ? "OpenAI" : kind === "deepseek" ? "DeepSeek" : "Anthropic"} API key (hidden; Enter to skip)`, undefined, (s) => s, ["Used for this request only. Never logged or saved."], true);
              }
              const candidate = candidates[provider] ?? (text("model-key") ? keyCandidate((["anthropic", "openai", "deepseek"] as const)[number("key-kind")]!, text("model-key")) : undefined);
              if (candidate) {
                const read = crawl;
                const key = JSON.stringify([candidate, read]);
                add("extract", async () => {
                  try {
                    const raw = await effect(`model:${key}`, () => (ctx.website?.extract ?? extractWithLlm)(candidate, read, { env: ctx.env, secretKeys: CHILD_SECRET_KEYS }));
                    site = buildProfile(read, raw, validHoursSpec);
                  } catch { site = undefined; }
                  values.set("profile-key", key);
                }, ["Reading the page text with your selected model…"], false);
                if (text("profile-key") === key && site) currentSite = site;
              }
            }
          }
        }
      }
    }
    const channelKnown = !!((known("SLACK_BOT_TOKEN") && known("SLACK_APP_TOKEN") && known("SLACK_CHANNEL_ID")) || known("OWNER_PHONE"));
    const goalDefault = flag("slack-bot-token") || flag("whatsapp-token") || flag("owner-phone") || channelKnown ? 1 : 0;
    if (!change) choose("goal", "What do you want agents to do?", GOAL_ITEMS, goalDefault, ["Book appointments: find times, quote, book, cancel and reschedule", "...and message me: add Slack or WhatsApp conversations, or SMS booking notices"]);
    const configured = [
      !!((known("GOOGLE_SERVICE_ACCOUNT_FILE") || known("GOOGLE_SERVICE_ACCOUNT_JSON")) && known("GOOGLE_CALENDAR_ID")),
      !!(known("SQUARE_ACCESS_TOKEN") && known("SQUARE_LOCATION_ID")), !!(known("GLOSSGENIUS_BOOKING_URL") && (known("GOOGLE_SERVICE_ACCOUNT_FILE") || known("GOOGLE_SERVICE_ACCOUNT_JSON")) && known("GOOGLE_CALENDAR_ID")),
    ];
    const vendor = currentSite?.vendor;
    const systemDefault = f.square || savedEnv?.SQUARE_ACCESS_TOKEN ? 1 : flag("glossgenius-url") || savedEnv?.GLOSSGENIUS_BOOKING_URL ? 2 :
      !configured.some(Boolean) && vendor?.kind === "square" ? 1 : !configured.some(Boolean) && vendor?.kind === "glossgenius" ? 2 : 0;
    if (runs("booking")) choose("system", "Booking system", [{ label: "Google Calendar" }, { label: "Square Appointments" }, { label: "GlossGenius" }].map((item, i) => ({ ...item, status: configured[i] ? "configured" : "not configured" })), systemDefault,
      ["Google Calendar: manage services and hours in config.json", "Square Appointments: use your Square services and hours", "GlossGenius: read your booking page; write bookings to Google Calendar"]);
    // Not changing the booking system: the saved one (Google when none is saved), nothing connected now.
    const system = runs("booking") ? number("system", systemDefault) : savedSystem(savedEnv ?? {}) ?? 0;
    const chosen = kinds[system]!;
    let notReady = runs("booking") ? !!(f["no-backend"] || f["skip-google"]) : !hasSavedBackend(savedEnv ?? {});
    if (runs("booking") && !configured[system] && !notReady) notReady = ready("ready", SETUP_GUIDES[chosen](ctx.callbackPort));
    // Connecting Google with no saved services, or GlossGenius: the part that needs runs too.
    if (change === "booking" && system === 0 && !notReady && !saved?.services.length) ran.push("services");
    if (change === "booking" && system === 2 && !notReady) ran.push("channel");
    if (runs("business")) ask("name", "Business or your name", flag("name") ?? saved?.name ?? currentSite?.name, nonEmpty("Name"));
    if (runs("business")) add("timezone", async () => {
      const suggested = text("timezone", flag("timezone") ?? saved?.timezone ?? currentSite?.timezone ?? ctx.localZone);
      const source = values.has("timezone") ? "selected" : flag("timezone") ? "provided" : saved?.timezone ? "saved" : currentSite?.timezone ? "website" : "device";
      const answer = p.timeZone ? await p.timeZone(suggested, source) : await p.ask("Time zone", suggested);
      values.set("timezone", validZone(answer));
    });
    // Prices carry no currency of their own, so "Change one part" never changes it (Review and update does).
    if (!change) ask("currency", "Currency", flag("currency") ?? saved?.currency ?? currentSite?.currency ?? "USD", validCurrency);
    const currency = change && saved ? saved.currency : text("currency", flag("currency") ?? saved?.currency ?? currentSite?.currency ?? "USD");
    const store = system !== 0;
    const platform = store || (!change && notReady && !(currentSite?.bookable.length || currentSite?.ask.length || currentSite?.hours));
    const bookable = (currentSite?.bookable ?? []).filter((s) => !s.price_currency || s.price_currency === currency);
    const askServices = [...(currentSite?.ask ?? []), ...(currentSite?.bookable ?? []).filter((s) => !bookable.includes(s)).map((s) => ({ name: s.name }))].slice(0, 50);
    const services: ServiceAnswer[] = [];
    let hours = (runs("services") ? flag("hours") : undefined) ?? (saved ? renderHours(saved.hours) : !platform ? currentSite?.hours : undefined) ?? "mon-fri 09:00-17:00";
    if (platform || !runs("services")) services.push(...(saved?.services ?? []));
    else {
      const prefilled: ServiceAnswer[] = saved?.services ?? bookable.map((s) => ({ name: s.name, duration_min: s.duration_min ?? 60, buffer_min: 0, price_cents: s.price_cents }));
      if (askServices.length) add("ask-services", async () => { values.set("ask-services", await p.confirm("List them as ask-the-owner services?", values.get("ask-services") === true)); }, [{ text: "These services require a conversation with you. Agents can ask about them, but can’t book them.", items: askServices.map((s) => ({ label: s.name })) }]);
      for (let i = 0; i <= prefilled.length + values.size; i++) {
        const old = prefilled[i];
        const key = `service-${i}`;
        ask(`${key}-name`, `  Service ${i + 1} name`, old?.name, (s) => { if (!s && !old && !services.length && !notReady) throw new Error("Add at least one service."); return s; },
          [{ text: old ? "Enter keeps this service. Type `-` to remove it." : "Leave blank when you’re done adding services." }]);
        const name = text(`${key}-name`, old?.name);
        if (!name) break;
        if (name === "-") continue;
        ask(`${key}-duration`, "    Duration (minutes)", String(old?.duration_min ?? 60), (s) => parseIntIn(s, "duration", 1, 1440));
        ask(`${key}-buffer`, "    Buffer after (minutes)", String(old?.buffer_min ?? 0), (s) => parseIntIn(s, "buffer", 0, 1440), [{ text: "Free time after each booking. Use `0` for none." }]);
        ask(`${key}-price`, `    Price (${currency})`, old ? (old.price_cents / 100).toFixed(2) : "0", (s) => { parsePriceCents(s); return s; }, ["Use 0 for a free service."]);
        services.push({ name, duration_min: number(`${key}-duration`, old?.duration_min ?? 60), buffer_min: number(`${key}-buffer`, old?.buffer_min ?? 0), price_cents: parsePriceCents(text(`${key}-price`, old ? (old.price_cents / 100).toFixed(2) : "0")) });
      }
      ask("hours", "Opening hours", flag("hours") ?? hours, (s) => { parseHours(s); if (!validHoursSpec(s)) throw new Error("Invalid opening hours. Use mon-fri 09:00-17:00; sat 10:00-14:00."); return s; }, [{ text: "Unlisted days are closed.", fields: [{ label: "Example", value: "`mon-fri 09:00-17:00; sat 10:00-14:00`" }] }]);
      hours = text("hours", flag("hours") ?? hours);
    }
    let backend: Backend | undefined;
    let channelAns: ChannelAnswers | undefined;
    if (!notReady && runs("booking")) {
      if (system === 1) {
        ask("square-env", "Square environment (sandbox or production)", flag("square-env") ?? known("SQUARE_ENV") ?? "production", validSquareEnv);
        ask("square-id", "Application ID", flag("square-app-id") ?? known("SQUARE_APP_ID"), requireLine("Application ID"), [{ text: "Copy this from your Square developer app." }]);
        ask("square-secret", "Application secret", known("SQUARE_APP_SECRET"), requireLine("Application secret"), [{ text: "Copy the secret from the same Square app and environment." }], true);
        const app = { appId: text("square-id"), appSecret: text("square-secret"), env: validSquareEnv(text("square-env", "production")) };
        const key = JSON.stringify(app);
        add("square-auth", async () => {
          const tokens = await effect(`authorize:${key}`, () => squareAuthorize(app, ctx.callbackPort, ctx.oauth, ctx.log));
          const locations = await effect(`locations:${key}`, () => ctx.oauth.listLocations(app.env, tokens.accessToken));
          const active = locations.filter((l) => l.status !== "INACTIVE");
          if (!active.length) throw new Error("This Square account has no active locations.");
          square = { key, tokens, locations: active };
        }, ["Authorize Mudroom in Square to choose a booking location."], false);
        if (square?.key === key) {
          if (square.locations.length > 1) choose("square-location", "Book at location", square.locations.map((l) => ({ label: l.name, status: l.id })));
          const location = square.locations[Math.min(square.locations.length - 1, number("square-location"))]!;
          backend = { kind: "square", env: app.env, accessToken: square.tokens.accessToken, refreshToken: square.tokens.refreshToken, locationId: location.id, appId: app.appId, appSecret: app.appSecret };
        }
      } else {
        if (system === 2) ask("booking-url", "Booking page URL", flag("glossgenius-url") ?? known("GLOSSGENIUS_BOOKING_URL") ?? siteBookingUrl(vendor), validGlossGeniusUrl, [{ text: "GlossGenius → Online Booking → Share booking link." }]);
        ask("google-key", "Path to the service account JSON key", flag("google-key-file") ?? known("GOOGLE_SERVICE_ACCOUNT_FILE"), validKeyFile(ctx.dir), [{ text: "Enter the path to your downloaded JSON key. The file stays on this machine." }]);
        ask("calendar", "Calendar ID", flag("calendar-id") ?? known("GOOGLE_CALENDAR_ID"), requireLine("Calendar ID"), [{ text: "Google Calendar → Settings → Integrate calendar → Calendar ID." }]);
        backend = system === 2 ? { kind: "glossgenius", bookingUrl: text("booking-url"), keyFile: text("google-key"), calendarId: text("calendar") } : { kind: "google", keyFile: text("google-key"), calendarId: text("calendar") };
      }
    }
    if (change ? runs("channel") : !notReady && (number("goal", goalDefault) === 1 || system === 2)) {
      const slackKnown = !!(known("SLACK_BOT_TOKEN") && known("SLACK_APP_TOKEN") && known("SLACK_CHANNEL_ID"));
      const whatsappKnown = !!(known("WHATSAPP_ACCESS_TOKEN") && known("WHATSAPP_PHONE_NUMBER_ID") && known("WHATSAPP_APP_SECRET") && known("OWNER_PHONE"));
      const twilioKnown = !!(known("OWNER_PHONE") && known("TWILIO_ACCOUNT_SID"));
      const channelDefault = flag("slack-bot-token") || slackKnown ? 1 : flag("whatsapp-token") || whatsappKnown ? 3 : flag("owner-phone") || twilioKnown ? 2 : change || number("goal", goalDefault) === 1 ? 1 : 0;
      choose("channel", "Owner channel", [{ label: "None" }, { label: "Slack" }, { label: "Twilio SMS" }, { label: "WhatsApp" }], channelDefault, ["None: log messages and booking notices", "Slack: reply to agent messages in a channel", "Twilio SMS: get booking notices by text", "WhatsApp: reply to agent messages on your phone"]);
      const channel = number("channel", channelDefault);
      if (values.has("channel") && channel === 0) channelAns = {};
      let channelLater = false;
      if (channel === 1 && !slackKnown) channelLater = ready("channel-ready", CHANNEL_GUIDES.slack);
      if (channel === 2 && !twilioKnown) channelLater = ready("channel-ready", CHANNEL_GUIDES.twilio);
      if (channel === 3 && !whatsappKnown) channelLater = ready("channel-ready", CHANNEL_GUIDES.whatsapp);
      if (!channelLater && channel === 1) {
        ask("slack-bot", "Bot User OAuth Token (xoxb-...)", flag("slack-bot-token") ?? known("SLACK_BOT_TOKEN"), prefix("Bot token", "xoxb-"), [{ text: "Bot token from your installed Slack app. Starts with `xoxb-`." }], true);
        ask("slack-app", "App-level token (xapp-...)", flag("slack-app-token") ?? known("SLACK_APP_TOKEN"), prefix("App token", "xapp-"), [{ text: "App-level token with `connections:write`. Starts with `xapp-`." }], true);
        ask("slack-channel", "Channel ID (C...)", flag("slack-channel") ?? known("SLACK_CHANNEL_ID"), requireLine("Channel ID"), [{ text: "Copy the ID from your Slack channel details." }]);
        ask("slack-owners", "Owner Slack user IDs, comma-separated (Enter = anyone in the channel)", flag("slack-owner-ids") ?? known("SLACK_OWNER_USER_IDS"), (s) => s, [{ text: "Separate IDs with commas. Leave blank to allow anyone in the channel." }]);
        if (values.has("slack-owners")) channelAns = { slack: slackAnswer({ bot: text("slack-bot"), app: text("slack-app"), channel: text("slack-channel"), owners: text("slack-owners") }) };
      } else if (!channelLater && channel === 2) {
        ask("owner-phone", "Owner mobile number (e.g. +1 202 555 0199)", flag("owner-phone") ?? known("OWNER_PHONE"), requireLine("Phone"));
        ask("twilio-sid", "Twilio Account SID", flag("twilio-sid") ?? known("TWILIO_ACCOUNT_SID"), requireLine("Account SID"));
        ask("twilio-token", "Twilio Auth Token", flag("twilio-token") ?? known("TWILIO_AUTH_TOKEN"), requireLine("Auth Token"), [], true);
        ask("twilio-from", "Twilio phone number to send from", flag("twilio-from") ?? known("TWILIO_FROM"), requireLine("Twilio number"));
        if (values.has("twilio-from")) channelAns = { owner: ownerSms({ phone: text("owner-phone"), sid: text("twilio-sid"), token: text("twilio-token"), from: text("twilio-from") }) };
      } else if (!channelLater && channel === 3) {
        ask("owner-phone", "Your WhatsApp number (e.g. +1 202 555 0199)", flag("owner-phone") ?? known("OWNER_PHONE"), validWhatsappPhone);
        ask("whatsapp-phone-id", "Phone number ID", flag("whatsapp-phone-id") ?? known("WHATSAPP_PHONE_NUMBER_ID"), validWhatsappPhoneId, [{ text: "WhatsApp → API Setup. A number, not the phone number itself. One or more, comma-separated, for one chat per customer." }]);
        ask("whatsapp-token", "Access token", flag("whatsapp-token") ?? known("WHATSAPP_ACCESS_TOKEN"), requireLine("Access token"), [{ text: "From WhatsApp → API Setup (24-hour test token) or a System User token (permanent)." }], true);
        ask("whatsapp-app-secret", "App Secret", flag("whatsapp-app-secret") ?? known("WHATSAPP_APP_SECRET"), requireLine("App Secret"), [{ text: "App settings → Basic → App Secret. It signs each webhook delivery." }], true);
        ask("whatsapp-template", "Approved template for messages outside the 24-hour window, name or name:lang (Enter = none)", flag("whatsapp-template") ?? known("WHATSAPP_TEMPLATE"), (s) => s, [{ text: "Optional. Leave blank for the test number: just message it from your phone first." }]);
        if (values.has("whatsapp-template")) channelAns = { whatsapp: whatsappAnswer({ phone: text("owner-phone"), phoneId: text("whatsapp-phone-id"), token: text("whatsapp-token"), secret: text("whatsapp-app-secret"), verify: flag("whatsapp-verify-token") ?? known("WHATSAPP_VERIFY_TOKEN"), template: text("whatsapp-template") }) };
      }
    } else if (!change && backend) {
      try { Object.assign(backend, channelFromFlags(f, { ...savedEnv, ...ctx.env })); } catch { /* Invalid saved channel settings are checked after saving. */ }
    }
    // The full walk's channel rides on the backend; "Change one part" writes it on its own ("keep" = as saved).
    if (!change && backend && channelAns) Object.assign(backend, channelAns);
    const channelOut: ChannelAnswers | "keep" = channelAns ?? "keep";
    const answers: Answers = {
      name: text("name", blank.name), timezone: text("timezone", blank.timezone), currency,
      services, hours, ...(!platform && values.get("ask-services") ? { ask_services: askServices } : {}),
    };
    const port = !flag("port") && !ctx.env.PORT && savedEnv?.PORT ? parseIntIn(savedEnv.PORT, "PORT in .env", 1, 65535) : ctx.port;
    const summary = change && saved ? changeSummary({ ran, saved, savedEnv: savedEnv ?? {}, answers, backend, channel: channelOut }) : undefined;
    add("save", async () => {
      const config = saved ? buildConfig(answers, saved, saved) : buildConfig(answers, ctx.example);
      // Validate both artifacts before the save choice.
      if (change) buildEnvFile(ran.includes("booking") ? backend ?? "keep" : "keep", port, savedEnv ?? {}, channelOut);
      else buildEnvFile(backend, port, savedEnv ?? {});
      const choice = await p.choose("Save this setup?", [{ label: "Save and finish" }, { label: "Keep editing" }], 0,
        [change ? "Save and finish: write your change, then check connector access" : "Save and finish: write config.json and .env, then check connector access", "Keep editing: return to your last answer"]);
      if (choice === 1) throw new SetupBackError();
      completed = { answers, backend, saved, savedEnv, planned: chosen, ...(change ? { change, ran: [...ran], channel: channelOut } : {}) };
      session.setCanBack?.(false);
      ctx.log(`Ready to save ${config.name}.`);
    }, summary ? [{ title: "Your change", fields: [
      ...(summary.changing.length ? [{ label: "Changing", value: summary.changing.join("; ") }] : []),
      { label: "Keeping", value: summary.keeping.join("; ") || "nothing else" },
      ...summary.warnings.map((w) => ({ label: "Note", value: w })),
    ] }] : [{ title: "Your setup", fields: [
      { label: "Business", value: answers.name },
      { label: "Booking system", value: `${SETUP_GUIDES[chosen](ctx.callbackPort).label}${notReady ? " (connect later)" : ""}` },
      { label: "Time zone", value: isTimeZone(answers.timezone) ? zoneOption(answers.timezone).label : answers.timezone },
      { label: "Currency", value: currency },
      { label: "Services", value: `${services.length} bookable · ${answers.ask_services?.length ?? 0} ask-the-owner` },
      { label: "Files", value: `${ctx.configPath} and ${ctx.envPath}` },
    ] }]);
    return steps;
  }

  while (!completed) {
    const steps = buildSteps();
    const step = steps[position];
    if (!step) throw new Error("The setup flow has no next step.");
    const previous = () => { let i = position - 1; while (i >= 0 && !steps[i]!.interactive) i--; return i; };
    session.setCanBack?.(previous() >= 0);
    session.setContext?.([...step.notes, ...(error ? [error] : [])]);
    try {
      await step.run();
      error = "";
      // Branch changes can insert or remove steps; find the next step by key.
      position = buildSteps().findIndex((item) => item.key === step.key) + 1;
    } catch (e) {
      if (e instanceof SetupBackError) {
        position = previous();
        error = "";
      } else if ((e as { code?: string }).code === "ABORT_ERR") throw e;
      else {
        error = (e as Error).message;
        ctx.log(error);
        if (!step.interactive || step.key === "save") position = previous();
      }
    }
  }
  return completed;
}
