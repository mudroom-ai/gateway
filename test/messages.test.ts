// leave_message core (src/messages.ts) against an in-memory fake CommunicationConnector.
// Value: protects=every thread transition cell, every message error code, idempotency under concurrency,
//   D5 hybrid send failure (queued vs refused), outbox retry schedule, caps, owner close, one-way mode;
//   fails_when=a transition, a cap, a retry delay or a failure classification changes; why_new=replaces the
//   untested first version; seam=CommunicationConnector thread members (fake here, Slack in test/slack.test.ts)
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ConnectorError, type ChannelContext, type CommunicationConnector, type OwnerMessageHandler, type PostedQuery, type ThreadOpener } from "../src/connectors/types.js";
import { runOp } from "../src/adapters/http.js";
import { CLOSE_NOTICE, createMessageOps, MAX_AGENT_MESSAGES, MIRROR_PREFIX, SEVERAL_WAITING_HINT, transition, TRANSITIONS, type MessageOps, type Timers } from "../src/messages.js";
import { Store } from "../src/store/sqlite.js";
import type { Booking, Service } from "../src/types.js";

class FakeChannel implements CommunicationConnector {
  opened: ThreadOpener[] = [];
  posts: { ref: string; text: string }[] = [];
  notices: string[] = [];
  acks: string[] = [];
  /** Errors thrown by the next sends, in order. */
  failNext: unknown[] = [];
  /** Thrown by every send while set. */
  failAll: unknown = undefined;
  gate: Promise<void> | undefined;
  handler: OwnerMessageHandler | undefined;
  ctx: ChannelContext | undefined;
  /** findPosted calls, and what it answers: a message id, null (not there) or an error to throw. */
  lookups: PostedQuery[] = [];
  found: string | null | Error = null;
  started = false;
  stopped = false;
  private n = 0;

  async notify(m: string) {
    this.notices.push(m);
  }
  private async maybeFail() {
    await this.gate;
    if (this.failAll) throw this.failAll;
    const e = this.failNext.shift();
    if (e) throw e;
  }
  async openThread(o: ThreadOpener) {
    await this.maybeFail();
    this.opened.push(o);
    return { provider_ref: `ts.${++this.n}` };
  }
  async postToThread(ref: string, text: string) {
    await this.maybeFail();
    this.posts.push({ ref, text });
  }
  async findPosted(q: PostedQuery) {
    this.lookups.push(q);
    if (this.found instanceof Error) throw this.found;
    return this.found;
  }
  onOwnerMessage(h: OwnerMessageHandler, ctx?: ChannelContext) {
    this.handler = h;
    this.ctx = ctx;
  }
  async acknowledge(_ref: string, id: string) {
    this.acks.push(id);
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  status() {
    return { connected: true };
  }
}

const SERVICES: Service[] = [{ id: "bath", name: "Dog bath", duration_min: 60, buffer_min: 0, price_cents: 5000 }];
const ANN = { name: "Ann Lee", phone: "+1 202 555 0199" };
const unavailable = () => new ConnectorError("channel_unavailable", "slack 503");
const authFailed = () => new ConnectorError("channel_auth_failed", "invalid_auth: SLACK_BOT_TOKEN is wrong");

function setup(opts: { limits?: Record<string, number>; enabled?: boolean; channel?: CommunicationConnector | null } = {}) {
  const config = parseConfig({
    merchant_id: "m1",
    name: "Paws",
    timezone: "America/Los_Angeles",
    currency: "USD",
    hours: {},
    limits: { max_messages_per_hour: 1000, per_contact_per_hour: 1000, ...opts.limits },
  });
  const store = new Store(":memory:");
  const channel = opts.channel === undefined ? new FakeChannel() : opts.channel;
  let nowMs = Date.parse("2026-10-08T17:00:00Z");
  const logs: string[] = [];
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers: Timers = {
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => void ((h as { cleared: boolean }).cleared = true),
    setTimeout: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      timeouts.push(h);
      return h;
    },
    clearTimeout: (h) => void ((h as { cleared: boolean }).cleared = true),
  };
  const ops = createMessageOps({
    config,
    store,
    channel: channel ?? undefined,
    settings: { messages_enabled: opts.enabled ?? true },
    listServices: async () => SERVICES,
    now: () => new Date(nowMs),
    timers,
    log: (l) => logs.push(l),
  }) as MessageOps;
  return {
    ops,
    store,
    channel: channel as FakeChannel,
    logs,
    intervals,
    timeouts,
    /** Fire every pending hold timer, as if the wait ran out. */
    fireTimeouts: () => timeouts.filter((h) => !h.cleared).forEach((h) => ((h.cleared = true), h.fn())),
    advance: (ms: number) => (nowMs += ms),
  };
}

const leave = (ops: MessageOps, over: Record<string, unknown> = {}) =>
  ops.leaveMessage({ customer: ANN, message: "Do you groom cats?", ...over } as never);

async function leaveOk(ops: MessageOps, over: Record<string, unknown> = {}) {
  const r = await leave(ops, over);
  if (!r.ok) throw new Error(`leave failed: ${r.error.code}`);
  return r.data;
}

