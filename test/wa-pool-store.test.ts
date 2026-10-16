// WhatsApp number pool in the SQLite store: which number a new thread is sent from, and the
// durable "Which customer?" prompts. A wrong pick here puts two customers in one chat.
import { describe, expect, it } from "vitest";
import { RELEASE_HOLD_MS, type WaPending } from "../src/connectors/whatsapp-pool.js";
import { Store, type ThreadRow } from "../src/store/sqlite.js";

const OWNER = "12025550199";
const [A, B] = ["1001", "1002"];

const thread = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({
  thread_id: id,
  merchant_id: "m1",
  token_hash: "00",
  state: "awaiting_owner",
  mode: "two_way",
  customer: { name: "Ann", phone: "+1 202 555 0199" },
  contact_keys: ["p:12025550199"],
  service_id: null,
  provider_ref: null,
  agent_count: 1,
  created_at: "2026-10-15T17:00:00.000Z",
  updated_at_ms: 1000,
  closed_at_ms: null,
  ...over,
});

/** As leave_message does it: the thread and its opener (in flight) exist before the channel assigns a number. */
function open(s: Store, id: string, nowMs: number, pool = [A, B], accepted = true) {
  s.insertThread(thread(id, { updated_at_ms: nowMs }));
  const ob = s.insertOutbox({ thread_id: id, kind: "open", text: "hi", state: "sending", attempts: 1, next_at_ms: null }, "now");
  const got = s.waAssign({ thread_id: id, owner_phone: OWNER, pool, now_ms: nowMs });
  if (!accepted) return got; // the send is still in flight (or was refused)
  // Meta accepted the opener: the channel records it, the core stores the ref and marks the row delivered.
  s.waMarkAccepted(id, `wamid.${id}`, nowMs);
  s.setProviderRef(id, `wamid.${id}`, nowMs);
  s.updateOutbox(ob, { state: "delivered" }, "now");
  return got;
}
const close = (s: Store, id: string, atMs: number) => s.updateThread(id, { state: "closed", updated_at_ms: atMs });

