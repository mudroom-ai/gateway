// Thread tables in the SQLite store: the parts messages.ts relies on for correctness.
// Value: protects=schema reopen, provider_msg_id dedup, sending rows reset at open, cascade on purge,
//   one idempotency claim per key, due-only outbox claims; fails_when=a constraint or index is dropped,
//   or a crash-recovery step is removed; why_new=no store tests existed for the thread tables; seam=none
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type ThreadRow } from "../src/store/sqlite.js";

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
  created_at: "2026-10-08T17:00:00.000Z",
  updated_at_ms: 1000,
  closed_at_ms: null,
  ...over,
});

describe("store: thread tables", () => {
  it("reopens an existing file without error and resets rows stuck in sending", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gw-store-")), "t.sqlite");
    const a = new Store(path);
    a.insertThread(thread("t1"));
    const id = a.insertOutbox({ thread_id: "t1", kind: "open", text: "hi", state: "sending", attempts: 1, next_at_ms: null }, "now");
    a.close();
    const b = new Store(path);
    expect(b.getOutbox(id)).toMatchObject({ state: "queued", attempts: 1, next_at_ms: 0 });
    expect(b.claimDueOutbox(0, 10, "now").map((r) => r.id)).toEqual([id]);
    b.close();
  });

  it("dedups owner messages on provider_msg_id", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("t1"));
    const m = { thread_id: "t1", author: "owner" as const, text: "yes", provider_msg_id: "1700.1", at: "x" };
    expect(s.insertThreadMessage(m)).not.toBeNull();
    expect(s.insertThreadMessage(m)).toBeNull();
    expect(s.listThreadMessages("t1")).toHaveLength(1);
  });

  it("claims an idempotency key once", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("t1"));
    const r = { merchant_id: "m1", idem_key: "k", request_hash: "h", thread_id: "t1" };
    expect(s.claimMessageRequest(r, "now")).toBe(true);
    expect(s.claimMessageRequest(r, "now")).toBe(false);
    expect(s.getMessageRequest("m1", "k")?.response).toBeNull();
  });

  it("claims only due queued rows and flips them to sending", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("t1"));
    const due = s.insertOutbox({ thread_id: "t1", kind: "open", text: "a", state: "queued", attempts: 1, next_at_ms: 100 }, "now");
    s.insertOutbox({ thread_id: "t1", kind: "post", text: "b", state: "queued", attempts: 1, next_at_ms: 500 }, "now");
    const got = s.claimDueOutbox(200, 10, "now");
    expect(got.map((r) => [r.id, r.state, r.attempts])).toEqual([[due, "sending", 2]]);
    expect(s.claimDueOutbox(200, 10, "now")).toEqual([]);
    expect(s.outboxCounts()).toEqual({ queued: 2, failed: 0 });
  });

  it("counts open threads by any shared contact key", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("t1"));
    s.insertThread(thread("t2", { contact_keys: ["e:ann@example.com", "p:12025550199"] }));
    s.insertThread(thread("t3", { state: "closed", closed_at_ms: 1 }));
    expect(s.countOpenThreads("m1", ["p:12025550199"])).toBe(2);
    expect(s.countOpenThreads("m1", ["e:ann@example.com"])).toBe(1);
    expect(s.countOpenThreads("m2", ["p:12025550199"])).toBe(0);
  });

  it("expires idle threads, then purges closed ones with everything hanging off them", () => {
    const s = new Store(":memory:");
    s.insertThread(thread("old", { updated_at_ms: 10 }));
    s.insertThread(thread("new", { updated_at_ms: 1000 }));
    s.insertThreadMessage({ thread_id: "old", author: "agent", text: "x", provider_msg_id: null, at: "x" });
    s.insertOutbox({ thread_id: "old", kind: "open", text: "x", state: "failed", attempts: 6, next_at_ms: null }, "now");
    s.claimMessageRequest({ merchant_id: "m1", idem_key: "k", request_hash: "h", thread_id: "old" }, "now");
    expect(s.expireIdleThreads(500, 500, 600)).toEqual(["old"]);
    expect(s.getThread("old")).toMatchObject({ state: "closed", closed_at_ms: 600 });
    expect(s.purgeClosedThreads(600)).toBe(0);
    expect(s.purgeClosedThreads(601)).toBe(1);
    expect(s.listThreadMessages("old")).toEqual([]);
    expect(s.listOutbox("old")).toEqual([]);
    expect(s.getMessageRequest("m1", "k")).toBeNull();
    expect(s.getThread("new")?.state).toBe("awaiting_owner");
  });
});
