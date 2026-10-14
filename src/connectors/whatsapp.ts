// WhatsApp owner channel (Communication module) over the Meta Cloud API: sends
// agent messages and booking notices to the owner's WhatsApp number, and reads
// the owner's typed replies from Meta's webhook (POST /webhooks/whatsapp, signed
// with the app secret). A CommunicationConnector with every thread member (see
// types.ts), so the gateway runs in two_way mode; `flat` because WhatsApp has no
// threads: a reply the owner swipes to quote carries the quoted message id
// (context.id), which maps back to the thread; a plain reply carries nothing and
// the core matches it to the one thread awaiting the owner.
//
// 24-hour window: Meta accepts free-form text only within 24 hours of the
// owner's last message to the number (error 131047 otherwise). The channel
// tries text first and falls back to the approved template in WHATSAPP_TEMPLATE
// with the text as its one parameter; without a template it refuses with a hint.
//
// Durability: Meta retries a webhook delivery for days while the endpoint
// answers non-2xx, so a storage failure answers 500 and the message comes back;
// the core dedups on the message id. There is no history read, so findPosted is
// not implemented: a send whose answer was lost may go out twice.

import { createHmac, timingSafeEqual } from "node:crypto";
import { ConnectorError, type InboundWebhookRequest, type InboundWebhookResponse, type OwnerMessageHandler, type ThreadCapableChannel } from "./types.js";

export const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";
const GRAPH = "https://graph.facebook.com";
const DEFAULT_GRAPH_VERSION = "v21.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_S = 30;
/** Meta's limit for a text body. */
const TEXT_MAX = 4096;
/** Template parameters are shorter and cannot hold newlines. */
const TEMPLATE_PARAM_MAX = 1000;
/** Outbound message ids remembered for quote lookups (opener or follow-up -> the thread's opener id). */
const REF_MAP_MAX = 2000;
const NOTICED_MAX = 500;

/** Meta error codes that mean the token or app setup is wrong; retrying cannot help. */
const AUTH_CODES = new Set([190, 10]);
/** Meta-side hiccups and rate limits the core should queue and retry. */
const TRANSIENT_CODES = new Set([1, 2, 4, 368, 80007, 130429, 131048, 131056]);
/** Free-form text refused: the owner has not written to the number in the last 24 hours. */
export const WINDOW_CLOSED_CODE = 131047;

/** The fix a merchant can act on, per Meta error code. Exported for the docs and the init wizard. */
export function whatsappHint(code: number, message = ""): string {
  if (code === 190) return "WHATSAPP_ACCESS_TOKEN is invalid or expired: generate a new one (Meta app > WhatsApp > API Setup for a 24-hour test token, or a System User token under Business Settings for a permanent one)";
  if (code === 10 || (code >= 200 && code <= 299)) return "the token lacks permission: it needs whatsapp_business_messaging and whatsapp_business_management, and the app must have access to this WhatsApp Business Account";
  if (code === 33 || code === 100) return "WHATSAPP_PHONE_NUMBER_ID is wrong or the token cannot see it: copy the Phone number ID from Meta app > WhatsApp > API Setup";
  if (code === 131030) return "the owner's number is not a recipient of this test number: add it under Meta app > WhatsApp > API Setup > To";
  if (code === WINDOW_CLOSED_CODE) return "the owner has not messaged this number in the last 24 hours: ask them to send it any message, or set WHATSAPP_TEMPLATE to an approved utility template with one {{1}} body parameter";
  if (code === 132001) return "WHATSAPP_TEMPLATE names a template that does not exist for that language: check the name and language under WhatsApp Manager > Message templates";
  if (code === 132000 || code === 132012) return "WHATSAPP_TEMPLATE must have exactly one body parameter {{1}} and no header or button parameters";
  return `WhatsApp refused the request (${code}${message ? `: ${message}` : ""})`;
}

/** Digits only, the form Meta uses for `to` and `from`: "+1 202 555 0199" -> "12025550199". */
export function waNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Masks all but the last 4 digits for logs. */
function mask(digits: string): string {
  return digits.length <= 4 ? "****" : `***${digits.slice(-4)}`;
}

/** Template parameters cannot hold newlines, tabs or more than 4 spaces in a row. */
export function templateParam(text: string): string {
  return text.trim().replace(/\s*\r?\n+\s*/g, " · ").replace(/[\t ]+/g, " ").slice(0, TEMPLATE_PARAM_MAX);
}

export interface WhatsappOwnerOptions {
  /** System-user or temporary access token for the Cloud API. */
  accessToken: string;
  /** The sender's Phone number ID (not the phone number itself). */
  phoneNumberId: string;
  /** The Meta app's App Secret, which signs every webhook delivery. */
  appSecret: string;
  /** Echoed by Meta in the webhook handshake. */
  verifyToken: string;
  /** The owner's number (E.164 or digits); the only sender whose messages count. */
  ownerPhone: string;
  /** Approved utility template with one body parameter, for messages outside the 24-hour window. */
  template?: { name: string; language: string } | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (m: string) => void;
  graphVersion?: string;
}

