// Entry point: one Express app. /api (HTTP/JSON) plus the agent discovery
// pages (/llms.txt, /openapi.json), with auth, rate limits and the shared error body.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Server } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { loadConfigFile, loadEnv, type Config, type RuntimeSettings } from "./config.js";
import { accessLog, agentInstructionsHandler, homeHandler, openApiHandler, robotsHandler } from "./adapters/agents.js";
import { apiRouter, jsonErrorHandler, sendError, type Ops } from "./adapters/http.js";
import { authMiddleware } from "./middleware/auth.js";
import { hostValidation } from "./middleware/hosts.js";
import { requestRateLimit, sqliteContactLookups, withContactLimits } from "./middleware/ratelimit.js";
import { book } from "./book.js";
import { cancel, reschedule } from "./cancel.js";
import { CalendarBookingConnector } from "./connectors/calendar.js";
import { createGlossGeniusConnector } from "./connectors/glossgenius.js";
import { createGoogleConnector } from "./connectors/google.js";
import { createSquareConnector } from "./connectors/square.js";
import { createSlackChannel } from "./connectors/slack.js";
import { createTwilioChannel } from "./connectors/twilio.js";
import { createWhatsappChannel } from "./connectors/whatsapp.js";
import { parsePhoneNumberIds } from "./connectors/whatsapp-pool.js";
import { ConnectorError, isBookingConnector, type BookingConnector, type CalendarConnector, type CommunicationConnector } from "./connectors/types.js";
import { quote, rulesPricer } from "./quote.js";
import { logOwnerChannel } from "./notify/owner.js";
import { listServices } from "./services.js";
import { findSlots } from "./slots.js";
import { openStore, type Store } from "./store/sqlite.js";
import { createMessageOps, type MessageOps } from "./messages.js";
import { demoConnector, demoWiring, feedRoute, OWNER_AWAY_AFTER_MS, OWNER_AWAY_TEXT, type DemoWiring } from "./demo/index.js";

export function toBookingConnector(config: Config, c: CalendarConnector | BookingConnector): BookingConnector {
  return isBookingConnector(c) ? c : new CalendarBookingConnector(config, c);
}

/**
 * Core ops bound to their dependencies; served by the HTTP adapter.
 * `owner` defaults to createOwnerChannel; pass null for none (tests). Message ops exist only
 * when a channel reaches the owner: no channel, or the log fallback, means no leave_message routes at all.
 */
export function buildOps(
  config: Config,
  settings: RuntimeSettings,
  c: CalendarConnector | BookingConnector,
  store: Store,
  ownerChannel?: CommunicationConnector | null,
): Ops {
  const connector = toBookingConnector(config, c);
  const owner = ownerChannel === undefined ? createOwnerChannel(settings, connector, { store }) : (ownerChannel ?? undefined);
  const messages = createMessageOps({
    config,
    store,
    channel: owner,
    settings,
    listServices: async () => {
      const r = await listServices(config, connector);
      if (!r.ok) throw new Error(r.error.message);
      return r.data.services;
    },
    ...(settings.demo ? { ownerAway: { after_ms: OWNER_AWAY_AFTER_MS, text: OWNER_AWAY_TEXT } } : {}),
  });
  return {
    listServices: () => listServices(config, connector),
    findSlots: (req) => {
      const now = new Date();
      return findSlots(req, { config, connector, store, now: () => now, price: rulesPricer(config, now) });
    },
    quote: (req) => quote(req, { config, connector, store }),
    book: (req) => book(req, { config, connector, store, bookingEnabled: settings.booking_enabled, owner, ...(messages ? { threads: messages } : {}) }),
    cancel: (req) => cancel(req, { config, connector, store, owner }),
    reschedule: (req) => reschedule(req, { config, connector, store, owner }),
    ...(messages ? { messages } : {}),
  };
}

export { createSlackChannel };

/** Express glue for a channel's inbound webhook: raw body in, status and text out. Nothing else of the request reaches the channel. */
export function webhookHandler(hook: NonNullable<CommunicationConnector["webhook"]>): express.RequestHandler {
  return async (req, res) => {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") query[k] = v;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const out = await hook.handle({ method: req.method, query, headers, rawBody });
      res.status(out.status).type("text/plain").send(out.body ?? "");
    } catch (e) {
      console.warn(`[gateway] webhook ${hook.path} failed: ${(e as Error)?.message ?? e}`);
      res.status(500).type("text/plain").send("error");
    }
  };
}

