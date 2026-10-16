// WhatsApp owner channel against a scripted fake of Meta's Cloud API (never the live one):
// the send shapes, the 24-hour window fallback, every channel_* code, and the webhook
// (handshake, signature, quote and plain replies, strangers, non-text, redelivery), and the
// number pool over an in-memory store (assignment, the routing gate, "Which customer?", taps).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError, FLAT_REPLY_HINT, type BookingConnector, type InboundWebhookRequest, type OwnerInboundMessage, type OwnerMessageHandler, type ThreadChoice } from "../src/connectors/types.js";
import {
  clipLine,
  createWhatsappChannel,
  distinctTitles,
  parseTemplate,
  PICKER_FALLBACK_HINT,
  POOL_REPLY_HINT,
  TAP_AGAIN_NOTICE,
  templateParam,
  waNumber,
  whatsappOwnerChannel,
  WHATSAPP_WEBHOOK_PATH,
  WINDOW_CLOSED_CODE,
} from "../src/connectors/whatsapp.js";
import type { RuntimeSettings } from "../src/config.js";
import { createOwnerChannel } from "../src/server.js";
import { openStore } from "../src/store/sqlite.js";
import { PENDING_TTL_MS, RELEASE_HOLD_MS, type WaAssignment, type WaOpenThread, type WaPending, type WaTakeResult, type WhatsappPoolStore } from "../src/connectors/whatsapp-pool.js";

const OWNER = "+1 202 555 0199";
const OWNER_WA = "12025550199";
const PNID = "123456789012345";
const SECRET = "app-secret";
const VERIFY = "verify-me";

type Req = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
type Script = (req: Req) => Response | Promise<Response> | Error;

const ok = (id = "wamid.out1") => new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id }] }), { status: 200 });
const graphError = (code: number, status = 400, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { message: `(#${code}) oops`, type: "OAuthException", code, ...extra } }), { status });