export type WhatsappChannel = ThreadCapableChannel & Required<Pick<ThreadCapableChannel, "acknowledge" | "checkAccess" | "status" | "webhook" | "flat">>;

type GraphError = { message?: unknown; code?: unknown; error_subcode?: unknown; error_data?: { details?: unknown } };
type InboundMessage = { id?: unknown; from?: unknown; timestamp?: unknown; type?: unknown; text?: { body?: unknown }; context?: { id?: unknown } };

/** `name` or `name:lang` from WHATSAPP_TEMPLATE. */
export function parseTemplate(spec: string | undefined): { name: string; language: string } | undefined {
  const s = spec?.trim();
  if (!s) return undefined;
  const [name, language] = s.split(":");
  if (!name?.trim()) return undefined;
  return { name: name.trim(), language: language?.trim() || "en_US" };
}

export function whatsappOwnerChannel(opts: WhatsappOwnerOptions): WhatsappChannel {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const base = `${GRAPH}/${opts.graphVersion ?? DEFAULT_GRAPH_VERSION}`;
  const owner = waNumber(opts.ownerPhone);
  const ownerMasked = mask(owner);
  let handler: OwnerMessageHandler | undefined;
  let started = false;
  let lastError: string | undefined;
  /** Every message id this channel sent -> the opener id of its thread, so a quote of a follow-up finds the thread. */
  const refs = new Map<string, string>();
  /** Inbound message ids already answered with a notice (Meta redelivers). */
  const noticed = new Set<string>();
  /** Senders already logged this hour, so a stranger cannot fill the log. */
  const strangers = new Map<string, number>();

  function remember(wamid: string, ref: string): void {
    refs.set(wamid, ref);
    if (refs.size > REF_MAP_MAX) refs.delete(refs.keys().next().value!);
  }

  async function graph(path: string, init: { method: "GET" } | { method: "POST"; body: Record<string, unknown> }): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${opts.accessToken}`, ...(init.method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error | undefined;
      const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : `network error: ${err?.message ?? e}`;
      throw new ConnectorError("channel_unavailable", `WhatsApp ${why}`, { retry_after_s: DEFAULT_RETRY_S, cause: e });
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok) return {};
    }
    if (res.ok && !body.error) return body;
    const error = (body.error ?? {}) as GraphError;
    const code = typeof error.code === "number" ? error.code : -1;
    const detail = typeof error.error_data?.details === "string" ? error.error_data.details : typeof error.message === "string" ? error.message : `http ${res.status}`;
    if (res.status === 429 || res.status >= 500 || TRANSIENT_CODES.has(code)) {
      throw new ConnectorError("channel_unavailable", `WhatsApp ${code}: ${detail}`, { retry_after_s: code === 368 ? 300 : DEFAULT_RETRY_S });
    }
    if (res.status === 401 || res.status === 403 || AUTH_CODES.has(code) || (code >= 200 && code <= 299)) {
      throw new ConnectorError("channel_auth_failed", `WhatsApp ${code}: ${whatsappHint(code, detail)}`);
    }
    throw new ConnectorError("channel_rejected", `WhatsApp ${code}: ${detail}`, { cause: error });
  }

  async function sendMessage(payload: Record<string, unknown>): Promise<string> {
    const r = await graph(`${encodeURIComponent(opts.phoneNumberId)}/messages`, { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: owner, ...payload } });
    const id = (r.messages as Array<{ id?: unknown }> | undefined)?.[0]?.id;
    if (typeof id !== "string") throw new ConnectorError("channel_rejected", "WhatsApp send returned no message id");
    return id;
  }

  /** Free-form text, or the template with the text as its parameter when the 24-hour window is closed. */
  async function sendText(text: string): Promise<string> {
    const body = text.slice(0, TEXT_MAX);
    try {
      const id = await sendMessage({ type: "text", text: { preview_url: false, body } });
      lastError = undefined;
      return id;
    } catch (e) {
      const code = ((e as ConnectorError)?.cause as GraphError | undefined)?.code;
      if (code !== WINDOW_CLOSED_CODE) throw e;
      if (!opts.template) throw new ConnectorError("channel_rejected", `WhatsApp ${WINDOW_CLOSED_CODE}: ${whatsappHint(WINDOW_CLOSED_CODE)}`, { cause: e });
      const id = await sendMessage({
        type: "template",
        template: { name: opts.template.name, language: { code: opts.template.language }, components: [{ type: "body", parameters: [{ type: "text", text: templateParam(text) }] }] },
      });
      lastError = undefined;
      return id;
    }
  }

  async function noticeOnce(msgId: string, text: string): Promise<void> {
    if (noticed.has(msgId)) return;
    noticed.add(msgId);
    if (noticed.size > NOTICED_MAX) noticed.delete(noticed.values().next().value!);
    try {
      await sendText(text);
    } catch (e) {
      warn(`[gateway] WhatsApp notice to ${ownerMasked} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  function rejectionNotice(reason: string): string {
    if (reason === "thread_closed") return "That conversation is closed, so the agent will not see this reply.";
    return `This reply was not passed to the agent (${reason}).`;
  }

  function signatureOk(req: InboundWebhookRequest): boolean {
    const header = req.headers["x-hub-signature-256"] ?? "";
    const given = header.startsWith("sha256=") ? header.slice(7) : "";
    const expected = createHmac("sha256", opts.appSecret).update(req.rawBody).digest("hex");
    return given.length === expected.length && timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  }

  /** One inbound message through the core. Throws when the core could not store it, so the delivery answers 500 and Meta retries. */
  async function onMessage(m: InboundMessage): Promise<void> {
    const id = typeof m.id === "string" ? m.id : "";
    const from = typeof m.from === "string" ? waNumber(m.from) : "";
    if (!id || !from) return;
    if (from !== owner) {
      const now = Date.now();
      if ((strangers.get(from) ?? 0) < now - 3_600_000) {
        strangers.set(from, now);
        warn(`[gateway] WhatsApp message from ${mask(from)} ignored: not the owner's number`);
      }
      return;
    }
    const type = typeof m.type === "string" ? m.type : "";
    if (type === "reaction") return;
    if (type !== "text") {
      await noticeOnce(id, "Only text messages reach the agent. Please type your reply.");
      return;
    }
    if (!handler) return;
    const text = typeof m.text?.body === "string" ? m.text.body : "";
    const ts = Number(m.timestamp);
    const sent_at_ms = Number.isFinite(ts) && ts > 0 ? Math.round(ts * 1000) : undefined;
    const quoted = typeof m.context?.id === "string" ? m.context.id : undefined;
    const base = { provider_msg_id: id, user_id: from, text, ...(sent_at_ms !== undefined ? { sent_at_ms } : {}) };
    let outcome: Awaited<ReturnType<OwnerMessageHandler>> = "ignored";
    if (quoted) {
      // A quote of something this channel sent, or (after a restart) of an opener the core still knows by its id.
      outcome = await handler({ ...base, provider_ref: refs.get(quoted) ?? quoted });
    }
    // A plain reply, or a quote of a message nobody knows: the core matches it to the one thread awaiting the owner.
    if (outcome === "ignored") outcome = await handler(base);
    if (outcome.startsWith("rejected:")) await noticeOnce(id, rejectionNotice(outcome.slice("rejected:".length)));
  }

  async function handle(req: InboundWebhookRequest): Promise<InboundWebhookResponse> {
    if (req.method === "GET") {
      if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === opts.verifyToken && typeof req.query["hub.challenge"] === "string") {
        return { status: 200, body: req.query["hub.challenge"] };
      }
      warn("[gateway] WhatsApp webhook handshake refused: hub.verify_token does not match WHATSAPP_VERIFY_TOKEN");
      return { status: 403, body: "verify token mismatch" };
    }
    if (req.method !== "POST") return { status: 405, body: "method not allowed" };
    if (!signatureOk(req)) {
      warn("[gateway] WhatsApp webhook delivery refused: bad X-Hub-Signature-256 (is WHATSAPP_APP_SECRET the app's App Secret?)");
      return { status: 401, body: "bad signature" };
    }
    let body: { object?: unknown; entry?: unknown };
    try {
      body = JSON.parse(req.rawBody.toString("utf8")) as typeof body;
    } catch {
      return { status: 400, body: "not JSON" };
    }
    if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return { status: 200, body: "ignored" };
    for (const entry of body.entry as Array<{ changes?: unknown }>) {
      if (!Array.isArray(entry?.changes)) continue;
      for (const change of entry.changes as Array<{ field?: unknown; value?: { metadata?: { phone_number_id?: unknown }; messages?: unknown } }>) {
        if (change?.field !== "messages" || !Array.isArray(change.value?.messages)) continue;
        // One Meta app can serve several numbers; only deliveries for this one count.
        const pnid = change.value?.metadata?.phone_number_id;
        if (typeof pnid === "string" && pnid !== opts.phoneNumberId) continue;
        for (const m of change.value!.messages as InboundMessage[]) {
          try {
            await onMessage(m);
          } catch (e) {
            // Not stored: answer 500 so Meta delivers it again.
            lastError = `inbound: ${(e as Error)?.message ?? e}`;
            warn(`[gateway] WhatsApp inbound not stored, asking Meta to retry: ${lastError}`);
            return { status: 500, body: "not stored" };
          }
        }
      }
    }
    return { status: 200, body: "ok" };
  }

  const channel: WhatsappChannel = {
    flat: true,
    webhook: { path: WHATSAPP_WEBHOOK_PATH, handle },
    async notify(message) {
      try {
        await sendText(message);
      } catch (e) {
        lastError = (e as Error)?.message ?? String(e);
        warn(`[gateway] owner WhatsApp to ${ownerMasked} failed: ${lastError}`);
      }
    },
    async openThread(opener) {
      const id = await trackSend(() => sendText(opener.text));
      remember(id, id);
      return { provider_ref: id };
    },
    async postToThread(ref, text) {
      const id = await trackSend(() => sendText(text));
      remember(id, ref);
    },
    onOwnerMessage(h) {
      handler = h;
    },
    async acknowledge(_ref, msgId) {
      try {
        await sendMessage({ type: "reaction", reaction: { message_id: msgId, emoji: "✅" } });
      } catch (e) {
        warn(`[gateway] WhatsApp reaction on ${msgId} failed: ${(e as Error)?.message ?? e}`);
      }
    },
    async start() {
      started = true;
    },
    async stop() {
      started = false;
    },
    async checkAccess() {
      const r = await graph(`${encodeURIComponent(opts.phoneNumberId)}?fields=display_phone_number,verified_name`, { method: "GET" });
      if (typeof r.id !== "string") throw new ConnectorError("channel_auth_failed", `WhatsApp: ${whatsappHint(33)}`);
    },
    status() {
      return lastError ? { connected: started, last_error: lastError } : { connected: started };
    },
  };

  async function trackSend(send: () => Promise<string>): Promise<string> {
    try {
      return await send();
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
      throw e;
    }
  }

  return channel;
}

