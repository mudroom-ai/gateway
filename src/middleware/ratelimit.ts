// Rate limits, in memory, TTL-bounded maps (one gateway replica):
//   - per request: anonymous per IP (per_ip_per_min) or per bearer key (per_key_per_min)
//   - per customer contact on book: attempts per hour + cap on open (future) bookings
//   - leave_message / follow_up: per contact per hour plus a merchant-wide hourly cap
//     (messageRateLimit; the message core calls it after validation, so junk never spends quota)
// Contact limits wrap the core `book` op, not the HTTP route.
// An idempotent retry (key already known) always bypasses contact limits.
// Attempts count only for well-formed requests on a live quote (no junk lockouts).

import { isIP, isIPv4, isIPv6 } from "node:net";
import type { NextFunction, Request, Response } from "express";
import type { Limits } from "../config.js";
import { err, type GatewayError, type Result } from "../errors.js";
import type { BookRequest, Booking } from "../types.js";
import { normalizeCustomer, validateCustomer } from "../book.js";
import { getAuth } from "./auth.js";

/** Fixed-window counters with expiry; bounded to `maxKeys` entries. */
export class TtlCounter {
  private readonly m = new Map<string, { count: number; reset_at: number }>();

  constructor(
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.m.size;
  }

  /** Count a hit. Returns null if allowed, else seconds until the window resets. */
  hit(key: string, limit: number, nowMs: number): number | null {
    let e = this.m.get(key);
    if (!e || e.reset_at <= nowMs) {
      this.m.delete(key);
      e = { count: 0, reset_at: nowMs + this.windowMs };
      this.prune(nowMs);
      this.m.set(key, e);
    }
    if (e.count >= limit) return Math.max(1, Math.ceil((e.reset_at - nowMs) / 1000));
    e.count++;
    return null;
  }

  /** Seconds until `key` may hit again, or null if a hit now would be allowed. Counts nothing. */
  peek(key: string, limit: number, nowMs: number): number | null {
    const e = this.m.get(key);
    if (!e || e.reset_at <= nowMs || e.count < limit) return null;
    return Math.max(1, Math.ceil((e.reset_at - nowMs) / 1000));
  }

  private prune(nowMs: number): void {
    if (this.m.size < this.maxKeys) return;
    for (const [k, v] of this.m) if (v.reset_at <= nowMs) this.m.delete(k);
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const k of this.m.keys()) {
      if (this.m.size < this.maxKeys) break;
      this.m.delete(k);
    }
  }
}

export interface ClientIpOptions {
  /** Honor CF-Connecting-IP from a trusted peer (TRUST_CF_CONNECTING_IP and an address-list TRUST_PROXY). */
  trustCfHeader?: boolean;
  /** Log how the IP was resolved (TRUST_PROXY_DEBUG). */
  debug?: boolean;
}

type TrustFn = (addr: string, i: number) => boolean;

/**
 * Caller IP, resolved by Express's "trust proxy" setting (TRUST_PROXY, default loopback):
 * req.ip walks X-Forwarded-For from the right and stops at the first untrusted hop.
 * CF-Connecting-IP is used only when opted in and the immediate peer is a trusted proxy: a non-Cloudflare
 * local proxy (nginx, Caddy) passes a client-supplied CF-Connecting-IP straight through.
 */
export function clientIp(req: Request, opts: ClientIpOptions = {}): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const trust = req.app.get("trust proxy fn") as TrustFn | undefined;
  const cf = req.get("cf-connecting-ip")?.trim();
  const ip = opts.trustCfHeader && cf && isIP(cf) && trust?.(peer, 0) ? cf : (req.ip ?? peer);
  if (opts.debug) {
    console.log(
      `[gateway] client ip: peer=${peer} x-forwarded-for=${JSON.stringify(req.get("x-forwarded-for") ?? null)} cf-connecting-ip=${JSON.stringify(cf ?? null)} -> ${ip}`,
    );
  }
  return ip;
}

/** Rate-limit bucket for an IP: IPv4 as is, IPv6 by /64 (one host typically owns a whole /64). */
export function ipBucket(ip: string): string {
  if (isIPv4(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head = "", tail] = ip.toLowerCase().split("%")[0]!.split("::");
  const h = groups(head);
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - groups(tail).length).fill("0"), ...groups(tail)];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** Per-IP (anonymous) or per-key request limit. Must run after authMiddleware. */
export function requestRateLimit(
  limits: Limits,
  onError: (res: Response, e: GatewayError) => void,
  opts: { counter?: TtlCounter; now?: () => number } & ClientIpOptions = {},
) {
  const counter = opts.counter ?? new TtlCounter(60_000);
  const now = opts.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    const [key, limit] =
      auth.kind === "key" ? [`k:${auth.key_id}`, limits.per_key_per_min] : [`ip:${ipBucket(clientIp(req, opts))}`, limits.per_ip_per_min];
    const wait = counter.hit(key, limit, now());
    if (wait !== null) {
      return onError(res, err("rate_limited", `Too many requests; retry in ${wait}s`, { retry_after_s: wait }).error);
    }
    next();
  };
}

/** Normalized contact keys for a customer: lowercased email, phone digits. */
export function contactKeys(customer: unknown): string[] {
  const c = (customer && typeof customer === "object" ? customer : {}) as Record<string, unknown>;
  const keys: string[] = [];
  if (typeof c.email === "string" && c.email.trim()) keys.push(`e:${c.email.trim().toLowerCase()}`);
  if (typeof c.phone === "string") {
    const d = c.phone.replace(/\D/g, "");
    if (d) keys.push(`p:${d}`);
  }
  return keys;
}