/**
 * How the merchant hears from the gateway: Slack (notices plus two-way threads)
 * when configured, else WhatsApp (the same, over Meta's webhook), else Twilio SMS
 * (notices only), else a log line for shadow-mode connectors (which need the
 * merchant to act), else nothing. The two-way channels win over Twilio because
 * only they carry owner replies. Throws when a channel is only partly
 * configured, so a typo never silently falls back to another channel, and when
 * WhatsApp lists several numbers (a pool) but no `store` is given to route them.
 */
export function createOwnerChannel(
  settings: RuntimeSettings,
  connector: BookingConnector,
  opts: { store?: Store; warn?: (m: string) => void } = {},
): CommunicationConnector | undefined {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const slack = createSlackChannel(settings);
  const whatsapp = createWhatsappChannel(settings, { store: opts.store });
  const twilio = createTwilioChannel(settings);
  const names = [slack && "Slack", whatsapp && "WhatsApp", twilio && "Twilio"].filter(Boolean) as string[];
  if (names.length > 1) warn(`[gateway] ${names.join(", ")} are all configured; using ${names[0]} for owner messages (unset the other channels' vars to silence this)`);
  if (!slack && whatsapp) {
    const pool = parsePhoneNumberIds(settings.whatsapp_phone_number_id);
    if (pool.length > 1) console.log(`[gateway] WhatsApp number pool: ${pool.length} numbers, one chat per conversation`);
  }
  return slack ?? whatsapp ?? twilio ?? (connector.ownerNotes ? logOwnerChannel() : undefined);
}

/**
 * Startup check of the owner channel. A setup error (channel_auth_failed,
 * channel_rejected) throws so main() prints its fix hint and exits 1; a
 * transient outage only warns, because bookings work without the channel and
 * the outbox and socket retry on their own.
 */
export async function checkOwnerChannel(owner: CommunicationConnector | undefined, warn: (m: string) => void = (m) => console.warn(m)): Promise<void> {
  try {
    await owner?.checkAccess?.();
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "channel_unavailable") {
      warn(`[gateway] owner channel not reachable at startup, continuing (messages queue until it is): ${e.message}`);
      return;
    }
    throw e;
  }
}

/** The configured connector. Throws when no calendar or booking platform is configured: the gateway never runs without one. */
export function createConnector(config: Config, settings: RuntimeSettings): CalendarConnector | BookingConnector {
  const square = createSquareConnector(settings, { timezone: config.timezone, timeoutMs: config.limits.connector_timeout_ms });
  if (square) {
    if (config.discounts.length) console.warn("[gateway] Square sets prices: the discounts in the config are ignored");
    return square;
  }
  const google = createGoogleConnector(settings, { timeoutMs: config.limits.connector_timeout_ms });
  const glossgenius = createGlossGeniusConnector(settings, {
    calendar: google,
    timezone: config.timezone,
    timeoutMs: config.limits.connector_timeout_ms,
  });
  if (glossgenius) {
    if (config.discounts.length) console.warn("[gateway] GlossGenius sets prices: the discounts in the config are ignored");
    return glossgenius;
  }
  if (google) {
    if (!config.services.length) throw new Error("config.json has no services: with Google Calendar Mudroom needs at least one (run `npm run init`)");
    return google;
  }
  throw new Error(
    "no calendar configured: set SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID, or GOOGLE_SERVICE_ACCOUNT_JSON (or _FILE) + GOOGLE_CALENDAR_ID, or GLOSSGENIUS_BOOKING_URL + GOOGLE_* (GlossGenius shadow mode), or run `npm run init`",
  );
}

/**
 * Filesystem type of the mount that holds `path`, from /proc/self/mountinfo
 * text (Linux). Returns null when no mount covers it.
 */
export function mountFsType(mountinfo: string, path: string): string | null {
  let best: { point: string; fstype: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const [pre, post] = line.split(" - ");
    const point = pre?.split(" ")[4]?.replace(/\\040/g, " ");
    const fstype = post?.split(" ")[0];
    if (!point || !fstype) continue;
    const covers = point === "/" || path === point || path.startsWith(point + "/");
    if (covers && (!best || point.length > best.point.length)) best = { point, fstype };
  }
  return best?.fstype ?? null;
}