export interface WhatsappSettings {
  whatsapp_access_token?: string | undefined;
  whatsapp_phone_number_id?: string | undefined;
  whatsapp_app_secret?: string | undefined;
  whatsapp_verify_token?: string | undefined;
  whatsapp_template?: string | undefined;
  owner_phone?: string | undefined;
}

export const WHATSAPP_REQUIRED_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "OWNER_PHONE"] as const;

/**
 * WhatsApp channel when the five required settings are set, undefined when none
 * of the WHATSAPP_* ones are (OWNER_PHONE alone belongs to Twilio), and an Error
 * naming the missing env vars when only some are.
 */
export function createWhatsappChannel(
  settings: WhatsappSettings,
  opts: Omit<WhatsappOwnerOptions, "accessToken" | "phoneNumberId" | "appSecret" | "verifyToken" | "ownerPhone" | "template"> = {},
): WhatsappChannel | undefined {
  const fields: Array<[keyof WhatsappSettings, (typeof WHATSAPP_REQUIRED_ENV)[number]]> = [
    ["whatsapp_access_token", "WHATSAPP_ACCESS_TOKEN"],
    ["whatsapp_phone_number_id", "WHATSAPP_PHONE_NUMBER_ID"],
    ["whatsapp_app_secret", "WHATSAPP_APP_SECRET"],
    ["whatsapp_verify_token", "WHATSAPP_VERIFY_TOKEN"],
    ["owner_phone", "OWNER_PHONE"],
  ];
  const missing = fields.filter(([k]) => !settings[k]?.trim()).map(([, env]) => env);
  const setWhatsapp = fields.filter(([k, env]) => env !== "OWNER_PHONE" && settings[k]?.trim());
  if (setWhatsapp.length === 0) return undefined;
  if (missing.length > 0) {
    throw new Error(`WhatsApp is partly configured: set ${missing.join(", ")} too, or unset all of ${WHATSAPP_REQUIRED_ENV.filter((v) => v !== "OWNER_PHONE").join(", ")}`);
  }
  if (!/^\d{5,}$/.test(waNumber(settings.owner_phone!))) throw new Error("OWNER_PHONE must be the owner's WhatsApp number with country code, e.g. +1 202 555 0199");
  if (!/^\d+$/.test(settings.whatsapp_phone_number_id!.trim())) throw new Error("WHATSAPP_PHONE_NUMBER_ID must be the numeric Phone number ID from Meta app > WhatsApp > API Setup, not the phone number");
  return whatsappOwnerChannel({
    ...opts,
    accessToken: settings.whatsapp_access_token!.trim(),
    phoneNumberId: settings.whatsapp_phone_number_id!.trim(),
    appSecret: settings.whatsapp_app_secret!.trim(),
    verifyToken: settings.whatsapp_verify_token!.trim(),
    ownerPhone: settings.owner_phone!,
    template: parseTemplate(settings.whatsapp_template),
  });
}