export interface ContactGuardDeps {
  limits: Limits;
  /** True when this idempotency key already has a booking row (retry/reconcile). */
  isKnownKey: (idempotencyKey: string) => boolean;
  /** True when quoteId is an open, unexpired quote of this merchant. */
  isOpenQuote: (quoteId: string, nowMs: number) => boolean;
  /** Open (pending or future booked) bookings for any of these contact keys. */
  countOpenBookings: (keys: string[], nowMs: number) => number;
  now?: () => number;
  counter?: TtlCounter;
  lock?: KeyedLock;
}

type BookFn = (req: BookRequest) => Promise<Result<Booking>>;

/**
 * In-process async mutex keyed by string (one replica). `run` takes all its keys at
 * once, synchronously, so callers queue FIFO per key and can't deadlock.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ks = [...new Set(keys)];
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = ks.map((k) => this.tails.get(k));
    for (const k of ks) this.tails.set(k, mine);
    try {
      await Promise.all(before);
      return await fn();
    } finally {
      release();
      for (const k of ks) if (this.tails.get(k) === mine) this.tails.delete(k);
    }
  }
}

/** Wrap `book` with the per-contact hourly limit and open-booking cap. */
export function withContactLimits(book: BookFn, deps: ContactGuardDeps): BookFn {
  const counter = deps.counter ?? new TtlCounter(3_600_000);
  const lock = deps.lock ?? new KeyedLock();
  const now = deps.now ?? Date.now;
  return async (req) => {
    const key = req?.idempotency_key;
    if (typeof key === "string" && key && deps.isKnownKey(key)) return book(req);
    const keys = contactKeys(req?.customer);
    if (keys.length === 0) return book(req); // core returns invalid_customer
    const t = now();
    // Only a well-formed request for a live quote spends the contact's quota; anything
    // else fails in core, so junk requests naming a victim's contact can't lock them out.
    const live =
      typeof key === "string" &&
      key.length >= 1 &&
      key.length <= 255 &&
      typeof req.quote_id === "string" &&
      deps.isOpenQuote(req.quote_id, t) &&
      validateCustomer(normalizeCustomer(req.customer)) === null;
    if (!live) return book(req);
    for (const k of keys) {
      const wait = counter.hit(k, deps.limits.per_contact_per_hour, t);
      if (wait !== null) {
        return err("rate_limited", `Too many booking attempts for this contact; retry in ${wait}s`, { retry_after_s: wait });
      }
    }
    // Serialize count + book per contact so concurrent requests can't exceed the cap.
    return lock.run(keys, async () => {
      const open = deps.countOpenBookings(keys, now());
      if (open >= deps.limits.max_open_bookings_per_contact) {
        return err(
          "contact_limit_reached",
          `This contact already has ${open} upcoming booking(s); the limit is ${deps.limits.max_open_bookings_per_contact}`,
        );
      }
      return book(req);
    });
  };
}

/** Minimal slice of the SQLite store the contact guard reads. */
export interface BookingsDb {
  prepare(sql: string): { all(...params: (string | number)[]): unknown[]; get(...params: (string | number)[]): unknown };
}

/** countOpenBookings / isKnownKey / isOpenQuote backed by the `bookings` table. */
export function sqliteContactLookups(db: BookingsDb, merchantId: string) {
  return {
    isKnownKey: (idemKey: string) =>
      db.prepare("SELECT 1 AS x FROM bookings WHERE merchant_id = ? AND idem_key = ?").get(merchantId, idemKey) !== undefined,
    isOpenQuote: (quoteId: string, nowMs: number) =>
      db
        .prepare("SELECT 1 AS x FROM quotes WHERE quote_id = ? AND merchant_id = ? AND state = 'open' AND expires_at_ms > ?")
        .get(quoteId, merchantId, nowMs) !== undefined,
    countOpenBookings: (keys: string[], nowMs: number) => {
      const want = new Set(keys);
      const rows = db
        .prepare("SELECT customer FROM bookings WHERE merchant_id = ? AND (state = 'pending' OR (state = 'booked' AND start_ms > ?))")
        .all(merchantId, nowMs) as { customer: string }[];
      let n = 0;
      for (const r of rows) {
        let c: unknown;
        try {
          c = JSON.parse(r.customer);
        } catch {
          continue;
        }
        if (contactKeys(c).some((k) => want.has(k))) n++;
      }
      return n;
    },
  };
}

export interface MessageRateLimitOptions {
  merchant?: TtlCounter;
  contact?: TtlCounter;
}

/**
 * Hourly limits for owner messages. Returns null when allowed, else the rate_limited
 * error. Called by the message core only for well-formed requests (same rule as
 * withContactLimits), so a junk request naming a victim's contact spends nothing.
 * `keys` empty = a follow-up: only the merchant-wide cap applies.
 */
export function messageRateLimit(limits: Limits, opts: MessageRateLimitOptions = {}) {
  const merchant = opts.merchant ?? new TtlCounter(3_600_000);
  const contact = opts.contact ?? new TtlCounter(3_600_000);
  return (keys: string[], nowMs: number): GatewayError | null => {
    // Check every counter before counting any, so a request refused by one cap spends nothing on the others.
    for (const k of keys) {
      const wait = contact.peek(k, limits.per_contact_per_hour, nowMs);
      if (wait !== null) return err("rate_limited", `Too many messages for this contact; retry in ${wait}s`, { retry_after_s: wait }).error;
    }
    const wait = merchant.peek("merchant", limits.max_messages_per_hour, nowMs);
    if (wait !== null) {
      return err("rate_limited", `This business is receiving too many messages right now; retry in ${wait}s`, { retry_after_s: wait }).error;
    }
    for (const k of keys) contact.hit(k, limits.per_contact_per_hour, nowMs);
    merchant.hit("merchant", limits.max_messages_per_hour, nowMs);
    return null;
  };
}