const flush = () => new Promise<void>((r) => setImmediate(r));
const codeOf = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);
const threadCount = (store: Store) => (store.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;

describe("thread state machine", () => {
  const cells = [
    ["awaiting_owner", "agent_message", "awaiting_owner"],
    ["awaiting_owner", "agent_close", "closed"],
    ["answered", "agent_close", "closed"],
    ["closed", "agent_close", "closed (noop)"],
    ["awaiting_owner", "owner_reply", "answered"],
    ["awaiting_owner", "owner_close", "closed"],
    ["awaiting_owner", "expire", "closed"],
    ["answered", "agent_message", "awaiting_owner"],
    ["answered", "owner_reply", "answered"],
    ["answered", "owner_close", "closed"],
    ["answered", "expire", "closed"],
    ["closed", "agent_message", "thread_closed"],
    ["closed", "owner_reply", "thread_closed"],
    ["closed", "owner_close", "closed (noop)"],
    ["closed", "expire", "closed (noop)"],
  ] as const;

  it("covers every cell of the table", () => {
    const n = Object.values(TRANSITIONS).reduce((a, row) => a + Object.keys(row).length, 0);
    expect(cells.length).toBe(n);
  });

  it.each(cells)("%s + %s -> %s", (from, event, want) => {
    const t = transition(from, event);
    if (want === "thread_closed") expect(t).toEqual({ ok: false, reason: "thread_closed" });
    else if (want === "closed (noop)") expect(t).toEqual({ ok: true, state: "closed", changed: false });
    else expect(t).toEqual({ ok: true, state: want, changed: want !== from });
  });
});

describe("leave_message", () => {
  it("opens a thread in the owner's channel and returns the token once", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops, { service_id: "bath" });
    expect(r).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60, delivery: "delivered", owner_replies_in_band: true });
    expect(r.read_token.length).toBeGreaterThan(20);
    expect(r.messages).toEqual([{ from: "agent", text: "Do you groom cats?", at: expect.stringMatching(/-07:00$/) }]);
    const opener = channel.opened[0]!;
    expect(opener.thread_id).toBe(r.thread_id);
    expect(opener.text).toContain("Ann Lee (+1 202 555 0199)");
    expect(opener.text).toContain("About: Dog bath");
    // Owners never manage the thread: nothing in the opener asks them to close it.
    expect(opener.text).not.toMatch(/close|done/i);
    // Owners learn to answer in the thread, not the channel.
    expect(opener.text).toContain("Reply in this thread");

    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data.thread_id).toBe(r.thread_id);
    expect(g.ok && "read_token" in g.data).toBe(false);
  });

  it.each([
    ["no name", { customer: { phone: "+1 202 555 0199" } }, "invalid_customer"],
    ["no contact", { customer: { name: "Ann" } }, "invalid_customer"],
    ["no message", { message: undefined }, "invalid_message"],
    ["blank message", { message: "   " }, "invalid_message"],
    ["1001 code points", { message: "🐈".repeat(1001) }, "invalid_message"],
    ["control character", { message: "hi\u0007" }, "invalid_message"],
    ["empty idempotency_key", { idempotency_key: "" }, "invalid_request"],
    ["256-char idempotency_key", { idempotency_key: "k".repeat(256) }, "invalid_request"],
    ["unknown service", { service_id: "nails" }, "unknown_service"],
  ])("rejects %s", async (_name, over, code) => {
    const { ops, store, channel } = setup();
    expect(codeOf(await leave(ops, over))).toBe(code);
    expect(threadCount(store)).toBe(0);
    expect(channel.opened).toEqual([]);
  });

  it("accepts 1000 code points of emoji (length is counted in code points, after NFC)", async () => {
    const { ops } = setup();
    expect(codeOf(await leave(ops, { message: "🐈".repeat(1000) }))).toBe("ok");
  });

  it("same idempotency_key and body returns the same thread; a different body conflicts", async () => {
    const { ops, store, channel } = setup();
    const a = await leaveOk(ops, { idempotency_key: "k1" });
    const b = await leaveOk(ops, { idempotency_key: "k1" });
    expect(b.thread_id).toBe(a.thread_id);
    expect(b.read_token).toBe(a.read_token);
    expect(channel.opened).toHaveLength(1);
    expect(codeOf(await leave(ops, { idempotency_key: "k1", message: "something else" }))).toBe("idempotency_conflict");
    expect(threadCount(store)).toBe(1);
  });

  it("concurrent requests with one key yield one thread: one 201, one message_in_progress, then the stored result", async () => {
    const { ops, store, channel } = setup();
    let release!: () => void;
    channel.gate = new Promise((r) => (release = r));
    const first = leave(ops, { idempotency_key: "k" });
    const second = await leave(ops, { idempotency_key: "k" });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toMatchObject({ code: "message_in_progress", retryable: true });
    release();
    const a = await first;
    expect(a.ok).toBe(true);
    const third = await leave(ops, { idempotency_key: "k" });
    expect(third.ok && a.ok && third.data.thread_id === a.data.thread_id).toBe(true);
    expect(threadCount(store)).toBe(1);
    expect(channel.opened).toHaveLength(1);
  });

  it("transient channel failure stores the thread, answers delivery queued, and the sweep delivers it 30 s later", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failNext.push(unavailable());
    const r = await leaveOk(ops);
    expect(r.delivery).toBe("queued");
    expect(threadCount(store)).toBe(1);

    advance(29_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(0);
    advance(1_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(1);
    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data.delivery).toBe("delivered");
    expect(store.getThread(r.thread_id)!.provider_ref).toBe("ts.1");
  });

  it("retries 5 times (30 s, 1, 2, 4, 8 min), then marks the message failed", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failAll = unavailable();
    const r = await leaveOk(ops);
    for (const wait of [30_000, 60_000, 120_000, 240_000, 480_000]) {
      advance(wait - 1);
      await ops.sweep();
      expect(store.listOutbox(r.thread_id)[0]!.state).toBe("queued");
      advance(1);
      await ops.sweep();
    }
    expect(store.listOutbox(r.thread_id)[0]).toMatchObject({ state: "failed", attempts: 6 });
    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data.delivery).toBe("failed");
    expect(store.readLog().some((l) => l.outcome === "message_failed")).toBe(true);
  });

  it("a send that timed out but reached the channel is found on the retry and not posted again", async () => {
    const { ops, store, channel, advance, logs } = setup();
    channel.failNext.push(unavailable()); // the gateway saw a timeout; the channel has the message as ts.77
    const r = await leaveOk(ops);
    expect(channel.lookups).toEqual([]); // the first attempt posts without looking
    channel.found = "ts.77";
    advance(30_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(0);
    expect(channel.lookups).toEqual([{ dedupe_key: `${r.thread_id}:${store.listOutbox(r.thread_id)[0]!.id}`, provider_ref: undefined, since_ms: Date.parse("2026-10-08T17:00:00Z") }]);
    expect(store.getThread(r.thread_id)!.provider_ref).toBe("ts.77");
    expect(store.outboxCounts()).toEqual({ queued: 0, failed: 0 });
    expect(logs.some((l) => l.includes("reconciled (already posted)"))).toBe(true);
  });

  it("a follow-up left in sending by a crash is looked up in its thread after the restart and not posted again", async () => {
    const { ops, store, channel } = setup();
    const r = await leaveOk(ops);
    channel.failNext.push(unavailable());
    await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "Also, do you trim nails?" });
    store.db.exec("UPDATE owner_outbox SET state = 'sending', next_at_ms = NULL WHERE kind = 'post'"); // died before the checkpoint
    store.resetSendingOutbox(); // what opening the store does at boot
    channel.found = "ts.9";
    await ops.sweep();
    expect(channel.posts).toHaveLength(0);
    expect(channel.lookups).toHaveLength(1);
    expect(channel.lookups[0]).toMatchObject({ provider_ref: "ts.1", dedupe_key: `${r.thread_id}:${store.listOutbox(r.thread_id)[1]!.id}` });
    expect(store.outboxCounts()).toEqual({ queued: 0, failed: 0 });
  });

  it("the retry posts with the row's dedupe key when the lookup finds nothing", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failNext.push(unavailable());
    const r = await leaveOk(ops);
    advance(30_000);
    await ops.sweep();
    expect(channel.lookups).toHaveLength(1);
    expect(channel.opened.map((o) => o.dedupe_key)).toEqual([`${r.thread_id}:${store.listOutbox(r.thread_id)[0]!.id}`]);
  });

  it("when the lookup keeps failing nothing is posted and the message ends failed", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failNext.push(unavailable());
    const r = await leaveOk(ops);
    channel.found = unavailable();
    for (const wait of [30_000, 60_000, 120_000, 240_000, 480_000]) {
      advance(wait);
      await ops.sweep();
    }
    expect(channel.opened).toHaveLength(0);
    expect(store.listOutbox(r.thread_id)[0]).toMatchObject({ state: "failed", attempts: 6 });
  });

  it("a provider Retry-After longer than the backoff wins", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failNext.push(new ConnectorError("channel_unavailable", "429", { retry_after_s: 90 }));
    await leaveOk(ops);
    advance(60_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(0);
    advance(30_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(1);
    expect(store.outboxCounts()).toEqual({ queued: 0, failed: 0 });
  });

  it("permanent channel failure stores nothing and returns 503 channel_unavailable; the same key works after the fix", async () => {
    const { ops, store, channel } = setup();
    channel.failNext.push(authFailed());
    const r = await leave(ops, { idempotency_key: "k" });
    expect(!r.ok && r.error).toMatchObject({ code: "channel_unavailable", retryable: false });
    expect(threadCount(store)).toBe(0);
    expect(store.getMessageRequest("m1", "k")).toBeNull();
    expect(codeOf(await leave(ops, { idempotency_key: "k" }))).toBe("ok");
  });

  it("channel_rejected is permanent too", async () => {
    const { ops, store, channel } = setup();
    channel.failNext.push(new ConnectorError("channel_rejected", "msg_too_long"));
    expect(codeOf(await leave(ops))).toBe("channel_unavailable");
    expect(threadCount(store)).toBe(0);
  });

  it("merchant-wide hourly cap returns 429 rate_limited with retry_after_s", async () => {
    const { ops, advance } = setup({ limits: { max_messages_per_hour: 2 } });
    await leaveOk(ops, { customer: { name: "A", email: "a@example.com" } });
    await leaveOk(ops, { customer: { name: "B", email: "b@example.com" } });
    const r = await leave(ops, { customer: { name: "C", email: "c@example.com" } });
    expect(!r.ok && r.error).toMatchObject({ code: "rate_limited", retryable: true, retry_after_s: 3600 });
    advance(3_600_000);
    expect(codeOf(await leave(ops, { customer: { name: "C", email: "c@example.com" } }))).toBe("ok");
  });

  it("a request refused by the merchant-wide cap does not spend the contact's quota", async () => {
    const { ops, advance } = setup({ limits: { max_messages_per_hour: 1, per_contact_per_hour: 1 } });
    await leaveOk(ops, { customer: { name: "A", email: "a@example.com" } });
    advance(1_800_000);
    expect(codeOf(await leave(ops, { customer: { name: "C", email: "c@example.com" } }))).toBe("rate_limited");
    advance(1_800_001);
    expect(codeOf(await leave(ops, { customer: { name: "C", email: "c@example.com" } }))).toBe("ok");
  });

  it("junk requests do not spend the hourly quota", async () => {
    const { ops } = setup({ limits: { max_messages_per_hour: 1 } });
    for (let i = 0; i < 3; i++) expect(codeOf(await leave(ops, { message: "" }))).toBe("invalid_message");
    expect(codeOf(await leave(ops))).toBe("ok");
  });

  it("caps open threads per contact; the owner closing one frees a slot", async () => {
    const { ops } = setup();
    for (let i = 0; i < 3; i++) await leaveOk(ops, { message: `q${i}` });
    expect(codeOf(await leave(ops, { message: "q3" }))).toBe("thread_limit_reached");
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o1", user_id: "U1", text: "Close" })).toBe("accepted");
    expect(codeOf(await leave(ops, { message: "q3" }))).toBe("ok");
  });

  it("MESSAGES_ENABLED=false returns messages_disabled from every op", async () => {
    const { ops, channel } = setup({ enabled: false });
    expect(codeOf(await leave(ops))).toBe("messages_disabled");
    expect(codeOf(await ops.getThread({ thread_id: "t_x", read_token: "x" }))).toBe("messages_disabled");
    expect(codeOf(await ops.agentFollowUp({ thread_id: "t_x", read_token: "x", message: "hi" }))).toBe("messages_disabled");
    await ops.start();
    expect(channel.started).toBe(false);
  });
});

