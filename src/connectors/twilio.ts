// Twilio owner channel: texts the merchant about agent bookings over Twilio's
// REST API. A CommunicationConnector (see types.ts): delivery failures are logged with
// the phone number masked, never thrown. Outbound only; replies are not read.

import type { CommunicationConnector } from "./types.js";

const TWILIO_BODY_MAX = 1500;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TwilioOwnerOptions {
  accountSid: string;
  authToken: string;
  /** Twilio number the SMS is sent from (E.164). */
  from: string;
  /** Merchant's phone (E.164). */
  to: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (m: string) => void;
}

/** Masks all but the last 4 digits: "+1 202 555 0199" -> "***0199". */
export function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `***${digits.slice(-4)}`;
}

/** Masks phone-number-like runs inside free text (e.g. Twilio error messages that echo the To number). */
function maskPhonesIn(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => maskPhone(m));
}

/** Sends the message to the merchant as an SMS through Twilio's REST API. Never throws. */
export function twilioOwnerChannel(opts: TwilioOwnerOptions): CommunicationConnector {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  const to = maskPhone(opts.to);

  return {
    async notify(message) {
      const body = new URLSearchParams({ To: opts.to, From: opts.from, Body: message.slice(0, TWILIO_BODY_MAX) });
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: auth,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const err = e as Error | undefined;
        const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : `network error: ${err?.message ?? e}`;
        warn(`[gateway] owner SMS to ${to} failed: ${maskPhonesIn(why)}`);
        return;
      }
      if (res.ok) return;
      let detail = "";
      try {
        const parsed = JSON.parse(await res.text()) as { message?: unknown };
        if (typeof parsed?.message === "string") detail = `: ${maskPhonesIn(parsed.message)}`;
      } catch {
        // not JSON; status alone
      }
      warn(`[gateway] owner SMS to ${to} failed (${res.status})${detail}`);
    },
  };
}

export interface TwilioSettings {
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  twilio_from?: string;
  owner_phone?: string;
}

/**
 * Twilio channel when all four settings are set, undefined when none are,
 * and an Error naming the missing env vars when only some are.
 */
export function createTwilioChannel(
  settings: TwilioSettings,
  opts: { fetch?: typeof fetch; timeoutMs?: number; warn?: (m: string) => void } = {},
): CommunicationConnector | undefined {
  const fields: Array<[keyof TwilioSettings, string]> = [
    ["twilio_account_sid", "TWILIO_ACCOUNT_SID"],
    ["twilio_auth_token", "TWILIO_AUTH_TOKEN"],
    ["twilio_from", "TWILIO_FROM"],
    ["owner_phone", "OWNER_PHONE"],
  ];
  const missing = fields.filter(([k]) => !settings[k]).map(([, env]) => env);
  if (missing.length === fields.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`Owner SMS is partly configured: set ${missing.join(", ")} too, or unset all of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, OWNER_PHONE to log owner notices instead`);
  }
  return twilioOwnerChannel({
    accountSid: settings.twilio_account_sid!,
    authToken: settings.twilio_auth_token!,
    from: settings.twilio_from!,
    to: settings.owner_phone!,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
    warn: opts.warn,
  });
}
