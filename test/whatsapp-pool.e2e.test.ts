// WhatsApp number pool end to end: the real core (createMessageOps), the real SQLite store (in memory) and the real
// WhatsApp channel over a scripted fake of Meta's Cloud API (never the live one), with a pool of two numbers.
// Driven only through the public surfaces: leave_message / get_thread / close_thread on the ops, and signed webhook
// deliveries into the channel. One clock is shared by the ops, the channel and the owner's Meta timestamps.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { FLAT_REPLY_HINT, type InboundWebhookRequest } from "../src/connectors/types.js";
import { createWhatsappChannel, POOL_REPLY_HINT, PICKER_PROMPT, type WhatsappChannel } from "../src/connectors/whatsapp.js";
import { RELEASE_HOLD_MS } from "../src/connectors/whatsapp-pool.js";
import { CLOSE_NOTICE, createMessageOps, type MessageOps, type Timers } from "../src/messages.js";
import { Store } from "../src/store/sqlite.js";

const OWNER = "+1 202 555 0199";
const OWNER_WA = "12025550199";
const P1 = "111111111111111";
const P2 = "222222222222222";
const SECRET = "app-secret";

/** One message the gateway sent to Meta: the pool number it went from (the URL path), the payload, and the wamid Meta gave it. */
type Sent = { from: string; body: Record<string, unknown>; wamid: string };

/** Meta's whole-second timestamp, as a string, like the real webhook. */
const ts = (ms: number) => String(Math.floor(ms / 1000));
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** A signed webhook delivery for pool number `pnid`: owner messages and/or delivery statuses. */
function delivery(pnid: string, o: { messages?: Record<string, unknown>[]; statuses?: Record<string, unknown>[] }): InboundWebhookRequest {
  const value = { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: pnid }, ...o };
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value }] }] });
  return { method: "POST", query: {}, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, rawBody: Buffer.from(raw) };
}
const plain = (id: string, body: string, atMs: number) => ({ id, from: OWNER_WA, timestamp: ts(atMs), type: "text", text: { body } });
const tapOn = (id: string, promptWamid: string, chosenRef: string, atMs: number) => ({
  context: { from: "15550000000", id: promptWamid },
  from: OWNER_WA,
  id,
  timestamp: ts(atMs),
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: chosenRef, title: "x" } },
});
const read = (wamid: string, atMs: number) => ({ id: wamid, status: "read", timestamp: ts(atMs), recipient_id: OWNER_WA });

/** Store, scripted Meta and clock outlive a "restart"; boot() builds a fresh channel and fresh ops on top of them. */
function world() {
  const config = parseConfig({
    merchant_id: "m1",
    name: "Paws",
    timezone: "America/Los_Angeles",
    currency: "USD",
    hours: {},
    limits: { max_messages_per_hour: 1000, per_contact_per_hour: 1000 },
  });
  const store = new Store(":memory:");
  let nowMs = Date.parse("2026-10-15T17:00:00Z");
  const sent: Sent[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const from = String(url).split("/").at(-2)!;
    const wamid = `wamid.s${++n}`;
    sent.push({ from, body: JSON.parse(String(init?.body)) as Record<string, unknown>, wamid });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: OWNER_WA }], messages: [{ id: wamid }] }), { status: 200 });
  };
  // The sweep timer is never fired here: the test runs ops.sweep() itself when it needs one.
  const timers: Timers = { setInterval: () => ({}), clearInterval: () => {}, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const warns: string[] = [];

  async function boot(): Promise<{ channel: WhatsappChannel; ops: MessageOps }> {
    const channel = createWhatsappChannel(
      { whatsapp_access_token: "tok", whatsapp_phone_number_id: `${P1},${P2}`, whatsapp_app_secret: SECRET, whatsapp_verify_token: "verify-me", owner_phone: OWNER, whatsapp_template: "owner_update" },
      { fetch: fetchImpl, store, now: () => nowMs, warn: (m) => warns.push(m) },
    )!;
    const ops = createMessageOps({ config, store, channel, settings: { messages_enabled: true }, now: () => new Date(nowMs), timers, log: () => {} })!;
    await ops.start(); // registers the core's owner handler with the channel, as the server does
    return { channel, ops };
  }

  return {
    store,
    sent,
    warns,
    boot,
    now: () => nowMs,
    advance: (ms: number) => void (nowMs += ms),
  };
}

type W = ReturnType<typeof world>;
type Thread = { thread_id: string; read_token: string; ref: string; acceptedAt: number };