describe("get_thread", () => {
  it("wrong, missing and unknown all return the identical unknown_thread body", async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    const bodies = await Promise.all([
      ops.getThread({ thread_id: r.thread_id, read_token: "wrong" }),
      ops.getThread({ thread_id: r.thread_id }),
      ops.getThread({ thread_id: "t_nope", read_token: r.read_token }),
      ops.getThread({}),
    ]);
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(!bodies[0]!.ok && bodies[0]!.error.code).toBe("unknown_thread");
  });
});

describe("owner side", () => {
  it("a reply answers the thread (poll 0) and is acknowledged; redelivery is a no-op", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    const msg = { provider_ref: "ts.1", provider_msg_id: "1700.2", user_id: "U1", text: "Yes, cats welcome." };
    expect(await ops.onOwnerMessage(msg)).toBe("accepted");
    expect(await ops.onOwnerMessage(msg)).toBe("ignored");
    expect(channel.acks).toEqual(["1700.2"]);
    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data).toMatchObject({ status: "answered", poll_after_seconds: 0 });
    expect(g.ok && g.data.messages.map((m) => [m.from, m.text])).toEqual([
      ["agent", "Do you groom cats?"],
      ["owner", "Yes, cats welcome."],
    ]);
  });

  it("ignores unknown threads and empty text", async () => {
    const { ops } = setup();
    await leaveOk(ops);
    expect(await ops.onOwnerMessage({ provider_ref: "ts.999", provider_msg_id: "a", user_id: "U1", text: "hi" })).toBe("ignored");
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "b", user_id: "U1", text: "   " })).toBe("ignored");
  });

  it("owner typing close (any case) closes; later replies are rejected and a second close is ignored", async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c1", user_id: "U1", text: "  CLOSE " })).toBe("accepted");
    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data).toMatchObject({ status: "closed", poll_after_seconds: 0 });
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c2", user_id: "U1", text: "one more thing" })).toBe(
      "rejected:thread_closed",
    );
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c3", user_id: "U1", text: "close" })).toBe("ignored");
  });

  it.each(["closed", "Done", "DONE.", "close!"])("owner typing %s alone also closes, with no notice asking for it", async (word) => {
    const { ops, store, channel } = setup();
    await leaveOk(ops);
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c1", user_id: "U1", text: word })).toBe("accepted");
    expect(store.getThreadByProviderRef("ts.1")!.state).toBe("closed");
    await flush();
    expect(channel.posts).toEqual([]);
  });

  it("a reply that only contains a close word is a reply", async () => {
    const { ops, store } = setup();
    await leaveOk(ops);
    expect(await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c1", user_id: "U1", text: "We are closed on Monday" })).toBe("accepted");
    expect(store.getThreadByProviderRef("ts.1")!.state).toBe("answered");
  });

  it("reply then close, and close then reply, both end closed", async () => {
    const a = setup();
    await leaveOk(a.ops);
    await a.ops.ownerReply({ provider_ref: "ts.1", provider_msg_id: "r", user_id: "U", text: "yes" });
    await a.ops.ownerClose({ provider_ref: "ts.1", provider_msg_id: "c", user_id: "U", text: "close" });
    expect(a.store.getThreadByProviderRef("ts.1")!.state).toBe("closed");

    const b = setup();
    await leaveOk(b.ops);
    await b.ops.ownerClose({ provider_ref: "ts.1", provider_msg_id: "c", user_id: "U", text: "close" });
    expect(await b.ops.ownerReply({ provider_ref: "ts.1", provider_msg_id: "r", user_id: "U", text: "yes" })).toBe("rejected:thread_closed");
    expect(b.store.getThreadByProviderRef("ts.1")!.state).toBe("closed");
  });

  it("a top-level message with exactly one thread awaiting the owner is that thread's reply, acknowledged and mirrored into the thread", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    const top = { provider_msg_id: "1700.5", user_id: "U1", text: "Yes, cats welcome." };
    expect(await ops.onOwnerMessage(top)).toBe("accepted");
    expect(channel.acks).toEqual(["1700.5"]);
    await flush();
    expect(channel.posts).toEqual([{ ref: "ts.1", text: `${MIRROR_PREFIX}\n\nYes, cats welcome.` }]);
    const g = await ops.getThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(g.ok && g.data).toMatchObject({ status: "answered", poll_after_seconds: 0 });
    expect(g.ok && g.data.messages.at(-1)).toMatchObject({ from: "owner", text: "Yes, cats welcome." });
    // Redelivery is deduped on the message id, even after another thread starts waiting.
    await leaveOk(ops, { customer: { name: "Bo", email: "bo@example.com" } });
    expect(await ops.onOwnerMessage(top)).toBe("ignored");
    await flush();
    expect(channel.posts).toHaveLength(1);
    expect(channel.notices).toEqual([]);
  });

  it("a top-level message fetched after a gap is the reply only if no thread changed since it was typed", async () => {
    const { ops, channel, store, advance } = setup();
    const a = await leaveOk(ops); // 17:00:00
    advance(60_000);
    const typed = Date.parse("2026-10-08T17:00:30Z");
    const top = (id: string, at: number) => ({ provider_msg_id: id, user_id: "U1", text: "Yes, 3pm", backfilled: true, sent_at_ms: at });
    // No send time: cannot be placed, ignored.
    expect(await ops.onOwnerMessage({ provider_msg_id: "g0", user_id: "U1", text: "Yes, 3pm", backfilled: true })).toBe("ignored");
    // Typed before the thread existed.
    expect(await ops.onOwnerMessage(top("g1", Date.parse("2026-10-08T16:59:00Z")))).toBe("ignored");
    // Typed while only this thread waited and nothing has changed since: accepted.
    expect(await ops.onOwnerMessage(top("g2", typed))).toBe("accepted");
    expect(store.getThread(a.thread_id)!.state).toBe("answered");

    // A second customer's thread was waiting too when the owner typed, and has closed since: the message may be theirs.
    const s2 = setup();
    const first = await leaveOk(s2.ops);
    const second = await leaveOk(s2.ops, { customer: { name: "Bo", email: "bo@example.com" } });
    s2.advance(60_000);
    await s2.ops.closeThread({ thread_id: second.thread_id, read_token: second.read_token });
    expect(await s2.ops.onOwnerMessage(top("g3", typed))).toBe("ignored");
    expect(s2.store.getThread(first.thread_id)!.state).toBe("awaiting_owner");
    expect(channel.notices).toEqual([]);
  });

  it("a top-level message typed before a queued opener reached the channel is not taken as its reply", async () => {
    const { ops, store, channel, advance } = setup();
    channel.failNext.push(unavailable());
    const r = await leaveOk(ops); // 17:00:00, opener queued: the owner has not seen it
    advance(30_000);
    await ops.sweep(); // delivered at 17:00:30
    expect(store.getThread(r.thread_id)!.provider_ref).toBe("ts.1");
    const typed = Date.parse("2026-10-08T17:00:15Z"); // about something else: nothing was waiting in the channel yet
    expect(await ops.onOwnerMessage({ provider_msg_id: "q1", user_id: "U1", text: "Tell her Friday works", backfilled: true, sent_at_ms: typed })).toBe("ignored");
    expect(store.getThread(r.thread_id)!.state).toBe("awaiting_owner");
  });

  it("a top-level message fetched after a gap gets no hint when several threads await", async () => {
    const { ops, channel } = setup();
    await leaveOk(ops);
    await leaveOk(ops, { customer: { name: "Bo", email: "bo@example.com" } });
    expect(await ops.onOwnerMessage({ provider_msg_id: "t1", user_id: "U1", text: "Yes", backfilled: true })).toBe("ignored");
    await flush();
    expect(channel.notices).toEqual([]);
  });

  it("a top-level message with several threads awaiting posts one hint a minute and is not stored", async () => {
    const { ops, channel, store, advance } = setup();
    await leaveOk(ops);
    await leaveOk(ops, { customer: { name: "Bo", email: "bo@example.com" } });
    expect(await ops.onOwnerMessage({ provider_msg_id: "t1", user_id: "U1", text: "Yes" })).toBe("ignored");
    expect(await ops.onOwnerMessage({ provider_msg_id: "t2", user_id: "U1", text: "Yes!" })).toBe("ignored");
    await flush();
    expect(channel.notices).toEqual([SEVERAL_WAITING_HINT]);
    advance(60_000);
    expect(await ops.onOwnerMessage({ provider_msg_id: "t3", user_id: "U1", text: "Hello?" })).toBe("ignored");
    expect(channel.notices).toEqual([SEVERAL_WAITING_HINT, SEVERAL_WAITING_HINT]);
    expect(channel.acks).toEqual([]);
    expect(channel.posts).toEqual([]);
    expect(store.getThreadByProviderRef("ts.1")!.state).toBe("awaiting_owner");
    expect(store.getThreadByProviderRef("ts.2")!.state).toBe("awaiting_owner");
  });

  it("a top-level message with no thread awaiting the owner is ignored silently", async () => {
    const { ops, channel } = setup();
    expect(await ops.onOwnerMessage({ provider_msg_id: "n1", user_id: "U1", text: "Morning all" })).toBe("ignored");
    await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "n2", user_id: "U1", text: "Yes" }); // now answered
    expect(await ops.onOwnerMessage({ provider_msg_id: "n3", user_id: "U1", text: "And one more thing" })).toBe("ignored");
    await flush();
    expect(channel.notices).toEqual([]);
    expect(channel.posts).toEqual([]);
    expect(channel.acks).toEqual(["n2"]);
  });

  it("a storage failure throws so the channel does not ack", async () => {
    const { ops, store } = setup();
    await leaveOk(ops);
    store.db.exec("DROP TABLE thread_messages");
    await expect(ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "x", user_id: "U", text: "yes" })).rejects.toThrow();
  });
});

