// The init wizard's owner-channel step (Communication module): none, Slack
// (notices plus two-way replies in a thread), WhatsApp (the same, over Meta's
// webhook) or Twilio SMS (notices only).
// Kept out of init.ts so the booking-system flow and the channel flow can
// change on their own. The answers land in .env through buildEnvFile.

import { randomBytes } from "node:crypto";
import { createSlackChannel, type SlackChannel } from "../connectors/slack.js";
import { createTwilioChannel } from "../connectors/twilio.js";
import { createWhatsappChannel, waNumber, WHATSAPP_WEBHOOK_PATH, type WhatsappChannel } from "../connectors/whatsapp.js";
import { parsePhoneNumberIds } from "../connectors/whatsapp-pool.js";
import { showGuide, type GuideIO, type SetupGuide } from "./guide.js";
import type { Prompter } from "./init.js";
import { style } from "./picker.js";

/** Owner SMS through Twilio (src/connectors/twilio.ts); works with every booking system. */
export interface OwnerSms {
  phone: string;
  accountSid: string;
  authToken: string;
  from: string;
}

/** Slack owner channel (src/connectors/slack.ts); works with every booking system. */
export interface SlackAnswer {
  botToken: string;
  appToken: string;
  channelId: string;
  /** Comma-separated Slack user ids; empty = anyone in the channel counts as the owner. */
  ownerUserIds?: string | undefined;
}

/** WhatsApp owner channel (src/connectors/whatsapp.ts); works with every booking system. */
export interface WhatsappAnswer {
  phone: string;
  accessToken: string;
  /** One or more Phone number IDs, comma-separated with no spaces; the first is the primary. */
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  template?: string | undefined;
}

export interface ChannelAnswers {
  owner?: OwnerSms | undefined;
  slack?: SlackAnswer | undefined;
  whatsapp?: WhatsappAnswer | undefined;
}

export const SLACK_ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL_ID", "SLACK_OWNER_USER_IDS"] as const;
export const WHATSAPP_ENV_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_TEMPLATE"] as const;

const trim = (v: string | undefined) => v?.trim() || undefined;

/** All four Twilio answers or none (createTwilioChannel's rule and error text); the phone alone is not Twilio (WhatsApp shares it). */
export function ownerSms(o: { phone?: string | undefined; sid?: string | undefined; token?: string | undefined; from?: string | undefined }): OwnerSms | undefined {
  const settings = { owner_phone: trim(o.phone), twilio_account_sid: trim(o.sid), twilio_auth_token: trim(o.token), twilio_from: trim(o.from) };
  if (!createTwilioChannel(settings, { warn: () => {} })) return undefined; // throws naming the missing vars on a partial set
  return { phone: settings.owner_phone!, accountSid: settings.twilio_account_sid!, authToken: settings.twilio_auth_token!, from: settings.twilio_from! };
}

/** The three Slack answers or none, with createSlackChannel's checks (partial set, swapped tokens). */
export function slackAnswer(o: { bot?: string | undefined; app?: string | undefined; channel?: string | undefined; owners?: string | undefined }): SlackAnswer | undefined {
  const settings = { slack_bot_token: trim(o.bot), slack_app_token: trim(o.app), slack_channel_id: trim(o.channel) };
  if (!createSlackChannel(settings)) return undefined; // throws on a partial set or a wrong token prefix
  return { botToken: settings.slack_bot_token!, appToken: settings.slack_app_token!, channelId: settings.slack_channel_id!, ownerUserIds: trim(o.owners) };
}

/** A fresh verify token for the Meta webhook handshake; written to .env and pasted into the Meta app. */
export const newVerifyToken = () => randomBytes(16).toString("hex");

/**
 * The WhatsApp answers or none, with createWhatsappChannel's checks (partial set, owner phone). The Phone number ID
 * may be a pool (comma list): parsePhoneNumberIds checks and normalises it here, and the connector check sees only
 * the primary id. A missing verify token is generated: it is the gateway's own secret, not Meta's.
 */
export function whatsappAnswer(o: { phone?: string | undefined; token?: string | undefined; phoneId?: string | undefined; secret?: string | undefined; verify?: string | undefined; template?: string | undefined }): WhatsappAnswer | undefined {
  const anySet = !!(trim(o.token) || trim(o.phoneId) || trim(o.secret));
  const ids = trim(o.phoneId) ? parsePhoneNumberIds(o.phoneId) : undefined; // throws on a non-numeric element
  const settings = {
    owner_phone: trim(o.phone),
    whatsapp_access_token: trim(o.token),
    whatsapp_phone_number_id: ids?.[0],
    whatsapp_app_secret: trim(o.secret),
    whatsapp_verify_token: trim(o.verify) ?? (anySet ? newVerifyToken() : undefined),
    whatsapp_template: trim(o.template),
  };
  if (!createWhatsappChannel(settings)) return undefined; // throws on a partial set
  return { phone: settings.owner_phone!, accessToken: settings.whatsapp_access_token!, phoneNumberId: ids!.join(","), appSecret: settings.whatsapp_app_secret!, verifyToken: settings.whatsapp_verify_token!, template: settings.whatsapp_template };
}