/** leave_message for a new customer; the thread's opener wamid (provider_ref) comes from the store. */
async function leave(w: W, ops: MessageOps, name: string): Promise<Thread> {
  const acceptedAt = w.now();
  const r = await ops.leaveMessage({ customer: { name, email: `${name.toLowerCase()}@example.com` }, message: `${name} asks: do you groom cats?` });
  if (!r.ok) throw new Error(`leave_message failed: ${r.error.code}`);
  expect(r.data.delivery).toBe("delivered");
  return { thread_id: r.data.thread_id, read_token: r.data.read_token, ref: w.store.getThread(r.data.thread_id)!.provider_ref!, acceptedAt };
}

/** The owner's messages on a thread, as get_thread shows them to the agent. */
async function ownerSaid(ops: MessageOps, t: Thread): Promise<string[]> {
  const r = await ops.getThread({ thread_id: t.thread_id, read_token: t.read_token });
  if (!r.ok) throw new Error(`get_thread failed: ${r.error.code}`);
  return r.data.messages.filter((m) => m.from === "owner").map((m) => m.text);
}

async function post(ch: WhatsappChannel, req: InboundWebhookRequest): Promise<void> {
  const res = await ch.webhook.handle(req);
  expect(res.status).toBe(200);
}

/** Lets fire-and-forget sends (close notice, reactions) reach the fake. */
const settle = () => new Promise((r) => setImmediate(r));

const textOf = (s: Sent) => (s.body.text as { body: string } | undefined)?.body ?? "";
const openerOf = (w: W, t: Thread) => w.sent.find((s) => s.body.type === "text" && textOf(s).includes(`(thread ${t.thread_id})`))!;
const pickers = (w: W) => w.sent.filter((s) => s.body.type === "interactive");
const buttonIds = (s: Sent) => ((s.body.interactive as { action: { buttons: { reply: { id: string } }[] } }).action.buttons ?? []).map((b) => b.reply.id);

