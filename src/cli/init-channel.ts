// The init wizard's owner-channel step (Communication module): none, Slack
// (notices plus two-way replies in a thread) or Twilio SMS (notices only).
// Kept out of init.ts so the booking-system flow and the channel flow can
// change on their own. The answers land in .env through buildEnvFile.

import { createSlackChannel, type SlackChannel } from "../connectors/slack.js";
import { createTwilioChannel } from "../connectors/twilio.js";
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

export interface ChannelAnswers {
  owner?: OwnerSms | undefined;
  slack?: SlackAnswer | undefined;
}

export const SLACK_ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL_ID", "SLACK_OWNER_USER_IDS"] as const;

const trim = (v: string | undefined) => v?.trim() || undefined;

/** All four Twilio answers or none (createTwilioChannel's rule and error text). */
export function ownerSms(o: { phone?: string | undefined; sid?: string | undefined; token?: string | undefined; from?: string | undefined }): OwnerSms | undefined {
  const settings = { owner_phone: trim(o.phone), twilio_account_sid: trim(o.sid), twilio_auth_token: trim(o.token), twilio_from: trim(o.from) };
  createTwilioChannel(settings, { warn: () => {} }); // throws naming the missing vars on a partial set
  if (!settings.owner_phone) return undefined;
  return { phone: settings.owner_phone, accountSid: settings.twilio_account_sid!, authToken: settings.twilio_auth_token!, from: settings.twilio_from! };
}

/** The three Slack answers or none, with createSlackChannel's checks (partial set, swapped tokens). */
export function slackAnswer(o: { bot?: string | undefined; app?: string | undefined; channel?: string | undefined; owners?: string | undefined }): SlackAnswer | undefined {
  const settings = { slack_bot_token: trim(o.bot), slack_app_token: trim(o.app), slack_channel_id: trim(o.channel) };
  if (!createSlackChannel(settings)) return undefined; // throws on a partial set or a wrong token prefix
  return { botToken: settings.slack_bot_token!, appToken: settings.slack_app_token!, channelId: settings.slack_channel_id!, ownerUserIds: trim(o.owners) };
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
  if (a.owner) {
    lines.push(
      glossgenius ? "# Owner SMS (Twilio): texts you about each agent booking so you can add it to GlossGenius." : "# Owner SMS (Twilio): texts you about each agent booking, cancel and reschedule.",
      kv("OWNER_PHONE", a.owner.phone),
      kv("TWILIO_ACCOUNT_SID", a.owner.accountSid),
      kv("TWILIO_AUTH_TOKEN", a.owner.authToken),
      kv("TWILIO_FROM", a.owner.from),
    );
  }
  if (!a.slack && !a.owner && glossgenius) {
    lines.push("# No owner channel: agent bookings are only logged. Set the SLACK_* vars (or OWNER_PHONE and the TWILIO_* vars) to hear about them.");
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
}

/** Non-interactive: channel answers from flags, else env. Throws on a partial Slack or Twilio set. */
export function channelFromFlags(f: ChannelFlags, env: Record<string, string | undefined>): ChannelAnswers {
  return {
    slack: slackAnswer({
      bot: f["slack-bot-token"] ?? env.SLACK_BOT_TOKEN,
      app: f["slack-app-token"] ?? env.SLACK_APP_TOKEN,
      channel: f["slack-channel"] ?? env.SLACK_CHANNEL_ID,
      owners: f["slack-owner-ids"] ?? env.SLACK_OWNER_USER_IDS,
    }),
    owner: ownerSms({
      phone: f["owner-phone"] ?? env.OWNER_PHONE,
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

/** What a merchant needs before the wizard can connect each owner channel. */
export const CHANNEL_GUIDES: Record<"slack" | "twilio", SetupGuide> = {
  slack: {
    label: "Slack",
    doc: "slack",
    steps: [
      "Create an app at https://api.slack.com/apps from the manifest in the guide (it turns on Socket Mode and sets the scopes)",
      "Generate an app-level token with connections:write (xapp-...), install the app and copy the Bot User OAuth Token (xoxb-...)",
      "/invite the app to the channel you want and copy the Channel ID (C...)",
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

export const OWNER_CHANNEL_ITEMS = ["None", "Slack (agent messages you can reply to, plus booking notices)", "Twilio SMS (booking notices only)"] as const;

/** Interactive: pick none, Slack or Twilio, then ask for that channel's settings. */
export async function askOwnerChannel(
  p: Prompter,
  ctx: { known: (k: string) => string | undefined; flags: ChannelFlags; log: (m: string) => void; glossgenius: boolean; askValid: AskValid; /** Pre-select Slack when nothing is saved or flagged. */ preferSlack?: boolean; /** With it, a channel not set up yet shows its guide first. */ guide?: GuideIO },
): Promise<ChannelAnswers> {
  const { known, flags: f, log, askValid } = ctx;
  log(style.dim("\nOptional: how you hear from agents. Slack carries agent messages you answer by typing in the thread (docs/connectors/slack.md);"));
  log(style.dim("Twilio texts your phone about each booking, cancel and reschedule (docs/connectors/twilio.md)."));
  if (ctx.glossgenius) log(style.dim("Without one, GlossGenius bookings are only logged and you have to watch the log."));
  const configured = (yes: boolean) => (yes ? "configured" : "not configured");
  const slackKnown = !!(known("SLACK_BOT_TOKEN") && known("SLACK_APP_TOKEN") && known("SLACK_CHANNEL_ID"));
  const twilioKnown = !!known("OWNER_PHONE");
  const choice = await p.choose(
    "Owner channel",
    [
      { emoji: "🔕", label: OWNER_CHANNEL_ITEMS[0] },
      { emoji: "💬", label: OWNER_CHANNEL_ITEMS[1], status: configured(slackKnown) },
      { emoji: "📱", label: OWNER_CHANNEL_ITEMS[2], status: configured(twilioKnown) },
    ],
    f["slack-bot-token"] || slackKnown ? 1 : f["owner-phone"] || twilioKnown ? 2 : ctx.preferSlack ? 1 : 0,
  );
  // A channel not set up yet: show what it needs (same step as the booking system); "Not yet" leaves it off.
  const picked = choice === 1 && !slackKnown ? CHANNEL_GUIDES.slack : choice === 2 && !twilioKnown ? CHANNEL_GUIDES.twilio : undefined;
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