describe("follow_up", () => {
  it("reopens an answered thread and posts into the provider thread", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o", user_id: "U", text: "How old is the cat?" });
    const f = await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "She is 12." });
    expect(f.ok && f.data).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60, delivery: "delivered" });
    expect(channel.posts).toEqual([{ ref: "ts.1", text: expect.stringContaining("She is 12.") }]);
  });

  it("requires the read token", async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: "nope", message: "hi" }))).toBe("unknown_thread");
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "" }))).toBe("invalid_message");
  });

  it("closed thread returns thread_closed", async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "c", user_id: "U", text: "close" });
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "hi" }))).toBe("thread_closed");
  });

  it(`caps a thread at ${MAX_AGENT_MESSAGES} agent messages`, async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    for (let i = 1; i < MAX_AGENT_MESSAGES; i++) {
      expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: `m${i}` }))).toBe("ok");
    }
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "one too many" }))).toBe("thread_closed");
  });

  it("permanent failure undoes the follow-up and the thread state", async () => {
    const { ops, store, channel } = setup();
    const r = await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o", user_id: "U", text: "ok" });
    channel.failNext.push(authFailed());
    const f = await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "hi", idempotency_key: "f1" });
    expect(codeOf(f)).toBe("channel_unavailable");
    const t = store.getThread(r.thread_id)!;
    expect([t.state, t.agent_count, store.listThreadMessages(t.thread_id).length, store.listOutbox(t.thread_id).length]).toEqual(["answered", 1, 2, 1]);
    expect(store.getMessageRequest("m1", "f1")).toBeNull();
  });

  it("waits behind an opener that is still queued, then goes out after it, in order", async () => {
    const { ops, channel, advance } = setup();
    channel.failNext.push(unavailable());
    const r = await leaveOk(ops);
    const f = await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "also: she bites" });
    expect(f.ok && f.data.delivery).toBe("queued");
    await ops.sweep(); // opener not due yet: the follow-up must not go first
    expect(channel.posts).toEqual([]);
    advance(30_000);
    await ops.sweep();
    expect(channel.opened).toHaveLength(1);
    advance(30_000);
    await ops.sweep();
    expect(channel.posts.map((p) => p.ref)).toEqual(["ts.1"]);
  });
});