describe("WhatsApp number pool, end to end (core + SQLite store + channel, two numbers)", () => {
  it("separate chats, overflow, the picker, release after the hold and the read-receipt gate on a reused number", async () => {
    const w = world();
    const { channel, ops } = await w.boot();

    // 1. Two customers get a never-used number each; the opener says the chat is only about them.
    const t1 = await leave(w, ops, "Ann");
    const t2 = await leave(w, ops, "Bea");
    expect(openerOf(w, t1).from).toBe(P1);
    expect(openerOf(w, t2).from).toBe(P2);
    for (const t of [t1, t2]) {
      expect(textOf(openerOf(w, t))).toContain(POOL_REPLY_HINT);
      expect(textOf(openerOf(w, t))).not.toContain(FLAT_REPLY_HINT);
      expect(textOf(openerOf(w, t))).not.toContain("This chat is now about");
    }

    // 2. A plain reply in Ann's chat, 6 s after her opener was accepted (fresh number, one open thread), goes straight to her.
    w.advance(10_000);
    await post(channel, delivery(P1, { messages: [plain("wamid.in1", "Yes, we groom cats.", t1.acceptedAt + 6_000)] }));
    expect(await ownerSaid(ops, t1)).toEqual(["Yes, we groom cats."]);
    expect(await ownerSaid(ops, t2)).toEqual([]);
    await settle();
    expect(w.sent.filter((s) => s.body.type === "reaction").map((s) => ({ from: s.from, on: (s.body.reaction as { message_id: string }).message_id }))).toEqual([{ from: P1, on: "wamid.in1" }]);

    // 3. No free number for a third customer: overflow onto the busiest chat, ties to the primary (Ann's, P1).
    //    The chat is now shared, so the opener keeps the swipe-to-reply wording.
    const t3 = await leave(w, ops, "Cy");
    expect(openerOf(w, t3).from).toBe(P1);
    expect(textOf(openerOf(w, t3))).toContain(FLAT_REPLY_HINT);
    expect(textOf(openerOf(w, t3))).not.toContain(POOL_REPLY_HINT);

    // A plain reply in the shared chat is never guessed: "Which customer?" from that number, nothing stored yet.
    w.advance(30_000);
    await post(channel, delivery(P1, { messages: [plain("wamid.in2", "Cy: Tuesday 3pm is free.", w.now())] }));
    expect(pickers(w)).toHaveLength(1);
    const picker = pickers(w)[0]!;
    expect(picker.from).toBe(P1);
    expect((picker.body.interactive as { body: { text: string } }).body.text).toContain(PICKER_PROMPT);
    expect(buttonIds(picker)).toEqual([t1.ref, t3.ref]);
    expect(await ownerSaid(ops, t3)).toEqual([]);
    expect(await ownerSaid(ops, t1)).toEqual(["Yes, we groom cats."]);

    // The owner taps Cy: the original text lands on Cy's thread only.
    w.advance(5_000);
    await post(channel, delivery(P1, { messages: [tapOn("wamid.tap1", picker.wamid, t3.ref, w.now())] }));
    expect(await ownerSaid(ops, t3)).toEqual(["Cy: Tuesday 3pm is free."]);
    expect(await ownerSaid(ops, t1)).toEqual(["Yes, we groom cats."]);
    expect(await ownerSaid(ops, t2)).toEqual([]);

    // 4. Bea's thread closes; its chat (P2) now has nothing open. The close notice goes out from P2 at once.
    const closed = await ops.closeThread({ thread_id: t2.thread_id, read_token: t2.read_token });
    expect(closed.ok && closed.data.status).toBe("closed");
    await settle();
    const notice = w.sent.findIndex((s) => textOf(s) === CLOSE_NOTICE);
    expect(notice).toBeGreaterThan(-1);
    expect(w.sent[notice]!.from).toBe(P2);

    // After the release hold, with nothing in flight in the outbox, a new customer reuses P2, and the opener says so.
    w.advance(RELEASE_HOLD_MS + 1_000);
    await ops.sweep();
    expect(w.store.outboxCounts()).toEqual({ queued: 0, failed: 0 });
    const t4 = await leave(w, ops, "Di");
    const opener4 = openerOf(w, t4);
    expect(opener4.from).toBe(P2);
    expect(textOf(opener4)).toMatch(/^This chat is now about Di\. Messages above are about another customer\.\n\n/);
    expect(textOf(opener4)).toContain(POOL_REPLY_HINT);
    // Bea's close notice reached the chat before Di's opener.
    expect(notice).toBeLessThan(w.sent.indexOf(opener4));

    // 5. A reused chat routes plain replies only once confirmed: without a read receipt, the picker (from P2), not Di.
    await post(channel, delivery(P2, { messages: [plain("wamid.in3", "Hi Di, which day suits?", t4.acceptedAt + 30_000)] }));
    expect(pickers(w)).toHaveLength(2);
    expect(pickers(w)[1]!.from).toBe(P2);
    expect(buttonIds(pickers(w)[1]!)).toEqual([t4.ref]);
    expect(await ownerSaid(ops, t4)).toEqual([]);

    // Meta reports the owner read Di's opener; the next plain reply goes straight to Di, no new picker.
    await post(channel, delivery(P2, { statuses: [read(t4.ref, t4.acceptedAt + 40_000)] }));
    await post(channel, delivery(P2, { messages: [plain("wamid.in4", "Thursday at 10 works.", t4.acceptedAt + 50_000)] }));
    expect(await ownerSaid(ops, t4)).toEqual(["Thursday at 10 works."]);
    expect(pickers(w)).toHaveLength(2);
    expect(await ownerSaid(ops, t3)).toEqual(["Cy: Tuesday 3pm is free."]);

    await ops.stop();
  });

  it("a restart between the picker and the tap still routes the original reply (the question is in the store)", async () => {
    const w = world();
    const first = await w.boot();
    // A second apart, so the buttons' oldest-first order is fixed (equal creation times tie on the random thread id).
    const t1 = await leave(w, first.ops, "Ann");
    w.advance(1_000);
    await leave(w, first.ops, "Bea");
    w.advance(1_000);
    const t3 = await leave(w, first.ops, "Cy"); // overflow onto P1, shared with Ann
    w.advance(60_000);
    await post(first.channel, delivery(P1, { messages: [plain("wamid.in1", "Ann: bring the vaccination card.", w.now())] }));
    const picker = pickers(w)[0]!;
    expect(buttonIds(picker)).toEqual([t1.ref, t3.ref]);
    expect(await ownerSaid(first.ops, t1)).toEqual([]);

    // Restart: a new channel and new ops on the same database; nothing in memory survives.
    await first.ops.stop();
    const second = await w.boot();
    w.advance(120_000);
    await post(second.channel, delivery(P1, { messages: [tapOn("wamid.tap1", picker.wamid, t1.ref, w.now())] }));
    expect(await ownerSaid(second.ops, t1)).toEqual(["Ann: bring the vaccination card."]);
    expect(await ownerSaid(second.ops, t3)).toEqual([]);
    await settle();
    // The ✅ goes out from Ann's chat, where the owner typed.
    expect(w.sent.filter((s) => s.body.type === "reaction").map((s) => s.from)).toEqual([P1]);

    await second.ops.stop();
  });
});