/** Scripted Meta: records each request, answers from the script (default: every send succeeds). */
function meta(script: Script = () => ok(), opts: { template?: string; pnid?: string; store?: WhatsappPoolStore; now?: () => number } = {}) {
  const reqs: Req[] = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const req: Req = { url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    reqs.push(req);
    // Like the real fetch: the channel's AbortSignal.timeout wins over a slow answer.
    const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    const r = await Promise.race([Promise.resolve(script(req)), aborted]);
    if (r instanceof Error) throw r;
    return r;
  };
  const ch = createWhatsappChannel(
    { whatsapp_access_token: "tok", whatsapp_phone_number_id: opts.pnid ?? PNID, whatsapp_app_secret: SECRET, whatsapp_verify_token: VERIFY, owner_phone: OWNER, whatsapp_template: opts.template },
    { fetch: fetchImpl, warn: (m) => logs.push(m), timeoutMs: 50, ...(opts.store ? { store: opts.store } : {}), ...(opts.now ? { now: opts.now } : {}) },
  )!;
  const handled: OwnerInboundMessage[] = [];
  let answer: Awaited<ReturnType<OwnerMessageHandler>> | Error = "accepted";
  const handler: OwnerMessageHandler = async (m) => {
    handled.push(m);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  ch.onOwnerMessage(handler);
  const sends = () => reqs.filter((r) => r.method === "POST").map((r) => r.body!);
  return { ch, reqs, logs, handled, sends, setAnswer: (a: typeof answer) => (answer = a) };
}

const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** A webhook POST as Meta sends it, signed with the app secret unless `signature` says otherwise. */
function delivery(messages: Record<string, unknown>[], o: { signature?: string; pnid?: string; field?: string; raw?: string; statuses?: Record<string, unknown>[] } = {}): InboundWebhookRequest {
  // A status-only delivery (read receipts) carries `statuses` and no `messages`, as Meta sends it.
  const items = o.statuses ? { ...(messages.length ? { messages } : {}), statuses: o.statuses } : { messages };
  const raw = o.raw ?? JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: o.field ?? "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: o.pnid ?? PNID }, ...items } }] }] });
  return { method: "POST", query: {}, headers: { "content-type": "application/json", "x-hub-signature-256": o.signature ?? sign(raw) }, rawBody: Buffer.from(raw) };
}

const text = (id: string, body: string, extra: Record<string, unknown> = {}) => ({ id, from: OWNER_WA, timestamp: "1760000000", type: "text", text: { body }, ...extra });

describe("whatsappOwnerChannel: sending", () => {
  it("openThread sends a text to the owner with the bearer token and returns the message id as provider_ref", async () => {
    const { ch, reqs } = meta(() => ok("wamid.A"));
    const r = await ch.openThread({ thread_id: "t1", text: "New message for Paws\nFrom: Ann", dedupe_key: "t1:1" });
    expect(r).toEqual({ provider_ref: "wamid.A" });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.url).toBe(`https://graph.facebook.com/v21.0/${PNID}/messages`);
    expect(reqs[0]!.headers.authorization).toBe("Bearer tok");
    expect(reqs[0]!.body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: OWNER_WA, type: "text", text: { preview_url: false, body: "New message for Paws\nFrom: Ann" } });
  });

  it("is flat and exposes the webhook path", () => {
    const { ch } = meta();
    expect(ch.flat).toBe(true);
    expect(ch.webhook.path).toBe(WHATSAPP_WEBHOOK_PATH);
    expect(ch.findPosted).toBeUndefined();
  });

  it("cuts a text at 4096 characters", async () => {
    const { ch, sends } = meta();
    await ch.openThread({ thread_id: "t1", text: "x".repeat(5000) });
    expect((sends()[0]!.text as { body: string }).body).toHaveLength(4096);
  });

  it("notify logs a failure instead of throwing", async () => {
    const { ch, logs } = meta(() => graphError(100));
    await expect(ch.notify("Agent booking: Ann")).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("***0199");
    expect(logs[0]).not.toContain(OWNER_WA);
    expect(ch.status().last_error).toContain("100");
  });

  it("outside the 24-hour window with a template: sends the template with the text flattened into its one parameter", async () => {
    const { ch, sends } = meta((req) => ((req.body?.type as string) === "text" ? graphError(WINDOW_CLOSED_CODE) : ok("wamid.T")), { template: "agent_message:en_GB" });
    const r = await ch.openThread({ thread_id: "t1", text: "New message for Paws\n\nDo you    groom cats?\n" });
    expect(r.provider_ref).toBe("wamid.T");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({
      type: "template",
      template: { name: "agent_message", language: { code: "en_GB" }, components: [{ type: "body", parameters: [{ type: "text", text: "New message for Paws · Do you groom cats?" }] }] },
    });
  });

  it("outside the 24-hour window without a template: channel_rejected with the fix", async () => {
    const { ch, sends } = meta(() => graphError(WINDOW_CLOSED_CODE));
    const e = await ch.openThread({ thread_id: "t1", text: "hi" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as ConnectorError).code).toBe("channel_rejected");
    expect((e as ConnectorError).message).toContain("WHATSAPP_TEMPLATE");
    expect((e as ConnectorError).message).toContain("24 hours");
    expect(sends()).toHaveLength(1);
  });

  it("an expired token is channel_auth_failed with the hint; a wrong recipient is channel_rejected", async () => {
    const auth = meta(() => graphError(190, 401));
    const e1 = await auth.ch.openThread({ thread_id: "t1", text: "hi" }).catch((x: unknown) => x);
    expect((e1 as ConnectorError).code).toBe("channel_auth_failed");
    expect((e1 as ConnectorError).message).toContain("WHATSAPP_ACCESS_TOKEN");
    const perm = meta(() => graphError(10, 403));
    const e2 = await perm.ch.openThread({ thread_id: "t1", text: "hi" }).catch((x: unknown) => x);
    expect((e2 as ConnectorError).code).toBe("channel_auth_failed");
    const bad = meta(() => graphError(131030, 400, { error_data: { details: "Recipient phone number not in allowed list" } }));
    const e3 = await bad.ch.postToThread("wamid.A", "hi").catch((x: unknown) => x);
    expect((e3 as ConnectorError).code).toBe("channel_rejected");
    expect((e3 as ConnectorError).message).toContain("API Setup > To");
    const other = meta(() => graphError(131026, 400, { error_data: { details: "Message undeliverable" } }));
    const e4 = await other.ch.postToThread("wamid.A", "hi").catch((x: unknown) => x);
    expect((e4 as ConnectorError).code).toBe("channel_rejected");
    expect((e4 as ConnectorError).message).toContain("Message undeliverable");
  });

  it("5xx, 429, Meta's temporary codes, timeouts and network errors are channel_unavailable with a retry", async () => {
    for (const script of [() => graphError(2, 500), () => graphError(130429, 429), () => graphError(80007, 400), () => new TypeError("fetch failed")] as Script[]) {
      const { ch } = meta(script);
      const e = await ch.openThread({ thread_id: "t1", text: "hi" }).catch((x: unknown) => x);
      expect((e as ConnectorError).code).toBe("channel_unavailable");
      expect((e as ConnectorError).retry_after_s).toBeGreaterThan(0);
    }
    const slow = meta(() => new Promise((r) => setTimeout(() => r(ok()), 200)));
    const e = await slow.ch.openThread({ thread_id: "t1", text: "hi" }).catch((x: unknown) => x);
    expect((e as ConnectorError).code).toBe("channel_unavailable");
    expect((e as ConnectorError).message).toContain("timed out");
  });

  it("acknowledge reacts with a check mark and swallows failures", async () => {
    const { ch, sends } = meta();
    await ch.acknowledge("wamid.A", "wamid.in1");
    expect(sends()[0]).toMatchObject({ type: "reaction", to: OWNER_WA, reaction: { message_id: "wamid.in1", emoji: "✅" } });
    const failing = meta(() => graphError(100));
    await expect(failing.ch.acknowledge("wamid.A", "wamid.in1")).resolves.toBeUndefined();
    expect(failing.logs[0]).toContain("reaction");
  });

  it("checkAccess reads the phone number; a bad token or id fails with a hint", async () => {
    const good = meta(() => new Response(JSON.stringify({ id: PNID, display_phone_number: "+1 555 000 0000", verified_name: "Paws" })));
    await expect(good.ch.checkAccess()).resolves.toBeUndefined();
    expect(good.reqs[0]!.url).toBe(`https://graph.facebook.com/v21.0/${PNID}?fields=display_phone_number,verified_name`);
    const bad = meta(() => graphError(190, 401));
    await expect(bad.ch.checkAccess()).rejects.toMatchObject({ code: "channel_auth_failed" });
    const wrongId = meta(() => graphError(100, 400));
    const e = await wrongId.ch.checkAccess().catch((x: unknown) => x);
    expect((e as ConnectorError).code).toBe("channel_rejected");
    expect((e as ConnectorError).message).toContain("WHATSAPP_PHONE_NUMBER_ID");
  });

  it("status follows start and stop", async () => {
    const { ch } = meta();
    expect(ch.status()).toEqual({ connected: false });
    await ch.start();
    expect(ch.status()).toEqual({ connected: true });
    await ch.stop();
    expect(ch.status().connected).toBe(false);
  });
});