describe("one-way and no channel", () => {
  it("notify-only channel: message delivered by notify, replies not in-band, nothing to poll", async () => {
    const notices: string[] = [];
    const { ops } = setup({ channel: { notify: async (m: string) => void notices.push(m) } });
    expect(ops.mode).toBe("one_way");
    const r = await leaveOk(ops);
    expect(r).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 0, owner_replies_in_band: false, delivery: "delivered" });
    expect(notices[0]).toContain("contact the customer directly");
    expect(notices[0]).toContain("+1 202 555 0199");
  });

  it("no channel: no message ops at all", () => {
    expect(
      createMessageOps({ config: parseConfig({ name: "x", timezone: "UTC", currency: "USD", hours: {} }), store: new Store(":memory:"), channel: undefined, settings: { messages_enabled: true } }),
    ).toBeUndefined();
  });
});

describe("lifecycle", () => {
  it("start registers the owner handler, starts the channel and a 30 s sweep; stop undoes both", async () => {
    const { ops, channel, intervals } = setup();
    await ops.start();
    expect(channel.handler).toBe(ops.onOwnerMessage);
    // The channel's catch-up context: open thread refs and a cursor that survives in the store.
    expect(channel.ctx!.openThreadRefs()).toEqual([]);
    expect(channel.ctx!.getCursor()).toBeNull();
    channel.ctx!.setCursor("1700000050.000200");
    expect(channel.ctx!.getCursor()).toBe("1700000050.000200");
    expect(channel.started).toBe(true);
    expect(intervals.map((i) => i.ms)).toEqual([30_000]);
    await ops.stop();
    expect(intervals[0]!.cleared).toBe(true);
    expect(channel.stopped).toBe(true);
  });

  it("a transient channel start failure is logged and boot continues with the sweep running", async () => {
    const { ops, channel, intervals, logs } = setup();
    channel.start = async () => {
      throw unavailable();
    };
    await expect(ops.start()).resolves.toBeUndefined();
    expect(intervals.map((i) => i.ms)).toEqual([30_000]);
    expect(logs.some((l) => l.includes("owner channel did not start") && l.includes("slack 503"))).toBe(true);
    await ops.stop();
  });

  it("closes an answered thread 24 h after the owner's last reply when the agent sends nothing more", async () => {
    const { ops, store, advance } = setup();
    const r = await leaveOk(ops);
    advance(3 * 86_400_000); // the owner takes 3 days: still within the unanswered window
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o", user_id: "U", text: "Yes we do" });
    advance(24 * 3_600_000 - 1);
    await ops.sweep();
    expect(store.getThread(r.thread_id)!.state).toBe("answered");
    advance(2);
    await ops.sweep();
    expect(store.getThread(r.thread_id)!.state).toBe("closed");
  });

  it("an agent follow-up after the reply puts the thread back on the 7-day rule", async () => {
    const { ops, store, advance } = setup();
    const r = await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o", user_id: "U", text: "How old?" });
    advance(3_600_000);
    await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "12" });
    advance(2 * 86_400_000);
    await ops.sweep();
    expect(store.getThread(r.thread_id)!.state).toBe("awaiting_owner");
  });

  it("idle windows come from limits", async () => {
    const { ops, store, advance } = setup({ limits: { thread_close_after_reply_hours: 1, thread_close_unanswered_days: 2 } });
    const a = await leaveOk(ops, { message: "a" });
    const b = await leaveOk(ops, { message: "b" });
    await ops.onOwnerMessage({ provider_ref: "ts.2", provider_msg_id: "o", user_id: "U", text: "ok" });
    advance(3_600_000 + 1);
    await ops.sweep();
    expect(store.getThread(b.thread_id)!.state).toBe("closed");
    expect(store.getThread(a.thread_id)!.state).toBe("awaiting_owner");
    advance(2 * 86_400_000);
    await ops.sweep();
    expect(store.getThread(a.thread_id)!.state).toBe("closed");
  });

  it("closes threads idle for 7 days and purges them 30 days after closing", async () => {
    const { ops, store, advance } = setup();
    const r = await leaveOk(ops);
    advance(7 * 86_400_000 + 1);
    await ops.sweep();
    expect(store.getThread(r.thread_id)!.state).toBe("closed");
    advance(30 * 86_400_000 + 1);
    await ops.sweep();
    expect(store.getThread(r.thread_id)).toBeNull();
  });

  it("health reports mode, connection and outbox counts", async () => {
    const { ops, channel } = setup();
    channel.failNext.push(unavailable());
    await leaveOk(ops);
    expect(ops.health()).toEqual({ mode: "two_way", enabled: true, connected: true, outbox: { queued: 1, failed: 0 } });
  });
});

