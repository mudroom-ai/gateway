// WhatsApp owner channel against a scripted fake of Meta's Cloud API (never the live one):
// the send shapes, the 24-hour window fallback, every channel_* code, and the webhook
// (handshake, signature, quote and plain replies, strangers, non-text, redelivery).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError, type InboundWebhookRequest, type OwnerInboundMessage, type OwnerMessageHandler } from "../src/connectors/types.js";
import { createWhatsappChannel, parseTemplate, templateParam, waNumber, whatsappOwnerChannel, WHATSAPP_WEBHOOK_PATH, WINDOW_CLOSED_CODE } from "../src/connectors/whatsapp.js";

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
function meta(script: Script = () => ok(), opts: { template?: string } = {}) {
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
    { whatsapp_access_token: "tok", whatsapp_phone_number_id: PNID, whatsapp_app_secret: SECRET, whatsapp_verify_token: VERIFY, owner_phone: OWNER, whatsapp_template: opts.template },
    { fetch: fetchImpl, warn: (m) => logs.push(m), timeoutMs: 50 },
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
function delivery(messages: Record<string, unknown>[], o: { signature?: string; pnid?: string; field?: string; raw?: string } = {}): InboundWebhookRequest {
  const raw = o.raw ?? JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: o.field ?? "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: o.pnid ?? PNID }, messages } }] }] });
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
    expect((e3 as ConnectorError).message).toContain("not in allowed list");
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
    expect((e as ConnectorError).message).toContain("100");
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

  it("a plain reply has no provider_ref; a quote of an unknown message is tried by its id, then as a plain reply", async () => {
    const { ch, handled, setAnswer } = meta();
    expect((await ch.webhook.handle(delivery([text("wamid.in1", "Yes")]))).status).toBe(200);
    expect(handled).toEqual([{ provider_msg_id: "wamid.in1", user_id: OWNER_WA, text: "Yes", sent_at_ms: 1760000000000 }]);
    handled.length = 0;
    setAnswer("ignored");
    await ch.webhook.handle(delivery([text("wamid.in2", "Yes", { context: { id: "wamid.forgotten" } })]));
    expect(handled.map((m) => m.provider_ref)).toEqual(["wamid.forgotten", undefined]);
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