describe("whatsappOwnerChannel: webhook", () => {
  it("answers the handshake with the challenge only for the right verify token", async () => {
    const { ch, logs } = meta();
    const good = await ch.webhook.handle({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "12345" }, headers: {}, rawBody: Buffer.alloc(0) });
    expect(good).toEqual({ status: 200, body: "12345" });
    const bad = await ch.webhook.handle({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "12345" }, headers: {}, rawBody: Buffer.alloc(0) });
    expect(bad.status).toBe(403);
    expect(logs[0]).toContain("WHATSAPP_VERIFY_TOKEN");
  });

  it("refuses a delivery with a missing or wrong signature before reading it", async () => {
    const { ch, handled, logs } = meta();
    expect((await ch.webhook.handle(delivery([text("wamid.1", "yes")], { signature: "sha256=00" }))).status).toBe(401);
    expect((await ch.webhook.handle(delivery([text("wamid.1", "yes")], { signature: "" }))).status).toBe(401);
    const tampered = delivery([text("wamid.1", "yes")]);
    tampered.rawBody = Buffer.from(tampered.rawBody.toString().replace("yes", "no!"));
    expect((await ch.webhook.handle(tampered)).status).toBe(401);
    expect(handled).toEqual([]);
    expect(logs[0]).toContain("WHATSAPP_APP_SECRET");
  });

  it("a quoted reply carries the quoted message as provider_ref; a quote of a follow-up resolves to the opener", async () => {
    const { ch, handled } = meta((req) => ok((req.body?.text as { body: string }).body.startsWith("New") ? "wamid.open" : "wamid.follow"));
    await ch.openThread({ thread_id: "t1", text: "New message" });
    await ch.postToThread("wamid.open", "Follow-up");
    expect((await ch.webhook.handle(delivery([text("wamid.in1", "Yes, cats welcome", { context: { from: "15550000000", id: "wamid.open" } })]))).status).toBe(200);
    expect((await ch.webhook.handle(delivery([text("wamid.in2", "3pm works", { context: { from: "15550000000", id: "wamid.follow" } })]))).status).toBe(200);
    expect(handled).toEqual([
      { provider_ref: "wamid.open", provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes, cats welcome", sent_at_ms: 1760000000000 },
      { provider_ref: "wamid.open", provider_msg_id: "wamid.in2", user_id: OWNER_WA, text: "3pm works", sent_at_ms: 1760000000000 },
    ]);
  });

  it("a plain reply has no provider_ref; a quote of an unknown message is tried by its id and, if unknown to the core, answered with a notice, never routed as plain", async () => {
    const { ch, handled, sends, setAnswer } = meta();
    expect((await ch.webhook.handle(delivery([text("wamid.in1", "Yes")]))).status).toBe(200);
    expect(handled).toEqual([{ provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes", sent_at_ms: 1760000000000 }]);
    handled.length = 0;
    setAnswer("ignored");
    // The owner quoted customer A's follow-up from before a restart; customer B may be the only one waiting now.
    await ch.webhook.handle(delivery([text("wamid.in2", "Yes", { context: { id: "wamid.forgotten" } })]));
    await ch.webhook.handle(delivery([text("wamid.in2", "Yes", { context: { id: "wamid.forgotten" } })])); // redelivery
    expect(handled.map((m) => m.provider_ref)).toEqual(["wamid.forgotten", "wamid.forgotten"]);
    expect(sends()).toHaveLength(1);
    expect((sends()[0]!.text as { body: string }).body).toContain("could not tell which conversation");
    // A quote the core does place (an opener it still knows after a restart) gets no notice.
    setAnswer("accepted");
    await ch.webhook.handle(delivery([text("wamid.in3", "Yes", { context: { id: "wamid.opener-from-before" } })]));
    expect(sends()).toHaveLength(1);
  });

  it("ignores senders other than the owner, logging once, and never writes back to them", async () => {
    const { ch, handled, logs, sends } = meta();
    const stranger = { ...text("wamid.s1", "hello?"), from: "4915550000000" };
    await ch.webhook.handle(delivery([stranger, { ...stranger, id: "wamid.s2" }]));
    expect(handled).toEqual([]);
    expect(sends()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("***0000");
    expect(logs[0]).not.toContain("4915550000000");
  });

  it("a non-text message gets one notice; a reaction is ignored silently", async () => {
    const { ch, handled, sends } = meta();
    const image = { id: "wamid.img", from: OWNER_WA, timestamp: "1760000000", type: "image", image: { id: "m1" } };
    await ch.webhook.handle(delivery([image]));
    await ch.webhook.handle(delivery([image])); // Meta redelivers
    await ch.webhook.handle(delivery([{ id: "wamid.r", from: OWNER_WA, timestamp: "1760000000", type: "reaction", reaction: { message_id: "wamid.open", emoji: "👍" } }]));
    expect(handled).toEqual([]);
    expect(sends()).toHaveLength(1);
    expect((sends()[0]!.text as { body: string }).body).toContain("Only text");
  });

  it("a rejected reply gets one notice in the chat", async () => {
    const { ch, sends, setAnswer } = meta();
    setAnswer("rejected:thread_closed");
    await ch.webhook.handle(delivery([text("wamid.in1", "late", { context: { id: "wamid.open" } })]));
    expect(sends()).toHaveLength(1);
    expect((sends()[0]!.text as { body: string }).body).toContain("closed");
  });

  it("answers 500 when the core could not store the reply, so Meta delivers it again", async () => {
    const { ch, setAnswer, logs } = meta();
    setAnswer(new Error("SQLITE_BUSY"));
    const r = await ch.webhook.handle(delivery([text("wamid.in1", "Yes")]));
    expect(r.status).toBe(500);
    expect(logs[0]).toContain("SQLITE_BUSY");
    expect(ch.status().last_error).toContain("SQLITE_BUSY");
  });

  it("answers 200 to status updates, other numbers, other objects and non-JSON noise it will not act on", async () => {
    const { ch, handled } = meta();
    expect((await ch.webhook.handle(delivery([text("wamid.x", "hi")], { field: "message_template_status_update" }))).status).toBe(200);
    expect((await ch.webhook.handle(delivery([text("wamid.y", "hi")], { pnid: "999" }))).status).toBe(200);
    const other = JSON.stringify({ object: "page", entry: [] });
    expect((await ch.webhook.handle({ method: "POST", query: {}, headers: { "x-hub-signature-256": sign(other) }, rawBody: Buffer.from(other) })).status).toBe(200);
    expect((await ch.webhook.handle({ method: "POST", query: {}, headers: { "x-hub-signature-256": sign("{not json") }, rawBody: Buffer.from("{not json") })).status).toBe(400);
    expect((await ch.webhook.handle({ method: "DELETE", query: {}, headers: {}, rawBody: Buffer.alloc(0) })).status).toBe(405);
    expect(handled).toEqual([]);
  });
});

describe("createWhatsappChannel", () => {
  it("returns undefined when no WHATSAPP_* var is set, even with OWNER_PHONE (that may be Twilio's)", () => {
    expect(createWhatsappChannel({})).toBeUndefined();
    expect(createWhatsappChannel({ owner_phone: OWNER })).toBeUndefined();
  });

  it("throws naming the missing vars when partly set", () => {
    expect(() => createWhatsappChannel({ whatsapp_access_token: "t", owner_phone: OWNER })).toThrow(/set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN too/);
    expect(() => createWhatsappChannel({ whatsapp_access_token: "t", whatsapp_phone_number_id: PNID, whatsapp_app_secret: "s", whatsapp_verify_token: "v" })).toThrow(/set OWNER_PHONE too/);
  });

  it("rejects a phone number where the Phone number ID should be, and a bad owner number", () => {
    expect(() => createWhatsappChannel({ whatsapp_access_token: "t", whatsapp_phone_number_id: "+1 555 000 0000", whatsapp_app_secret: "s", whatsapp_verify_token: "v", owner_phone: OWNER })).toThrow(/Phone number ID/);
    expect(() => createWhatsappChannel({ whatsapp_access_token: "t", whatsapp_phone_number_id: PNID, whatsapp_app_secret: "s", whatsapp_verify_token: "v", owner_phone: "owner" })).toThrow(/OWNER_PHONE/);
  });

  it("parses the template spec and normalises numbers", () => {
    expect(parseTemplate(undefined)).toBeUndefined();
    expect(parseTemplate("agent_message")).toEqual({ name: "agent_message", language: "en_US" });
    expect(parseTemplate(" agent_message : es ")).toEqual({ name: "agent_message", language: "es" });
    expect(waNumber("+1 (202) 555-0199")).toBe("12025550199");
    expect(templateParam("a\n\n b\tc    d")).toBe("a · b c d");
  });

  it("builds the channel with the template when all are set", async () => {
    const { ch } = meta(() => ok(), { template: "agent_message" });
    expect(ch.flat).toBe(true);
    expect(typeof ch.openThread).toBe("function");
  });
});

describe("whatsappOwnerChannel unit helpers", () => {
  it("whatsappOwnerChannel accepts digits-only owner numbers too", async () => {
    const reqs: Req[] = [];
    const ch = whatsappOwnerChannel({ accessToken: "t", phoneNumberId: PNID, appSecret: SECRET, verifyToken: VERIFY, ownerPhone: OWNER_WA, fetch: async (u, i) => (reqs.push({ url: String(u), method: i?.method ?? "GET", headers: {}, body: JSON.parse(String(i?.body)) }), ok()) });
    await ch.notify("hi");
    expect(reqs[0]!.body!.to).toBe(OWNER_WA);
  });
});

// ---- Number pool (several WHATSAPP_PHONE_NUMBER_IDs) ----

const P1 = "111111111111111";
const P2 = "222222222222222";
const T0 = 1_760_000_000_000;
/** Meta's whole-second timestamp for an owner clock time. */
const ts = (ms: number) => String(Math.floor(ms / 1000));

type FakeRow = { thread_id: string; number_id: string; owner: string; reused: boolean; accepted_at_ms: number | null; opener: string | null; read_at_ms: number | null; confirmed_at_ms: number | null; closed_at_ms: number | null };

/** In-memory WhatsappPoolStore following the contract in whatsapp-pool.ts (the outbox part of "free" is not modelled). */
class FakePoolStore implements WhatsappPoolStore {
  rows = new Map<string, FakeRow>();
  windows = new Map<string, number>();
  pending = new Map<string, WaPending & { consumed: boolean; chosen?: string }>();
  failOn: string | undefined;

  private check(name: string): void {
    if (this.failOn === name) throw new Error(`SQLITE_BUSY in ${name}`);
  }
  close(thread_id: string, at_ms: number): void {
    this.rows.get(thread_id)!.closed_at_ms = at_ms;
  }
  private on(number_id: string, owner: string): FakeRow[] {
    return [...this.rows.values()].filter((r) => r.number_id === number_id && r.owner === owner);
  }
  waAssign(q: { thread_id: string; owner_phone: string; pool: string[]; now_ms: number }): WaAssignment {
    this.check("waAssign");
    const had = this.rows.get(q.thread_id);
    if (had) return { number_id: had.number_id, reused: had.reused };
    const free = q.pool.filter((n) => this.on(n, q.owner_phone).every((r) => r.closed_at_ms !== null && r.closed_at_ms + RELEASE_HOLD_MS <= q.now_ms));
    const lastClose = (n: string) => Math.max(...this.on(n, q.owner_phone).map((r) => r.closed_at_ms!));
    const openCount = (n: string) => this.on(n, q.owner_phone).filter((r) => r.closed_at_ms === null).length;
    const pick =
      free.find((n) => this.on(n, q.owner_phone).length === 0) ??
      [...free].sort((a, b) => lastClose(a) - lastClose(b))[0] ??
      q.pool.reduce((best, n) => (openCount(n) > openCount(best) ? n : best), q.pool[0]!);
    const reused = this.on(pick, q.owner_phone).length > 0;
    this.rows.set(q.thread_id, { thread_id: q.thread_id, number_id: pick, owner: q.owner_phone, reused, accepted_at_ms: null, opener: null, read_at_ms: null, confirmed_at_ms: null, closed_at_ms: null });
    return { number_id: pick, reused };
  }
  waNumberForRef(provider_ref: string): string | null {
    return [...this.rows.values()].find((r) => r.opener === provider_ref)?.number_id ?? null;
  }
  waOpenOn(q: { number_id: string; owner_phone: string; is_primary: boolean }): WaOpenThread[] {
    this.check("waOpenOn");
    return this.on(q.number_id, q.owner_phone)
      .filter((r) => r.closed_at_ms === null)
      .map((r) => ({ thread_id: r.thread_id, provider_ref: r.opener, reused: r.reused, accepted_at_ms: r.accepted_at_ms, opener_read_at_ms: r.read_at_ms, confirmed_at_ms: r.confirmed_at_ms }));
  }
  waMarkAccepted(thread_id: string, opener_wamid: string, at_ms: number): void {
    const r = this.rows.get(thread_id)!;
    r.opener = opener_wamid;
    r.accepted_at_ms = at_ms;
  }
  waMarkRead(opener_wamid: string, at_ms: number): void {
    this.check("waMarkRead");
    const r = [...this.rows.values()].find((x) => x.opener === opener_wamid);
    if (r && r.read_at_ms === null) r.read_at_ms = at_ms;
  }
  waConfirm(thread_id: string, at_ms: number): void {
    const r = this.rows.get(thread_id);
    if (r && r.confirmed_at_ms === null) r.confirmed_at_ms = at_ms;
  }
  waTouchWindow(number_id: string, owner_phone: string, at_ms: number): void {
    this.windows.set(`${number_id}:${owner_phone}`, at_ms);
  }
  waPutPending(p: WaPending): void {
    this.check("waPutPending");
    if ([...this.pending.values()].some((x) => x.orig_wamid === p.orig_wamid)) return;
    this.pending.set(p.prompt_wamid, { ...p, consumed: false });
  }
  waHasPending(orig_wamid: string): boolean {
    return [...this.pending.values()].some((x) => x.orig_wamid === orig_wamid);
  }
  waTakePending(q: { prompt_wamid: string; chosen_ref: string; number_id: string; now_ms: number }): WaTakeResult {
    const p = this.pending.get(q.prompt_wamid);
    if (!p) return { ok: false, reason: "unknown" };
    const { consumed: _c, chosen: _ch, ...pending } = p;
    if (p.consumed) return p.chosen === q.chosen_ref && p.number_id === q.number_id ? { ok: true, pending } : { ok: false, reason: "consumed" };
    if (p.number_id !== q.number_id || !p.allowed.includes(q.chosen_ref)) return { ok: false, reason: "not_allowed" };
    if (q.now_ms >= p.expires_at_ms) return { ok: false, reason: "expired" };
    p.consumed = true;
    p.chosen = q.chosen_ref;
    return { ok: true, pending };
  }
  waOrphanNumbers(pool: string[], owner_phone: string): string[] {
    return [...new Set([...this.rows.values()].filter((r) => r.owner === owner_phone && r.closed_at_ms === null && !pool.includes(r.number_id)).map((r) => r.number_id))];
  }
}

/** A two-number pool over the scripted Meta, an in-memory store and a settable server clock. Every send gets a fresh wamid. */
function pool(script?: Script) {
  const store = new FakePoolStore();
  let t = T0;
  let n = 0;
  const m = meta(script ?? (() => ok(`wamid.o${++n}`)), { pnid: `${P1},${P2}`, store, now: () => t, template: "owner_update" });
  /** Each POST with the number it was sent from. */
  const posts = () => m.reqs.filter((r) => r.method === "POST").map((r) => ({ from: r.url.split("/").at(-2)!, body: r.body! }));
  return { ...m, store, posts, tick: (ms: number) => void (t += ms), now: () => t };
}

const openerFor = (tid: string, name: string) => ({
  thread_id: tid,
  customer_name: name,
  text: `New message for Paws from a customer's AI assistant (thread ${tid})\nFrom: ${name} (+1 202 555 0199)\n\nDo you groom cats?\n\n${FLAT_REPLY_HINT}`,
});
const bodyOf = (b: Record<string, unknown>) => (b.text as { body: string }).body;
const tap = (id: string, prompt: string, chosen: string, o: { list?: boolean; at?: number } = {}) => ({
  context: { from: "15550000000", id: prompt },
  from: OWNER_WA,
  id,
  timestamp: ts(o.at ?? T0),
  type: "interactive",
  interactive: o.list ? { type: "list_reply", list_reply: { id: chosen, title: "Ann", description: "x" } } : { type: "button_reply", button_reply: { id: chosen, title: "Ann" } },
});
/** What the core does with a scoped message: ask over the given choices (titles from the refs). */
const askingCore = (ch: ReturnType<typeof pool>["ch"], handled: OwnerInboundMessage[], titles: Record<string, string> = {}): OwnerMessageHandler => async (m) => {
  handled.push(m);
  if (m.scope_refs) {
    await ch.askWhichThread!(m, m.scope_refs.map((r) => ({ provider_ref: r, thread_id: r, title: titles[r] ?? r })));
    return "ignored";
  }
  return "accepted";
};

describe("whatsappOwnerChannel: number pool, sending", () => {
  it("gives each thread its own number while one is free, then overflows onto the busier one (ties to the primary)", async () => {
    const { ch, posts, store } = pool();
    const r1 = await ch.openThread(openerFor("t1", "Ann"));
    const r2 = await ch.openThread(openerFor("t2", "Bea"));
    const r3 = await ch.openThread(openerFor("t3", "Cy"));
    const r4 = await ch.openThread(openerFor("t4", "Di"));
    expect(posts().map((p) => p.from)).toEqual([P1, P2, P1, P1]);
    expect([r1, r2, r3, r4].map((r) => r.provider_ref)).toEqual(["wamid.o1", "wamid.o2", "wamid.o3", "wamid.o4"]);
    expect(store.rows.get("t1")).toMatchObject({ opener: "wamid.o1", accepted_at_ms: T0 });
    // An overflow opener shares its chat, so it keeps the swipe-to-reply wording.
    expect(bodyOf(posts()[2]!.body)).toContain(FLAT_REPLY_HINT);
  });

  it("a fresh number's opener says the chat is only about this customer; a reused one first says the messages above are someone else's", async () => {
    const { ch, posts, store, tick, now } = pool();
    await ch.openThread(openerFor("t1", "Ann"));
    await ch.openThread(openerFor("t2", "Bea"));
    const fresh = bodyOf(posts()[0]!.body);
    expect(fresh).toContain(POOL_REPLY_HINT);
    expect(fresh).not.toContain(FLAT_REPLY_HINT);
    expect(fresh.startsWith("New message")).toBe(true);
    store.close("t1", now());
    tick(RELEASE_HOLD_MS);
    await ch.openThread(openerFor("t3", "Cy Ng"));
    expect(posts()[2]!.from).toBe(P1);
    const reused = bodyOf(posts()[2]!.body);
    expect(reused.split("\n")[0]).toBe("This chat is now about Cy Ng. Messages above are about another customer.");
    expect(reused).toContain(POOL_REPLY_HINT);
  });

  it("follow-ups and reactions go out from the thread's number; notify and unknown refs from the primary", async () => {
    const { ch, posts } = pool();
    await ch.openThread(openerFor("t1", "Ann"));
    const { provider_ref: ref2 } = await ch.openThread(openerFor("t2", "Bea"));
    await ch.postToThread(ref2, "Follow-up from the assistant");
    await ch.acknowledge(ref2, "wamid.in9");
    await ch.notify("Agent booking: Ann");
    await ch.postToThread("wamid.from-before-the-pool", "Follow-up");
    expect(posts().slice(2).map((p) => [p.from, p.body.type])).toEqual([
      [P2, "text"],
      [P2, "reaction"],
      [P1, "text"],
      [P1, "text"],
    ]);
  });

  it("checkAccess reads every number and names the one that fails; an open thread on a removed number is warned about once", async () => {
    const store = new FakePoolStore();
    store.rows.set("old", { thread_id: "old", number_id: "333333333333333", owner: OWNER_WA, reused: false, accepted_at_ms: T0, opener: "wamid.old", read_at_ms: null, confirmed_at_ms: null, closed_at_ms: null });
    const good = meta((req) => new Response(JSON.stringify({ id: req.url.split("/").at(-1)!.split("?")[0] })), { pnid: `${P1},${P2}`, store, template: "owner_update" });
    await good.ch.checkAccess();
    await good.ch.start();
    expect(good.reqs.map((r) => r.url.split("/").at(-1)!.split("?")[0])).toEqual([P1, P2]);
    expect(good.logs.filter((l) => l.includes("no longer in WHATSAPP_PHONE_NUMBER_ID"))).toHaveLength(1);
    expect(good.logs[0]).toContain("***3333");
    await good.ch.postToThread("wamid.old", "late").catch(() => {}); // this fake answers no message id
    expect(good.reqs.at(-1)!.url).toContain(`/${P1}/messages`);
    const bad = meta((req) => (req.url.includes(P2) ? graphError(100) : new Response(JSON.stringify({ id: P1 }))), { pnid: `${P1},${P2}`, store: new FakePoolStore(), template: "owner_update" });
    const e = await bad.ch.checkAccess().catch((x: unknown) => x);
    expect((e as ConnectorError).code).toBe("channel_rejected");
    expect((e as ConnectorError).message).toContain(`Phone number ID ${P2}`);
  });

  it("refuses a bad id list, a pool without a template, and a pool without a store", () => {
    const base = { whatsapp_access_token: "t", whatsapp_app_secret: "s", whatsapp_verify_token: "v", owner_phone: OWNER, whatsapp_template: "owner_update" };
    expect(() => createWhatsappChannel({ ...base, whatsapp_phone_number_id: "1,abc" })).toThrow(/numeric Phone number IDs/);
    expect(() => createWhatsappChannel({ ...base, whatsapp_template: undefined, whatsapp_phone_number_id: "1,2" }, { store: new FakePoolStore() })).toThrow(/needs WHATSAPP_TEMPLATE/);
    expect(() => createWhatsappChannel({ ...base, whatsapp_phone_number_id: "1,2" })).toThrow(/number pool/);
    expect(createWhatsappChannel({ ...base, whatsapp_phone_number_id: "1,2" }, { store: new FakePoolStore() })).toBeDefined();
    expect(createWhatsappChannel({ ...base, whatsapp_phone_number_id: " 1, ,1 " })).toBeDefined(); // one number after parsing
  });
});

describe("whatsappOwnerChannel: number pool, routing", () => {
  it("a plain reply in a fresh chat is scoped until 5 s after the opener was accepted, then routed to it", async () => {
    const { ch, handled, store } = pool();
    const { provider_ref } = await ch.openThread(openerFor("t1", "Ann"));
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes", { timestamp: ts(T0 + 4_000) })], { pnid: P1 }));
    await ch.webhook.handle(delivery([text("wamid.in2", "3pm works", { timestamp: ts(T0 + 6_000) })], { pnid: P1 }));
    expect(handled).toEqual([
      { provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes", sent_at_ms: T0 + 4_000, scope_refs: [provider_ref] },
      { provider_ref, provider_msg_id: "wamid.in2", user_id: OWNER_WA, text: "3pm works", sent_at_ms: T0 + 6_000 },
    ]);
    expect(store.windows.get(`${P1}:${OWNER_WA}`)).toBe(T0 + 6_000);
  });

  it("a plain reply in a reused chat is scoped until the owner read the opener, then routed", async () => {
    const { ch, handled, store, tick, now } = pool();
    await ch.openThread(openerFor("t1", "Ann"));
    await ch.openThread(openerFor("t2", "Bea"));
    store.close("t1", now());
    tick(RELEASE_HOLD_MS);
    const { provider_ref } = await ch.openThread(openerFor("t3", "Cy"));
    expect(store.rows.get("t3")).toMatchObject({ number_id: P1, reused: true });
    const later = now() + 60_000;
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes", { timestamp: ts(later) })], { pnid: P1 }));
    expect(handled[0]).toMatchObject({ scope_refs: [provider_ref] });
    expect(handled[0]!.provider_ref).toBeUndefined();
    const read = await ch.webhook.handle(delivery([], { pnid: P1, statuses: [{ id: provider_ref, status: "read", timestamp: ts(later + 1_000), recipient_id: OWNER_WA }] }));
    expect(read.status).toBe(200);
    await ch.webhook.handle(delivery([text("wamid.in2", "Yes", { timestamp: ts(later + 2_000) })], { pnid: P1 }));
    expect(handled[1]).toMatchObject({ provider_ref, provider_msg_id: "wamid.in2" });
    expect(handled[1]!.scope_refs).toBeUndefined();
  });

  it("a read receipt for a follow-up counts for the opener above it", async () => {
    const { ch, handled, store, tick, now } = pool(); // sends answer wamid.o1, wamid.o2, ... in order
    await ch.openThread(openerFor("t1", "Ann"));
    await ch.openThread(openerFor("t2", "Bea"));
    store.close("t1", now());
    tick(RELEASE_HOLD_MS);
    const { provider_ref } = await ch.openThread(openerFor("t3", "Cy"));
    await ch.postToThread(provider_ref, "Follow-up from the assistant:\n\nAlso, Saturday?"); // wamid.o4
    const later = now() + 60_000;
    await ch.webhook.handle(delivery([], { pnid: P1, statuses: [{ id: "wamid.o4", status: "read", timestamp: ts(later), recipient_id: OWNER_WA }] }));
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes", { timestamp: ts(later + 1_000) })], { pnid: P1 }));
    expect(handled[0]).toMatchObject({ provider_ref, provider_msg_id: "wamid.in1" });
  });

  it("a quote in a reused chat routes exactly and confirms the thread, so later plain replies route", async () => {
    const { ch, handled, store, tick, now } = pool();
    await ch.openThread(openerFor("t1", "Ann"));
    await ch.openThread(openerFor("t2", "Bea"));
    store.close("t1", now());
    tick(RELEASE_HOLD_MS);
    const { provider_ref } = await ch.openThread(openerFor("t3", "Cy"));
    const at = now() + 30_000;
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes", { timestamp: ts(at), context: { id: provider_ref } })], { pnid: P1 }));
    expect(store.rows.get("t3")!.confirmed_at_ms).toBe(Math.floor(at / 1000) * 1000);
    await ch.webhook.handle(delivery([text("wamid.in2", "and 3pm", { timestamp: ts(at + 1_000) })], { pnid: P1 }));
    expect(handled.map((m) => m.provider_ref)).toEqual([provider_ref, provider_ref]);
  });

  it("a shared (overflow) chat is always scoped to its open threads; a chat with nothing open is ignored", async () => {
    const { ch, handled, sends } = pool();
    const r1 = (await ch.openThread(openerFor("t1", "Ann"))).provider_ref;
    await ch.openThread(openerFor("t2", "Bea"));
    const r3 = (await ch.openThread(openerFor("t3", "Cy"))).provider_ref;
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes", { timestamp: ts(T0 + 3_600_000) })], { pnid: P1 }));
    expect(handled).toEqual([{ provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes", sent_at_ms: T0 + 3_600_000, scope_refs: [r1, r3] }]);
    const empty = pool();
    await empty.ch.webhook.handle(delivery([text("wamid.in2", "Hello?")], { pnid: P2 }));
    expect(empty.handled).toEqual([]);
    expect(empty.sends()).toEqual([]);
    expect(sends()).toHaveLength(3);
  });

  it("notices go out from the number the owner wrote to; deliveries for numbers outside the pool are skipped", async () => {
    const { ch, posts, handled, setAnswer } = pool();
    await ch.webhook.handle(delivery([{ id: "wamid.img", from: OWNER_WA, timestamp: "1760000000", type: "image", image: { id: "m1" } }], { pnid: P2 }));
    setAnswer("rejected:thread_closed");
    await ch.webhook.handle(delivery([text("wamid.in1", "late", { context: { id: "wamid.x" } })], { pnid: P2 }));
    expect(posts().map((p) => p.from)).toEqual([P2, P2]);
    await ch.webhook.handle(delivery([text("wamid.in2", "hi")], { pnid: "999" }));
    expect(handled).toHaveLength(1);
  });
});

describe("whatsappOwnerChannel: number pool, Which customer?", () => {
  /** Two threads sharing P1 (t1 and the overflow t3) and the owner's plain reply there, through a core that asks. */
  async function asked(script?: Script) {
    const p = pool(script);
    const r1 = (await p.ch.openThread(openerFor("t1", "Ann"))).provider_ref;
    await p.ch.openThread(openerFor("t2", "Bea"));
    const r3 = (await p.ch.openThread(openerFor("t3", "Cy"))).provider_ref;
    const core: OwnerInboundMessage[] = [];
    p.ch.onOwnerMessage(askingCore(p.ch, core, { [r1]: "Ann", [r3]: "Cy" }));
    const res = await p.ch.webhook.handle(delivery([text("wamid.in1", "Yes, 3pm works", { timestamp: ts(T0 + 60_000) })], { pnid: P1 }));
    return { ...p, r1, r3, core, res };
  }

  it("asks with reply buttons from the receiving number and stores the question; a redelivery does not ask twice", async () => {
    const { ch, posts, store, r1, r3, res, now } = await asked();
    expect(res.status).toBe(200);
    const q = posts()[3]!;
    expect(q.from).toBe(P1);
    expect(q.body).toMatchObject({
      to: OWNER_WA,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: 'Which customer is this reply for?\n\n"Yes, 3pm works"' },
        action: { buttons: [{ type: "reply", reply: { id: r1, title: "Ann" } }, { type: "reply", reply: { id: r3, title: "Cy" } }] },
      },
    });
    expect([...store.pending.values()]).toEqual([
      { prompt_wamid: "wamid.o4", orig_wamid: "wamid.in1", text: "Yes, 3pm works", sent_at_ms: T0 + 60_000, number_id: P1, allowed: [r1, r3], expires_at_ms: now() + PENDING_TTL_MS, consumed: false },
    ]);
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes, 3pm works", { timestamp: ts(T0 + 60_000) })], { pnid: P1 }));
    expect(posts()).toHaveLength(4);
  });

  it("a tap replays the original text with the chosen thread and confirms it; a redelivered tap replays the same message id", async () => {
    const { ch, core, store, r1, r3, posts } = await asked();
    await ch.webhook.handle(delivery([tap("wamid.tap1", "wamid.o4", r3, { at: T0 + 70_000 })], { pnid: P1 }));
    expect(core.at(-1)).toEqual({ provider_ref: r3, provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes, 3pm works", sent_at_ms: T0 + 60_000 });
    expect(store.rows.get("t3")!.confirmed_at_ms).toBe(T0 + 70_000);
    // Meta redelivers the tap: the core gets the same original id again and dedups it.
    await ch.webhook.handle(delivery([tap("wamid.tap1", "wamid.o4", r3)], { pnid: P1 }));
    expect(core).toHaveLength(3);
    expect(core.at(-1)!.provider_msg_id).toBe("wamid.in1");
    // A second, different choice on an answered question is ignored.
    await ch.webhook.handle(delivery([tap("wamid.tap2", "wamid.o4", r1)], { pnid: P1 }));
    expect(core).toHaveLength(3);
    expect(posts()).toHaveLength(4); // no notice, nothing sent
  });

  it("a list tap works too, and a tap whose reply was not stored is replayed when Meta redelivers it", async () => {
    const { ch, core, r1 } = await asked();
    let fail = true;
    ch.onOwnerMessage(async (m) => {
      core.push(m);
      if (fail) throw new Error("SQLITE_BUSY");
      return "accepted";
    });
    expect((await ch.webhook.handle(delivery([tap("wamid.tap1", "wamid.o4", r1, { list: true })], { pnid: P1 }))).status).toBe(500);
    fail = false;
    expect((await ch.webhook.handle(delivery([tap("wamid.tap1", "wamid.o4", r1, { list: true })], { pnid: P1 }))).status).toBe(200);
    expect(core.slice(-2).map((m) => [m.provider_ref, m.provider_msg_id, m.text])).toEqual([
      [r1, "wamid.in1", "Yes, 3pm works"],
      [r1, "wamid.in1", "Yes, 3pm works"],
    ]);
  });

  it("an unknown, foreign-chat or expired tap gets one 'send it again' notice from the number tapped in, and is never routed", async () => {
    const { ch, core, posts, r1, tick } = await asked();
    await ch.webhook.handle(delivery([tap("wamid.tapX", "wamid.nope", r1)], { pnid: P1 }));
    await ch.webhook.handle(delivery([tap("wamid.tapX", "wamid.nope", r1)], { pnid: P1 })); // redelivered
    await ch.webhook.handle(delivery([tap("wamid.tapY", "wamid.o4", "wamid.not-offered")], { pnid: P1 }));
    await ch.webhook.handle(delivery([tap("wamid.tapZ", "wamid.o4", r1)], { pnid: P2 }));
    tick(PENDING_TTL_MS);
    await ch.webhook.handle(delivery([tap("wamid.tapW", "wamid.o4", r1)], { pnid: P1 }));
    const notices = posts().slice(4);
    expect(notices.map((p) => [p.from, bodyOf(p.body)])).toEqual([
      [P1, TAP_AGAIN_NOTICE],
      [P1, TAP_AGAIN_NOTICE],
      [P2, TAP_AGAIN_NOTICE],
      [P1, TAP_AGAIN_NOTICE],
    ]);
    expect(core).toHaveLength(1); // only the original, scoped message
  });

  it("when Meta refuses the buttons for good (131047) the plain hint goes out instead; a transient failure answers 500", async () => {
    let n = 0;
    const refused = await asked((req) => (req.body?.type === "interactive" ? graphError(WINDOW_CLOSED_CODE) : ok(`wamid.o${++n}`)));
    expect(refused.res.status).toBe(200);
    expect(refused.posts().slice(3).map((p) => [p.from, p.body.type])).toEqual([
      [P1, "interactive"],
      [P1, "text"],
    ]);
    expect(bodyOf(refused.posts()[4]!.body)).toBe(PICKER_FALLBACK_HINT);
    expect(refused.store.pending.size).toBe(0);
    let m = 0;
    const down = await asked((req) => (req.body?.type === "interactive" ? graphError(2, 503) : ok(`wamid.o${++m}`)));
    expect(down.res.status).toBe(500);
    const noStore = await asked();
    noStore.store.failOn = "waPutPending";
    expect((await noStore.ch.webhook.handle(delivery([text("wamid.in5", "Yes")], { pnid: P1 }))).status).toBe(500);
  });

  it("4 to 10 choices are a list with cut, distinct titles; more than 10 get the plain hint", async () => {
    const { ch, posts } = pool();
    await ch.openThread(openerFor("t1", "Ann"));
    await ch.openThread(openerFor("t2", "Bea")); // on P2, fresh: a reply at once is scoped
    const choices: ThreadChoice[] = Array.from({ length: 4 }, (_, i) => ({
      provider_ref: `wamid.r${i}`,
      thread_id: `t${i}`,
      title: i < 2 ? "Alexandra Konstantinopoulou-Smith" : `Bo ${i}`,
      detail: "x".repeat(100),
    }));
    let asks = 0;
    ch.onOwnerMessage(async (m) => {
      await ch.askWhichThread!(m, asks++ === 0 ? choices : Array.from({ length: 11 }, (_, i) => ({ provider_ref: `wamid.r${i}`, thread_id: `t${i}`, title: `C${i}` })));
      return "ignored";
    });
    await ch.webhook.handle(delivery([text("wamid.in1", "Yes")], { pnid: P2 }));
    const list = posts()[2]!;
    expect(list.from).toBe(P2);
    const interactive = list.body.interactive as { type: string; action: { button: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description: string }> }> } };
    expect(interactive.type).toBe("list");
    expect(interactive.action.button.length).toBeLessThanOrEqual(20);
    const rows = interactive.action.sections[0]!.rows;
    expect(rows.map((r) => r.id)).toEqual(["wamid.r0", "wamid.r1", "wamid.r2", "wamid.r3"]);
    expect(new Set(rows.map((r) => r.title)).size).toBe(4);
    expect(rows.every((r) => Array.from(r.title).length <= 24 && Array.from(r.description).length <= 72)).toBe(true);
    await ch.webhook.handle(delivery([text("wamid.in2", "Yes")], { pnid: P2 }));
    expect([posts()[3]!.from, bodyOf(posts()[3]!.body)]).toEqual([P2, PICKER_FALLBACK_HINT]);
  });

  it("titles are cut by code point, never through an emoji, and made unique", () => {
    expect(clipLine("Zoë 👩‍🔧👩‍🔧👩‍🔧👩‍🔧👩‍🔧", 8)).toBe(Array.from("Zoë 👩‍🔧👩‍🔧").slice(0, 7).join("") + "…");
    expect(Array.from(clipLine("😀".repeat(30), 20))).toHaveLength(20);
    expect(distinctTitles(["Alexandra Konstantinou A", "Alexandra Konstantinou B", "Bo"], 20)).toEqual(["Alexandra Konsta… #1", "Alexandra Konsta… #2", "Bo"]);
  });
});

describe("server wiring: the owner channel gets the store", () => {
  it("createOwnerChannel refuses a WhatsApp pool without a store and builds it with one", () => {
    const settings = { whatsapp_access_token: "t", whatsapp_phone_number_id: `${P1},${P2}`, whatsapp_app_secret: "s", whatsapp_verify_token: "v", owner_phone: OWNER, whatsapp_template: "owner_update" } as unknown as RuntimeSettings;
    const connector = {} as BookingConnector;
    expect(() => createOwnerChannel(settings, connector)).toThrow(/number pool/);
    const ch = createOwnerChannel(settings, connector, { store: openStore(":memory:") });
    expect(ch?.flat).toBe(true);
    expect(typeof ch?.askWhichThread).toBe("function");
  });
});