describe("closing a thread", () => {
  it("the agent closes it; the owner gets one thank-you in the thread", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    const c = await ops.closeThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(c.ok && c.data).toMatchObject({ thread_id: r.thread_id, status: "closed", poll_after_seconds: 0 });
    await flush();
    expect(channel.posts).toEqual([{ ref: "ts.1", text: CLOSE_NOTICE }]);
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "hi" }))).toBe("thread_closed");
  });

  it("is idempotent: closing a closed thread is ok and posts nothing more", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    await ops.closeThread({ thread_id: r.thread_id, read_token: r.read_token });
    const again = await ops.closeThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(again.ok && again.data.status).toBe("closed");
    await flush();
    expect(channel.posts).toHaveLength(1);
  });

  it("a wrong or missing token is unknown_thread, like get_thread", async () => {
    const { ops, store } = setup();
    const r = await leaveOk(ops);
    expect(codeOf(await ops.closeThread({ thread_id: r.thread_id, read_token: "nope" }))).toBe("unknown_thread");
    expect(codeOf(await ops.closeThread({ thread_id: r.thread_id }))).toBe("unknown_thread");
    expect(codeOf(await ops.closeThread({ thread_id: "t_missing", read_token: r.read_token }))).toBe("unknown_thread");
    expect(store.getThread(r.thread_id)!.state).toBe("awaiting_owner");
  });

  it("a failing close notice does not fail the close", async () => {
    const { ops, channel, logs } = setup();
    const r = await leaveOk(ops);
    channel.failNext.push(unavailable());
    const c = await ops.closeThread({ thread_id: r.thread_id, read_token: r.read_token });
    expect(c.ok && c.data.status).toBe("closed");
    await flush();
    expect(logs.some((l) => l.includes("close notice failed"))).toBe(true);
  });

  it("follow_up with done posts the message and closes in one step", async () => {
    const { ops, channel } = setup();
    const r = await leaveOk(ops);
    await ops.onOwnerMessage({ provider_ref: "ts.1", provider_msg_id: "o", user_id: "U", text: "Yes, Tuesdays." });
    const f = await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "Thank you!", done: true });
    expect(f.ok && f.data).toMatchObject({ status: "closed", poll_after_seconds: 0, delivery: "delivered" });
    expect(f.ok && f.data.messages.at(-1)).toMatchObject({ from: "agent", text: "Thank you!" });
    expect(channel.posts).toEqual([{ ref: "ts.1", text: `Follow-up from the assistant:\n\nThank you!\n\n${CLOSE_NOTICE}` }]);
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "again", done: true }))).toBe("thread_closed");
  });

  it("done must be a boolean", async () => {
    const { ops } = setup();
    const r = await leaveOk(ops);
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "x", done: "yes" as never }))).toBe("invalid_request");
  });

  it("a permanent failure on a done follow-up leaves the thread open", async () => {
    const { ops, store, channel } = setup();
    const r = await leaveOk(ops);
    channel.failNext.push(authFailed());
    expect(codeOf(await ops.agentFollowUp({ thread_id: r.thread_id, read_token: r.read_token, message: "bye", done: true }))).toBe("channel_unavailable");
    expect(store.getThread(r.thread_id)!.state).toBe("awaiting_owner");
  });

  const booking = (customer: Booking["customer"]): Booking => ({
    booking_id: "b_1",
    quote_id: "q_1",
    event_id: "e1",
    slot: { service_id: "bath", start: "2026-10-09T10:00:00-07:00", end: "2026-10-09T11:00:00-07:00" },
    price_cents: 5000,
    currency: "USD",
    customer,
    state: "booked",
    created_at: "2026-10-08T10:00:00-07:00",
  });

  it("a booking for the contact closes their open threads with a notice naming the service and local time", async () => {
    const { ops, store, channel } = setup();
    const mine = await leaveOk(ops);
    const other = await leaveOk(ops, { customer: { name: "Bo", email: "bo@example.com" } });
    // Same phone, written differently: contact keys compare digits.
    const closed = await ops.closeForBooking(booking({ name: "Ann Lee", phone: "+12025550199" }), SERVICES[0]);
    expect(closed).toEqual([mine.thread_id]);
    expect(store.getThread(mine.thread_id)!.state).toBe("closed");
    expect(store.getThread(other.thread_id)!.state).toBe("awaiting_owner");
    await flush();
    expect(channel.posts).toEqual([{ ref: "ts.1", text: expect.stringContaining("booked Dog bath for Fri Oct 9, 10:00 AM") }]);
  });

  it("a booking with no open threads, or with messages off, closes nothing", async () => {
    const a = setup();
    expect(await a.ops.closeForBooking(booking({ name: "Ann", phone: "+1 202 555 0199" }))).toEqual([]);
    const b = setup({ enabled: false });
    expect(await b.ops.closeForBooking(booking({ name: "Ann", phone: "+1 202 555 0199" }))).toEqual([]);
  });
});