/** Warn when the SQLite file lives on a container's throwaway overlay layer (no volume mounted). */
function warnIfEphemeralDb(dbPath: string): void {
  let mountinfo: string;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return; // not Linux: nothing to check
  }
  if (mountFsType(mountinfo, dirname(resolve(dbPath))) === "overlay") {
    console.warn(
      `[gateway] WARNING: ${dbPath} is on the container's own filesystem, not a volume. ` +
        "Quotes, bookings and idempotency keys will be lost when the container is replaced. Mount a volume at /data.",
    );
  }
}

/** One-line summary of the effective TRUST_PROXY setting, for the startup log. */
export function describeTrustProxy(t: RuntimeSettings["trust_proxy"], cf = false): string {
  if (t === false) return "trust proxy: none (client IP = socket peer; X-Forwarded-For and CF-Connecting-IP ignored)";
  if (typeof t === "number") return `trust proxy: ${t} hop(s) (client IP from X-Forwarded-For; CF-Connecting-IP ignored)`;
  const via = cf ? "X-Forwarded-For and CF-Connecting-IP" : "X-Forwarded-For (CF-Connecting-IP ignored)";
  return `trust proxy: ${t.join(",")} (${via} honored only from these peers)`;
}

export function createApp(
  config: Config,
  settings: RuntimeSettings,
  deps: { connector?: CalendarConnector | BookingConnector; store?: Store; owner?: CommunicationConnector | null } = {},
) {
  const base = toBookingConnector(config, deps.connector ?? createConnector(config, settings));
  const connector = settings.demo ? demoConnector(base) : base;
  const store = deps.store ?? openStore(settings.db_path);
  const app = express();
  // Throws at startup on an invalid TRUST_PROXY address/CIDR.
  app.set("trust proxy", settings.trust_proxy);
  const ipOpts = { trustCfHeader: settings.trust_cf_connecting_ip && Array.isArray(settings.trust_proxy), debug: settings.trust_proxy_debug };
  app.use(hostValidation(settings.host, settings.allowed_hosts, sendError));
  // A provider webhook (WhatsApp) verifies a signature over the raw bytes, so it is mounted before the JSON parser.
  const owner = deps.owner === undefined ? createOwnerChannel(settings, connector, { store }) : (deps.owner ?? undefined);
  if (owner?.webhook) app.all(owner.webhook.path, requestRateLimit(config.limits, sendError, ipOpts), express.raw({ type: () => true, limit: "256kb" }), webhookHandler(owner.webhook));
  app.use(express.json());

  app.use(accessLog());

  const ops = buildOps(config, settings, connector, store, owner ?? null);
  const messages = ops.messages;
  // main() starts and stops the channel and outbox through this (start after listen, stop on SIGTERM).
  app.locals.messages = messages;

  app.get("/healthz", (_req, res) => {
    if (!messages) return void res.json({ ok: true });
    const h = messages.health();
    res.json({
      ok: true,
      channel: { mode: h.mode, enabled: h.enabled, connected: h.connected, ...(h.last_error ? { last_error: h.last_error } : {}) },
      outbox: h.outbox,
    });
  });

  ops.book = withContactLimits(ops.book, { limits: config.limits, ...sqliteContactLookups(store.db, config.merchant_id) });
  const guard = [authMiddleware(settings.api_keys, sendError), requestRateLimit(config.limits, sendError, ipOpts)];
  const demo: DemoWiring | undefined = settings.demo
    ? demoWiring({ store, connector, merchantId: config.merchant_id, timezone: config.timezone, onError: sendError, ipOpts })
    : undefined;
  // main() starts the auto-cancel janitor through this, after listen.
  app.locals.demo = demo;

  // Rate-limited like the API: an agent may fetch this on every task.
  const pub = process.env.PUBLIC_URL;
  const discoveryLimit = requestRateLimit(config.limits, sendError, ipOpts);
  const msgMode = messages?.enabled ? messages.mode : undefined;
  app.get("/", discoveryLimit, homeHandler(config, connector, pub, msgMode, settings.demo));
  app.get(["/llms.txt", "/.well-known/llms.txt"], discoveryLimit, agentInstructionsHandler(config, connector, pub, msgMode, settings.demo));
  // Its own counter: the page polls every few seconds and must not spend a visitor's agent quota.
  if (demo) feedRoute(app, demo.traffic, requestRateLimit(config.limits, sendError, ipOpts));
  app.get("/openapi.json", discoveryLimit, openApiHandler(config, connector, pub, msgMode));
  app.get("/robots.txt", discoveryLimit, robotsHandler(pub));

  app.use("/api", ...(demo ? [demo.record] : []), ...guard, ...(demo ? [demo.limits] : []), apiRouter(ops));
  app.use(jsonErrorHandler());

  return app;
}

