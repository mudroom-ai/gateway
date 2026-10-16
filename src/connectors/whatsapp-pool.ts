// Contract between the WhatsApp channel (src/connectors/whatsapp.ts) and the store
// (src/store/sqlite.ts) for the number pool: one WhatsApp chat per conversation,
// sent from a pool of business numbers (docs/design/whatsapp-number-pool.md).
//
// Every thread the channel opens gets a row naming the number it was sent from
// (pooled or overflow). A number is free when every thread ever on it is closed,
// the last one closed at least RELEASE_HOLD_MS ago, and none of them has an outbox
// row still queued or sending: an old close notice can never land after a new
// opener. Threads opened before the pool existed have no row and count on the
// primary number (the first in the list).
//
// Routing a plain owner reply on number P straight to P's single open thread is
// allowed only when that assignment is active (see isActive): on a never-used
// number once the opener was accepted, on a reused number once the owner confirmed
// it (read receipt for the opener, a quote, or a picker choice). Everything else
// goes to the "Which customer?" picker, whose pending replies are stored here so a
// restart between the buttons and the tap loses nothing.

/** A number is free only this long after its last thread closed. */
export const RELEASE_HOLD_MS = 60_000;
/** A plain reply on a never-used number counts only when sent this long after the opener was accepted (whole-second owner clock). */
export const ACCEPT_SKEW_MS = 5_000;
/** How long a "Which customer?" prompt can be answered. */
export const PENDING_TTL_MS = 24 * 3_600_000;

/**
 * WHATSAPP_PHONE_NUMBER_ID as a pool: comma-separated Phone number IDs, trimmed, empty elements dropped, duplicates
 * removed, order kept (the first is the primary). Throws an Error a merchant can act on.
 */
export function parsePhoneNumberIds(spec: string | undefined): string[] {
  const ids = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("WHATSAPP_PHONE_NUMBER_ID is empty: set the Phone number ID from Meta app > WhatsApp > API Setup (several, comma-separated, for one chat per customer)");
  const bad = ids.find((id) => !/^\d+$/.test(id));
  if (bad !== undefined) {
    throw new Error(`WHATSAPP_PHONE_NUMBER_ID must be numeric Phone number IDs from Meta app > WhatsApp > API Setup, not phone numbers ("${bad}")`);
  }
  return [...new Set(ids)];
}

export interface WaAssignment {
  number_id: string;
  /** The number held an earlier conversation, so the chat shows another customer's messages above the opener. */
  reused: boolean;
}

/** An open thread on one number, with what the routing gate needs. */
export interface WaOpenThread {
  thread_id: string;
  /** The opener's wamid; null until the opener was accepted by Meta. */
  provider_ref: string | null;
  reused: boolean;
  /** When Meta accepted the opener (server clock); null before, and for threads from before the pool. */
  accepted_at_ms: number | null;
  /** Meta's `read` status timestamp for the opener (owner side), first one only. */
  opener_read_at_ms: number | null;
  /** First time the owner quoted this thread's message or picked it in the picker. */
  confirmed_at_ms: number | null;
}

/** An owner message waiting for a "Which customer?" choice. */
export interface WaPending {
  /** wamid of the buttons/list message; the tap's context.id. */
  prompt_wamid: string;
  /** wamid of the owner's original message (the core dedups on it). */
  orig_wamid: string;
  text: string;
  /** Owner's send time (Meta timestamp, ms), if given. */
  sent_at_ms: number | null;
  /** The number the owner wrote to; a tap must come in on the same one. */
  number_id: string;
  /** provider_refs offered; a tap must name one of them. */
  allowed: string[];
  expires_at_ms: number;
}

export type WaTakeResult =
  | { ok: true; pending: WaPending }
  /** unknown: no such prompt (or purged). consumed: already answered with another choice (ignore silently). expired, not_allowed: refuse with a notice. */
  | { ok: false; reason: "unknown" | "consumed" | "expired" | "not_allowed" };

/** Implemented by Store (src/store/sqlite.ts); synchronous like the rest of the store. */
export interface WhatsappPoolStore {
  /**
   * The number this thread is sent from. Idempotent: a thread that already has a row keeps its number (a retried opener).
   * Otherwise, in one transaction: a free never-used number, else the free one released longest ago, else (no free number)
   * the number with the most open threads (overflow; ties go to pool order, so the primary first). Exact ties among free
   * numbers go to the warmest 24-hour window (wa_windows), then pool order.
   */
  waAssign(q: { thread_id: string; owner_phone: string; pool: string[]; now_ms: number }): WaAssignment;
  /** The number a thread (by its opener's wamid) was sent from, open or closed; null when it has no row. */
  waNumberForRef(provider_ref: string): string | null;
  /** Open threads on the number; on the primary also the open two-way threads with no row (from before the pool). */
  waOpenOn(q: { number_id: string; owner_phone: string; is_primary: boolean }): WaOpenThread[];
  /** The opener was accepted by Meta with this wamid. */
  waMarkAccepted(thread_id: string, opener_wamid: string, at_ms: number): void;
  /** Meta reported the owner read this message; recorded only when it is a thread's opener, first time only. */
  waMarkRead(opener_wamid: string, at_ms: number): void;
  /** The owner quoted or picked this thread; first time only. */
  waConfirm(thread_id: string, at_ms: number): void;
  /** The owner wrote to this number (opens Meta's 24-hour free-text window). Keeps the latest. */
  waTouchWindow(number_id: string, owner_phone: string, at_ms: number): void;
  /** Store a picker prompt. A second put for the same orig_wamid is ignored. */
  waPutPending(p: WaPending): void;
  /** True when this original message already has a prompt (a redelivered webhook: do not ask twice). */
  waHasPending(orig_wamid: string): boolean;
  /**
   * Consume the prompt for a tap: checks number, allowed choice and expiry; marks it consumed with the choice on success.
   * The same tap again (same choice and number) returns the pending again, so a tap whose reply the core failed to store
   * is replayed on Meta's redelivery (the core dedups on orig_wamid); another choice after that is "consumed".
   */
  waTakePending(q: { prompt_wamid: string; chosen_ref: string; number_id: string; now_ms: number }): WaTakeResult;
  /** Numbers with open threads that are not in the pool (removed from the env); the channel warns at startup. */
  waOrphanNumbers(pool: string[], owner_phone: string): string[];
}

/**
 * The routing gate: may a plain (unquoted) reply sent at `sent_at_ms` go straight to this thread, the only open one on its
 * number? Fails closed: no timestamp, no accepted opener, or a reused number without a confirmation before the message.
 */
export function isActive(t: WaOpenThread, sent_at_ms: number | undefined): boolean {
  if (!t.provider_ref || t.accepted_at_ms === null || sent_at_ms === undefined) return false;
  if (!t.reused) return sent_at_ms >= t.accepted_at_ms + ACCEPT_SKEW_MS;
  const confirmed = [t.opener_read_at_ms, t.confirmed_at_ms].filter((v): v is number => v !== null);
  return confirmed.some((at) => at <= sent_at_ms);
}