describe("get_thread long-poll", () => {
  const reply = (text = "Yes") => ({ provider_ref: "ts.1", provider_msg_id: `m.${text}`, user_id: "U1", text });
  const hold = (ops: MessageOps, r: { thread_id: string; read_token: string }, over: Record<string, unknown> = {}) =>
    ops.getThread({ thread_id: r.thread_id, read_token: r.read_token, wait_s: 25, ...over });
  const dataOf = async (p: ReturnType<MessageOps["getThread"]>) => {
    const g = await p;
    if (!g.ok) throw new Error(g.error.code);
    return g.data;
  };

  it("an owner reply wakes the hold with status answered", async () => {
    const { ops, logs } = setup();
    const r = await leaveOk(ops);
    const p = hold(ops, r);
    expect(await ops.onOwnerMessage(reply())).toBe("accepted");
    expect(await dataOf(p)).toMatchObject({ status: "answered", poll_after_seconds: 0 });
    expect(logs.some((l) => /wait thread=t_\w+ asked=25s held=\d+ms outcome=replied/.test(l))).toBe(true);
  });

  it("a full hold returns awaiting_owner with poll_after_seconds 0; wait is clamped to the max", async () => {
    const { ops, timeouts, fireTimeouts } = setup({ limits: { thread_wait_max_seconds: 10 } });
    const r = await leaveOk(ops);
    const p = hold(ops, r, { wait_s: 3600 });
    expect(timeouts[0]!.ms).toBe(10_000);
    fireTimeouts();
    expect(await dataOf(p)).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 0 });
  });

  it("closeThread, a booking close and expiry each wake the hold with status closed", async () => {
    const a = setup();
    const ra = await leaveOk(a.ops);
    const pa = hold(a.ops, ra);
    await a.ops.closeThread(ra);
    expect((await dataOf(pa)).status).toBe("closed");

    const b = setup();
    const rb = await leaveOk(b.ops);
    const pb = hold(b.ops, rb);
    await b.ops.closeForBooking({ booking_id: "b_1", customer: ANN, slot: { service_id: "bath", start: "2026-10-09T10:00:00-07:00" } } as Booking);
    expect((await dataOf(pb)).status).toBe("closed");

    const c = setup();
    const rc = await leaveOk(c.ops);
    const pc = hold(c.ops, rc);
    c.advance(7 * 86_400_000 + 1);
    await c.ops.sweep();
    expect((await dataOf(pc)).status).toBe("closed");
  });

  it("one waiter per thread, a global cap, and abort", async () => {
    const { ops, timeouts } = setup({ limits: { max_waiting_requests: 1 } });
    const r1 = await leaveOk(ops);
    const r2 = await leaveOk(ops, { customer: { name: "Bo", email: "bo@example.com" } });
    const first = new AbortController();
    const p1 = hold(ops, r1, { signal: first.signal });
    // A retry on the same thread replaces the first hold, even with the registry full (O4).
    const second = new AbortController();
    const p2 = hold(ops, r1, { signal: second.signal });
    expect(await dataOf(p1)).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60 });
    first.abort(); // the displaced request going away is a no-op
    // Over the cap: another thread answers at once.
    expect(await dataOf(hold(ops, r2))).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60 });
    expect(timeouts.filter((h) => !h.cleared)).toHaveLength(1);
    // Abort removes the waiter, which frees the slot.
    second.abort();
    expect((await dataOf(p2)).status).toBe("awaiting_owner");
    expect(timeouts.filter((h) => !h.cleared)).toHaveLength(0);
    const p3 = hold(ops, r2);
    expect(timeouts.filter((h) => !h.cleared)).toHaveLength(1);
    await ops.closeThread(r2);
    expect((await dataOf(p3)).status).toBe("closed");
  });

  it("answers at once for one-way, a thread not awaiting the owner, or long-poll off", async () => {
    const oneWay = setup({ channel: { notify: async () => {} } });
    const r1 = await leaveOk(oneWay.ops);
    expect((await dataOf(hold(oneWay.ops, r1))).status).toBe("awaiting_owner");
    expect(oneWay.timeouts).toHaveLength(0);

    const answered = setup();
    const r2 = await leaveOk(answered.ops);
    await answered.ops.onOwnerMessage(reply());
    expect((await dataOf(hold(answered.ops, r2))).status).toBe("answered");
    expect(answered.timeouts).toHaveLength(0);

    const off = setup({ limits: { thread_wait_max_seconds: 0 } });
    const r3 = await leaveOk(off.ops);
    expect(await dataOf(hold(off.ops, r3))).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60 });
    expect(off.timeouts).toHaveLength(0);
  });

  it("stop() releases every hold with the current view, and a wait after stop() answers at once", async () => {
    const { ops, timeouts } = setup();
    const r = await leaveOk(ops);
    const p = hold(ops, r);
    await ops.stop();
    expect(await dataOf(p)).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60 });
    const before = timeouts.length;
    expect(await dataOf(hold(ops, r))).toMatchObject({ status: "awaiting_owner", poll_after_seconds: 60 });
    expect(timeouts).toHaveLength(before);
  });
});

describe("runOp", () => {
  it("logs a thrown error with the op name, then returns internal", async () => {
    const lines: string[] = [];
    const r = await runOp(
      "leave_message",
      () => {
        throw new Error("SQLITE_BUSY");
      },
      (l) => lines.push(l),
    );
    expect(codeOf(r)).toBe("internal");
    expect(lines[0]).toMatch(/op leave_message threw: .*SQLITE_BUSY/);
  });
});