/**
 * One readable line for a startup failure (bad env, bad config.json, unreachable
 * calendar). Zod issues are listed one per line like parseConfig does; everything
 * else is the error's own message. No stack: these are the merchant's errors to fix.
 */
export function describeStartupError(e: unknown, configPath = "config.json"): string {
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    return `Invalid environment:\n${issues}`;
  }
  if (e instanceof SyntaxError) return `${configPath} is not valid JSON: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** One line for a failed listen (EADDRINUSE, EACCES, ...): problem plus fix, no stack trace. */
export function describeListenError(host: string, port: number, e: NodeJS.ErrnoException): string {
  return `cannot listen on ${host}:${port} (${e.code ?? e.message}): stop the other process or set PORT in .env`;
}

/** Listens, and on a listen error prints describeListenError and exits 1. `exit` is injectable for tests. */
export function listenOrExit(
  app: { listen(port: number, host: string, cb: () => void): Server },
  host: string,
  port: number,
  onListening: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): Server {
  const server = app.listen(port, host, onListening);
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`[gateway] ${describeListenError(host, port, e)}`);
    exit(1);
  });
  return server;
}

/** Pick the config file. The example config is a dev convenience only; production must be given a real one. */
export function resolveConfigPath(configPath: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string {
  if (exists(configPath)) return configPath;
  if (env.NODE_ENV === "production") {
    throw new Error(`${configPath} not found. Mount or create it (cp config.example.json config.json and edit it); the example config is not used in production.`);
  }
  if (exists("config.example.json")) {
    console.warn(`[gateway] ${configPath} not found; using config.example.json`);
    return "config.example.json";
  }
  return configPath;
}

async function main() {
  let configPath = "config.json";
  try {
    const boot = loadEnv(process.env);
    configPath = boot.config_path;
    configPath = resolveConfigPath(configPath, process.env);
    const config = loadConfigFile(configPath);
    const settings = loadEnv(process.env, config);
    warnIfEphemeralDb(settings.db_path);
    const connector = createConnector(config, settings);
    await connector.checkAccess();
    // Opened before the owner channel: a WhatsApp number pool keeps its assignments there, and createApp shares it.
    const store = openStore(settings.db_path);
    // Created here (not inside createApp) so its startup check fails the boot with a fix hint, like the connector's.
    const owner = createOwnerChannel(settings, toBookingConnector(config, connector), { store });
    if (settings.messages_enabled) await checkOwnerChannel(owner);
    const app = createApp(config, settings, { connector, store, owner: owner ?? null });
    const messages = app.locals.messages as MessageOps | undefined;
    const demo = app.locals.demo as DemoWiring | undefined;
    console.log(`[gateway] ${describeTrustProxy(settings.trust_proxy, settings.trust_cf_connecting_ip)}`);
    const server = listenOrExit(app, settings.host, settings.port, () => {
      console.log(`[gateway] ${config.name} listening on http://${settings.host}:${settings.port} (/api, /llms.txt)`);
      if (messages?.enabled) {
        console.log(`[gateway] messages on (${messages.mode === "two_way" ? "owner replies come back in-thread" : "one-way: owner contacts customers directly"})`);
        void messages.start();
      }
      if (demo) {
        console.log("[gateway] demo mode: playground at /, bookings cancel themselves after 60 minutes");
        demo.start();
      }
    });
    process.once("SIGTERM", () => {
      // Answer every held get_thread and stop the sweep and the channel's socket first, then let
      // in-flight requests (book, quote) finish, so a deploy cuts no response. Bounded at 10 s.
      void (async () => {
        try {
          await messages?.stop();
        } catch (e) {
          console.error(`[gateway] stop failed: ${(e as Error)?.message ?? e}`);
        }
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(resolve, 10_000);
          deadline.unref();
          server.close(() => {
            clearTimeout(deadline);
            resolve();
          });
        });
        process.exit(0);
      })();
    });
  } catch (e) {
    console.error(`[gateway] ${describeStartupError(e, configPath)}`);
    process.exit(1);
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