/** .env lines for the channel answers (Slack first: it wins at runtime when both are set). */
export function channelEnvLines(a: ChannelAnswers, kv: (k: string, v: string) => string, glossgenius: boolean): string[] {
  const lines: string[] = [];
  if (a.slack) {
    lines.push(
      "# Owner channel (Slack): agent messages and booking notices in one channel; owners reply in the thread.",
      kv("SLACK_BOT_TOKEN", a.slack.botToken),
      kv("SLACK_APP_TOKEN", a.slack.appToken),
      kv("SLACK_CHANNEL_ID", a.slack.channelId),
    );
    lines.push(a.slack.ownerUserIds ? kv("SLACK_OWNER_USER_IDS", a.slack.ownerUserIds) : "# SLACK_OWNER_USER_IDS=U0123ABCD   (only these users' replies reach agents; unset = anyone in the channel)");
  }
  if (a.whatsapp) {
    lines.push(
      "# Owner channel (WhatsApp, Meta Cloud API): agent messages and booking notices on your phone; reply by quoting the message.",
      `# Meta must call ${WHATSAPP_WEBHOOK_PATH} on this Mudroom server's public URL with the verify token below.`,
      kv("OWNER_PHONE", a.whatsapp.phone),
      kv("WHATSAPP_ACCESS_TOKEN", a.whatsapp.accessToken),
      kv("WHATSAPP_PHONE_NUMBER_ID", a.whatsapp.phoneNumberId),
      kv("WHATSAPP_APP_SECRET", a.whatsapp.appSecret),
      kv("WHATSAPP_VERIFY_TOKEN", a.whatsapp.verifyToken),
    );
    lines.push(a.whatsapp.template ? kv("WHATSAPP_TEMPLATE", a.whatsapp.template) : "# WHATSAPP_TEMPLATE=agent_message:en_US   (approved utility template with one {{1}} parameter, used when you have not written to the number in 24 hours)");
  }
  if (a.owner) {
    lines.push(
      glossgenius ? "# Owner SMS (Twilio): texts you about each agent booking so you can add it to GlossGenius." : "# Owner SMS (Twilio): texts you about each agent booking, cancel and reschedule.",
      ...(a.whatsapp ? [] : [kv("OWNER_PHONE", a.owner.phone)]),
      kv("TWILIO_ACCOUNT_SID", a.owner.accountSid),
      kv("TWILIO_AUTH_TOKEN", a.owner.authToken),
      kv("TWILIO_FROM", a.owner.from),
    );
  }
  if (!a.slack && !a.whatsapp && !a.owner && glossgenius) {
    lines.push("# No owner channel: agent bookings are only logged. Set the SLACK_* vars, the WHATSAPP_* vars or the TWILIO_* vars (with OWNER_PHONE) to hear about them.");
  }
  return lines;
}

export interface ChannelFlags {
  "owner-phone"?: string | undefined;
  "twilio-sid"?: string | undefined;
  "twilio-token"?: string | undefined;
  "twilio-from"?: string | undefined;
  "slack-bot-token"?: string | undefined;
  "slack-app-token"?: string | undefined;
  "slack-channel"?: string | undefined;
  "slack-owner-ids"?: string | undefined;
  "whatsapp-token"?: string | undefined;
  "whatsapp-phone-id"?: string | undefined;
  "whatsapp-app-secret"?: string | undefined;
  "whatsapp-verify-token"?: string | undefined;
  "whatsapp-template"?: string | undefined;
}