describe("store: WhatsApp number pool", () => {
  it("prefers a never-used number, then the one released longest ago; re-assigning is idempotent", () => {
    const s = new Store(":memory:");
    s.waTouchWindow(B, OWNER, 50);
    expect(open(s, "t1", 0)).toEqual({ number_id: B, reused: false }); // exact tie between never-used: warmest window
    close(s, "t1", 1000);
    expect(open(s, "t2", 100_000)).toEqual({ number_id: A, reused: false }); // B is free again but A was never used
    close(s, "t2", 2000);
    expect(open(s, "t3", 200_000)).toEqual({ number_id: B, reused: true }); // released at 1000, before A's 2000
    expect(s.waAssign({ thread_id: "t3", owner_phone: OWNER, pool: [A, B], now_ms: 300_000 })).toEqual({ number_id: B, reused: true });
  });

  it("holds a released number for RELEASE_HOLD_MS", () => {
    const s = new Store(":memory:");
    open(s, "t1", 0);
    open(s, "t2", 0);
    close(s, "t1", 1000);
    expect(open(s, "t3", 1000 + RELEASE_HOLD_MS - 1).number_id).toBe(B); // overflow onto the busier chat
    expect(open(s, "t4", 1000 + RELEASE_HOLD_MS)).toEqual({ number_id: A, reused: true });
  });

  it("does not reuse a number while a closed thread's outbox row is queued", () => {
    const s = new Store(":memory:");
    open(s, "t1", 0);
    open(s, "t2", 0);
    const notice = s.insertOutbox({ thread_id: "t1", kind: "post", text: "closed", state: "queued", attempts: 1, next_at_ms: 0 }, "now");
    close(s, "t1", 1000);
    expect(open(s, "t3", 100_000).number_id).toBe(B);
    s.updateOutbox(notice, { state: "failed" }, "now");
    expect(open(s, "t4", 100_000).number_id).toBe(A);
  });

  it("overflows onto the number with the most open threads, ties to the primary", () => {
    const s = new Store(":memory:");
    open(s, "t1", 0);
    open(s, "t2", 0);
    expect(open(s, "t3", 0)).toEqual({ number_id: A, reused: true });
    expect(open(s, "t4", 0).number_id).toBe(A);
  });

  it("counts open threads from before the pool on the primary", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("old", { provider_ref: "wamid.old" }));
    expect(open(s, "t1", 0).number_id).toBe(B);
    expect(s.waOpenOn({ number_id: A, owner_phone: OWNER, is_primary: true })).toEqual([
      { thread_id: "old", provider_ref: "wamid.old", reused: true, accepted_at_ms: null, opener_read_at_ms: null, confirmed_at_ms: null },
    ]);
    expect(s.waOpenOn({ number_id: A, owner_phone: OWNER, is_primary: false })).toEqual([]);
  });

  it("frees a number when its thread is deleted or expired", () => {
    const s = new Store(":memory:");
    open(s, "t1", 0, [A, B], false);
    open(s, "t2", 0);
    s.deleteThread("t1"); // the opener was refused: nothing reached the chat
    expect(open(s, "t3", 0)).toEqual({ number_id: A, reused: false });
    expect(s.expireIdleThreads(0, 10, 5000)).toEqual(["t2", "t3"]);
    expect(open(s, "t4", 5000 + RELEASE_HOLD_MS)).toEqual({ number_id: A, reused: true });
  });

  it("remembers a number that carried a conversation after its threads are purged; a refused opener leaves no history", () => {
    const s = new Store(":memory:");
    expect(open(s, "t1", 0)).toEqual({ number_id: A, reused: false });
    close(s, "t1", 1000);
    s.purgeClosedThreads(2000); // the thread and its wa_threads row are gone, the chat's messages are not
    expect(open(s, "t2", 5000 + RELEASE_HOLD_MS, [A, B], false)).toEqual({ number_id: B, reused: false });
    s.deleteThread("t2"); // never accepted: the send was refused
    expect(open(s, "t3", 6000 + RELEASE_HOLD_MS)).toEqual({ number_id: B, reused: false });
    expect(open(s, "t4", 7000 + RELEASE_HOLD_MS)).toEqual({ number_id: A, reused: true });
  });

  it("a thread another leave_message is still opening is not pre-pool history, and a given-up opener holds no number", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("t1")); // inserted, its opener in flight, not yet assigned (no row, no provider_ref)
    const ob = s.insertOutbox({ thread_id: "t1", kind: "open", text: "hi", state: "sending", attempts: 1, next_at_ms: null }, "now");
    expect(open(s, "t2", 0)).toEqual({ number_id: A, reused: false });
    expect(s.waAssign({ thread_id: "t1", owner_phone: OWNER, pool: [A, B], now_ms: 0 })).toEqual({ number_id: B, reused: false });
    s.updateOutbox(ob, { state: "failed", last_error: "gave up" }, "now"); // the sweep gave up on t1's opener
    expect(s.waOpenOn({ number_id: B, owner_phone: OWNER, is_primary: false })).toEqual([]);
    close(s, "t2", 0);
    expect(open(s, "t3", RELEASE_HOLD_MS)).toEqual({ number_id: B, reused: false }); // B never carried a message
  });

  it("records acceptance, the first read and the first confirmation", () => {
    const s = new Store(":memory:");
    open(s, "t1", 0);
    s.waMarkAccepted("t1", "wamid.1", 100);
    s.setProviderRef("t1", "wamid.1", 100);
    s.waMarkRead("wamid.1", 200);
    s.waMarkRead("wamid.1", 300);
    s.waMarkRead("wamid.other", 300);
    s.waConfirm("t1", 400);
    s.waConfirm("t1", 500);
    expect(s.waOpenOn({ number_id: A, owner_phone: OWNER, is_primary: true })).toEqual([
      { thread_id: "t1", provider_ref: "wamid.1", reused: false, accepted_at_ms: 100, opener_read_at_ms: 200, confirmed_at_ms: 400 },
    ]);
    expect(s.waNumberForRef("wamid.1")).toBe(A);
    expect(s.waNumberForRef("wamid.other")).toBeNull();
    expect(s.waOrphanNumbers([B], OWNER)).toEqual([A]);
    expect(s.waOrphanNumbers([A, B], OWNER)).toEqual([]);
  });

  it("consumes a picker prompt once, only on its number, for an offered thread, before expiry", () => {
    const s = new Store(":memory:");
    const p: WaPending = { prompt_wamid: "wamid.p", orig_wamid: "wamid.o", text: "yes", sent_at_ms: 10, number_id: A, allowed: ["wamid.1", "wamid.2"], expires_at_ms: 1000 };
    s.waPutPending(p);
    s.waPutPending({ ...p, prompt_wamid: "wamid.p2", text: "again" });
    expect(s.waHasPending("wamid.o")).toBe(true);
    const take = (over: object) => s.waTakePending({ prompt_wamid: "wamid.p", chosen_ref: "wamid.2", number_id: A, now_ms: 500, ...over });
    expect(take({ number_id: B })).toEqual({ ok: false, reason: "not_allowed" });
    expect(take({ chosen_ref: "wamid.9" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(take({ now_ms: 1000 })).toEqual({ ok: false, reason: "expired" });
    expect(take({})).toEqual({ ok: true, pending: p });
    expect(take({})).toEqual({ ok: true, pending: p }); // the same tap redelivered: replayed, the core dedups
    expect(take({ chosen_ref: "wamid.1" })).toEqual({ ok: false, reason: "consumed" });
    expect(take({ prompt_wamid: "wamid.p2" })).toEqual({ ok: false, reason: "unknown" });
  });
});