/** Non-interactive: channel answers from flags, else env. Throws on a partial Slack, WhatsApp or Twilio set. */
export function channelFromFlags(f: ChannelFlags, env: Record<string, string | undefined>): ChannelAnswers {
  const phone = f["owner-phone"] ?? env.OWNER_PHONE;
  return {
    whatsapp: whatsappAnswer({
      phone,
      token: f["whatsapp-token"] ?? env.WHATSAPP_ACCESS_TOKEN,
      phoneId: f["whatsapp-phone-id"] ?? env.WHATSAPP_PHONE_NUMBER_ID,
      secret: f["whatsapp-app-secret"] ?? env.WHATSAPP_APP_SECRET,
      verify: f["whatsapp-verify-token"] ?? env.WHATSAPP_VERIFY_TOKEN,
      template: f["whatsapp-template"] ?? env.WHATSAPP_TEMPLATE,
    }),
    slack: slackAnswer({
      bot: f["slack-bot-token"] ?? env.SLACK_BOT_TOKEN,
      app: f["slack-app-token"] ?? env.SLACK_APP_TOKEN,
      channel: f["slack-channel"] ?? env.SLACK_CHANNEL_ID,
      owners: f["slack-owner-ids"] ?? env.SLACK_OWNER_USER_IDS,
    }),
    owner: ownerSms({
      phone,
      sid: f["twilio-sid"] ?? env.TWILIO_ACCOUNT_SID,
      token: f["twilio-token"] ?? env.TWILIO_AUTH_TOKEN,
      from: f["twilio-from"] ?? env.TWILIO_FROM,
    }),
  };
}

type AskValid = <T>(p: Prompter, q: string, def: string | undefined, parse: (s: string) => T, shown?: string) => Promise<T>;

const required = (what: string) => (s: string) => {
  if (!s.trim()) throw new Error(`${what} is required`);
  return s.trim();
};
const prefixed = (what: string, prefix: string) => (s: string) => {
  const v = required(what)(s);
  if (!v.startsWith(prefix)) throw new Error(`${what} starts with ${prefix}`);
  return v;
};
export const validWhatsappPhone = (s: string) => {
  const v = required("Phone")(s);
  if (!/^\d{5,}$/.test(waNumber(v))) throw new Error("OWNER_PHONE must be the owner's WhatsApp number with country code, e.g. +1 202 555 0199");
  return v;
};
/** One or more Phone number IDs (a pool gives one chat per customer); returns them normalised, joined with ",". */
export const validWhatsappPhoneId = (s: string) => parsePhoneNumberIds(required("Phone number ID")(s)).join(",");

/** What a merchant needs before the wizard can connect each owner channel. */
export const CHANNEL_GUIDES: Record<"slack" | "whatsapp" | "twilio", SetupGuide> = {
  slack: {
    label: "Slack",
    doc: "slack",
    steps: [
      "Create an app at https://api.slack.com/apps from the manifest in the guide (it turns on Socket Mode and sets the scopes)",
      "Generate an app-level token with connections:write (xapp-...), install the app and copy the Bot User OAuth Token (xoxb-...)",
      "/invite the app to the channel you want and copy the Channel ID (C...)",
    ],
  },
  whatsapp: {
    label: "WhatsApp",
    doc: "whatsapp",
    steps: [
      "Create a Meta app at https://developers.facebook.com/apps with the WhatsApp product; on WhatsApp -> API Setup add your own number under To and copy the Phone number ID and the access token",
      "Copy the App Secret from App settings -> Basic",
      "Your Mudroom server needs a public HTTPS URL: Meta calls it at /webhooks/whatsapp (the wizard prints the URL and verify token to paste into WhatsApp -> Configuration -> Webhook)",
    ],
  },
  twilio: {
    label: "Twilio SMS",
    doc: "twilio",
    steps: [
      "Sign in at https://console.twilio.com and copy the Account SID and Auth Token",
      "Note an SMS-capable number to send from (Phone Numbers -> Manage -> Active numbers)",
      "Trial accounts: verify your mobile under Phone Numbers -> Manage -> Verified Caller IDs",
    ],
  },
};

export const OWNER_CHANNEL_ITEMS = ["None", "Slack (agent messages you can reply to, plus booking notices)", "Twilio SMS (booking notices only)", "WhatsApp (agent messages you can reply to, plus booking notices)"] as const;

/** Interactive: pick none, Slack, Twilio or WhatsApp, then ask for that channel's settings. */
export async function askOwnerChannel(
  p: Prompter,
  ctx: { known: (k: string) => string | undefined; flags: ChannelFlags; log: (m: string) => void; glossgenius: boolean; askValid: AskValid; /** Pre-select Slack when nothing is saved or flagged. */ preferSlack?: boolean; /** With it, a channel not set up yet shows its guide first. */ guide?: GuideIO },
): Promise<ChannelAnswers> {
  const { known, flags: f, log, askValid } = ctx;
  log(style.dim("\nOptional: how you hear from agents. Slack carries agent messages you answer by typing in the thread (docs/connectors/slack.md);"));
  log(style.dim("WhatsApp does the same on your phone (docs/connectors/whatsapp.md); Twilio texts your phone about each booking, cancel and reschedule (docs/connectors/twilio.md)."));
  if (ctx.glossgenius) log(style.dim("Without one, GlossGenius bookings are only logged and you have to watch the log."));
  const configured = (yes: boolean) => (yes ? "configured" : "not configured");
  const slackKnown = !!(known("SLACK_BOT_TOKEN") && known("SLACK_APP_TOKEN") && known("SLACK_CHANNEL_ID"));
  const whatsappKnown = !!(known("WHATSAPP_ACCESS_TOKEN") && known("WHATSAPP_PHONE_NUMBER_ID") && known("WHATSAPP_APP_SECRET") && known("OWNER_PHONE"));
  const twilioKnown = !!(known("OWNER_PHONE") && known("TWILIO_ACCOUNT_SID"));
  const choice = await p.choose(
    "Owner channel",
    [
      { emoji: "🔕", label: OWNER_CHANNEL_ITEMS[0] },
      { emoji: "💬", label: OWNER_CHANNEL_ITEMS[1], status: configured(slackKnown) },
      { emoji: "📱", label: OWNER_CHANNEL_ITEMS[2], status: configured(twilioKnown) },
      { emoji: "🟢", label: OWNER_CHANNEL_ITEMS[3], status: configured(whatsappKnown) },
    ],
    f["slack-bot-token"] || slackKnown ? 1 : f["whatsapp-token"] || whatsappKnown ? 3 : f["owner-phone"] || twilioKnown ? 2 : ctx.preferSlack ? 1 : 0,
  );
  // A channel not set up yet: show what it needs (same step as the booking system); "Not yet" leaves it off.
  const picked = choice === 1 && !slackKnown ? CHANNEL_GUIDES.slack : choice === 2 && !twilioKnown ? CHANNEL_GUIDES.twilio : choice === 3 && !whatsappKnown ? CHANNEL_GUIDES.whatsapp : undefined;
  if (picked && ctx.guide) {
    if (!(await showGuide(p, picked, ctx.guide))) {
      log(`${picked.label} left off for now. Run \`npm run init\` again to add it.`);
      return {};
    }
  } else if (choice === 1) {
    log(style.dim("Slack: create an app at https://api.slack.com/apps, turn on Socket Mode, add the bot scopes and events from docs/connectors/slack.md,"));
    log(style.dim("install it to your workspace and /invite it to the channel."));
  }
  if (choice === 1) {
    const botSaved = trim(known("SLACK_BOT_TOKEN"));
    const appSaved = trim(known("SLACK_APP_TOKEN"));
    return {
      slack: slackAnswer({
        bot: await askValid(p, "Bot User OAuth Token (xoxb-...)", f["slack-bot-token"] ?? botSaved, prefixed("Bot token", "xoxb-"), botSaved && !f["slack-bot-token"] ? "from .env" : undefined),
        app: await askValid(p, "App-level token (xapp-...)", f["slack-app-token"] ?? appSaved, prefixed("App token", "xapp-"), appSaved && !f["slack-app-token"] ? "from .env" : undefined),
        channel: await askValid(p, "Channel ID (C...)", f["slack-channel"] ?? known("SLACK_CHANNEL_ID"), required("Channel ID")),
        owners: await p.ask("Owner Slack user IDs, comma-separated (Enter = anyone in the channel)", f["slack-owner-ids"] ?? known("SLACK_OWNER_USER_IDS")),
      }),
    };
  }
  if (choice === 3) {
    const tokenSaved = trim(known("WHATSAPP_ACCESS_TOKEN"));
    const secretSaved = trim(known("WHATSAPP_APP_SECRET"));
    return {
      whatsapp: whatsappAnswer({
        phone: await askValid(p, "Your WhatsApp number (e.g. +1 202 555 0199)", f["owner-phone"] ?? known("OWNER_PHONE"), validWhatsappPhone),
        phoneId: await askValid(p, "Phone number ID (WhatsApp -> API Setup; a number, not the phone number; one or more, comma-separated, for one chat per customer)", f["whatsapp-phone-id"] ?? known("WHATSAPP_PHONE_NUMBER_ID"), validWhatsappPhoneId),
        token: await askValid(p, "Access token", f["whatsapp-token"] ?? tokenSaved, required("Access token"), tokenSaved && !f["whatsapp-token"] ? "from .env" : undefined),
        secret: await askValid(p, "App Secret (App settings -> Basic)", f["whatsapp-app-secret"] ?? secretSaved, required("App Secret"), secretSaved && !f["whatsapp-app-secret"] ? "from .env" : undefined),
        verify: f["whatsapp-verify-token"] ?? known("WHATSAPP_VERIFY_TOKEN"),
        template: await p.ask("Approved template for messages outside the 24-hour window, name or name:lang (Enter = none)", f["whatsapp-template"] ?? known("WHATSAPP_TEMPLATE")),
      }),
    };
  }
  if (choice === 2) {
    const tokenSaved = trim(known("TWILIO_AUTH_TOKEN"));
    return {
      owner: ownerSms({
        phone: await askValid(p, "Owner mobile number (e.g. +1 202 555 0199)", f["owner-phone"] ?? known("OWNER_PHONE"), required("Phone")),
        sid: await askValid(p, "Twilio Account SID", f["twilio-sid"] ?? known("TWILIO_ACCOUNT_SID"), required("Account SID")),
        token: await askValid(p, "Twilio Auth Token", f["twilio-token"] ?? tokenSaved, required("Auth Token"), tokenSaved && !f["twilio-token"] ? "from .env" : undefined),
        from: await askValid(p, "Twilio phone number to send from", f["twilio-from"] ?? known("TWILIO_FROM"), required("Twilio number")),
      }),
    };
  }
  return {};
}

export type SlackCheckFactory = (a: SlackAnswer) => Pick<SlackChannel, "checkAccess">;

export const defaultSlackFactory: SlackCheckFactory = (a) =>
  createSlackChannel({ slack_bot_token: a.botToken, slack_app_token: a.appToken, slack_channel_id: a.channelId })!;

/** Runs the Slack startup check and prints the hint on failure. Never throws: the files are already written. */
export async function checkSlack(a: SlackAnswer, make: SlackCheckFactory, log: (m: string) => void): Promise<boolean> {
  log(`\nChecking Slack access (channel ${a.channelId}) ...`);
  try {
    await make(a).checkAccess();
    log("Slack access OK. Agent messages will appear in that channel; reply in the thread to answer.");
    return true;
  } catch (e) {
    log(`Slack check FAILED: ${(e as Error).message}`);
    log("Fix it in your Slack app (docs/connectors/slack.md#errors), then re-run `npm run init` or `npm start`, which checks again.");
    return false;
  }
}

/** Builds a checker for one number: the answer it gets carries a single Phone number ID. */
export type WhatsappCheckFactory = (a: WhatsappAnswer) => Pick<WhatsappChannel, "checkAccess">;

export const defaultWhatsappFactory: WhatsappCheckFactory = (a) =>
  createWhatsappChannel({ whatsapp_access_token: a.accessToken, whatsapp_phone_number_id: a.phoneNumberId, whatsapp_app_secret: a.appSecret, whatsapp_verify_token: a.verifyToken, owner_phone: a.phone })!;

/** The webhook URL and verify token to paste into the Meta app (WhatsApp -> Configuration -> Webhook). */
export function whatsappWebhookLines(a: WhatsappAnswer, publicUrl: string | undefined): string[] {
  const base = publicUrl?.trim().replace(/\/+$/, "") || "https://<your public host>";
  return [
    "In your Meta app, open WhatsApp -> Configuration -> Webhook and set:",
    `  Callback URL:  ${base}${WHATSAPP_WEBHOOK_PATH}`,
    `  Verify token:  ${a.verifyToken}`,
    "then click Verify and save, and subscribe to the \"messages\" field. Mudroom must be running at that URL when you click Verify.",
  ];
}

/**
 * Runs the WhatsApp startup check for every number in the pool (one probe per Phone number ID) and prints the hint
 * on failure. Never throws: the files are already written.
 */
export async function checkWhatsapp(a: WhatsappAnswer, make: WhatsappCheckFactory, log: (m: string) => void): Promise<boolean> {
  const ids = parsePhoneNumberIds(a.phoneNumberId);
  log(`\nChecking WhatsApp access (phone number ID${ids.length > 1 ? "s" : ""} ${ids.join(", ")}) ...`);
  let failed = false;
  for (const id of ids) {
    try {
      await make({ ...a, phoneNumberId: id }).checkAccess();
    } catch (e) {
      failed = true;
      log(`WhatsApp check FAILED${ids.length > 1 ? ` for ${id}` : ""}: ${(e as Error).message}`);
    }
  }
  if (failed) {
    log("Fix it in your Meta app (docs/connectors/whatsapp.md#errors), then re-run `npm run init` or `npm start`, which checks again.");
    return false;
  }
  if (ids.length > 1) log(`WhatsApp access OK for all ${ids.length} numbers. Each customer gets their own chat on your phone (up to ${ids.length} at once); reply in that chat to answer.`);
  else log("WhatsApp access OK. Agent messages will arrive on your phone; swipe to reply on one to answer it.");
  return true;
}
