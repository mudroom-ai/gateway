// Agent traffic for the playground (demo mode only): one row per /api request
// with the vendor, the kind of request and its outcome, and the public feed
// built from it. The table holds no free text and no contact details: the
// visitor column is a hash of IP and user-agent under a salt that lives only
// in memory and changes every UTC day, so it counts distinct agents per day
// but cannot be linked across days or back to an address.

import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { DateTime } from "luxon";
import { clientIp, ipBucket, type ClientIpOptions } from "../middleware/ratelimit.js";
import type { Store } from "../store/sqlite.js";
import { classifyVendor, feedVendor, VENDORS, type Vendor } from "./vendor.js";

export const ROUTE_KINDS = ["services", "slots", "quote", "book", "cancel", "reschedule", "message"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_requests (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms   INTEGER NOT NULL,
  vendor  TEXT NOT NULL,
  route   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  visitor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_requests_at ON agent_requests (at_ms);
`;

/** Never recorded, and skipped in the feed for rows stored before that rule. */
const HIDDEN_OUTCOME = "invalid_request";
const SHOWN = `outcome != '${HIDDEN_OUTCOME}'`;

/** Rows older than this are deleted on each insert pass; the feed looks back 7 days. */
const KEEP_MS = 30 * 86_400_000;

/** The route kind for an /api path (relative to /api), or null for paths the feed ignores. Case-insensitive like Express's routing, so the demo caps cannot be dodged with /api/BOOK. */
export function routeKind(method: string, path: string): RouteKind | null {
  const p = path.toLowerCase().replace(/\/+$/, "");
  if (method === "GET" && p === "/services") return "services";
  if (method === "POST") {
    const m = /^\/(slots|quote|book|cancel|reschedule)$/.exec(p);
    if (m) return m[1] as RouteKind;
    if (p === "/messages" || /^\/threads\/[^/]+\/(messages|close)$/.test(p)) return "message";
  }
  if (method === "GET" && /^\/threads\/[^/]+$/.test(p)) return "message";
  return null;
}

/** Only a known error code (lowercase snake case) is stored; anything else is "error". */
export function outcomeOf(status: number, body: unknown): string {
  if (status < 400) return "ok";
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "error";
}

export interface FeedItem {
  vendor: Vendor;
  route: RouteKind;
  outcome: string;
  at: string;
}

export interface Feed {
  recent: FeedItem[];
  /** Distinct agents (salted IP + user-agent, per UTC day) and requests, merchant-local today and the last 7 days. */
  today: { agents: number; requests: number; by_vendor: Record<Vendor, number> };
  week: { agents: number; requests: number; by_vendor: Record<Vendor, number> };
  bookings: { total: number; by_vendor: Record<Vendor, number> };
}

export class AgentTraffic {
  private salt = { day: "", value: Buffer.alloc(0) };

  constructor(
    private readonly store: Store,
    private readonly timezone: string,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(SCHEMA);
  }

  /** Pseudonymous visitor id: never stored with the IP, and unlinkable once the day's salt is gone. */
  visitor(ip: string, ua: string): string {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.salt.day !== day) this.salt = { day, value: randomBytes(16) };
    return createHash("sha256").update(this.salt.value).update(`${ipBucket(ip)}\u0000${ua}`).digest("hex").slice(0, 16);
  }

  record(r: { vendor: Vendor; route: RouteKind; outcome: string; visitor: string }): void {
    const t = this.now();
    this.store.db.prepare("INSERT INTO agent_requests (at_ms, vendor, route, outcome, visitor) VALUES (?, ?, ?, ?, ?)").run(t, r.vendor, r.route, r.outcome, r.visitor);
    this.store.db.prepare("DELETE FROM agent_requests WHERE at_ms < ?").run(t - KEEP_MS);
  }

  /** Express middleware for /api: records each request once it finishes. Never changes the response. */
  middleware(ipOpts: ClientIpOptions = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
      const route = routeKind(req.method, req.path);
      if (!route) return next();
      let body: unknown;
      const json = res.json.bind(res);
      res.json = (b: unknown) => {
        body = b;
        return json(b);
      };
      res.on("finish", () => {
        try {
          const outcome = outcomeOf(res.statusCode, body);
          // A malformed request is noise on a public showcase, not agent activity.
          if (outcome === HIDDEN_OUTCOME) return;
          const ua = req.get("user-agent") ?? "";
          this.record({
            vendor: classifyVendor(ua, req.get("x-agent-name")),
            route,
            outcome,
            visitor: this.visitor(clientIp(req, ipOpts), ua),
          });
        } catch (e) {
          console.error(`[demo] traffic record failed: ${(e as Error).message}`);
        }
      });
      next();
    };
  }

  feed(): Feed {
    const now = this.now();
    const dayStart = DateTime.fromMillis(now, { zone: this.timezone }).startOf("day").toMillis();
    const weekStart = now - 7 * 86_400_000;
    const db = this.store.db;
    const recent = (db.prepare(`SELECT vendor, route, outcome, at_ms FROM agent_requests WHERE ${SHOWN} ORDER BY id DESC LIMIT 10`).all() as Record<string, unknown>[]).map(
      (r): FeedItem => ({ vendor: feedVendor(r.vendor as string), route: r.route as RouteKind, outcome: r.outcome as string, at: new Date(Number(r.at_ms)).toISOString() }),
    );
    const span = (since: number) => {
      const rows = db.prepare(`SELECT vendor, COUNT(*) AS n FROM agent_requests WHERE at_ms >= ? AND ${SHOWN} GROUP BY vendor`).all(since) as { vendor: Vendor; n: number }[];
      // A visitor id is per UTC day, so a week counts one agent once per day it called.
      const agents = db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT visitor, at_ms / 86400000 AS d FROM agent_requests WHERE at_ms >= ? AND ${SHOWN})`)
        .get(since) as { n: number };
      const by_vendor = byVendor(rows);
      return { agents: Number(agents.n), requests: Object.values(by_vendor).reduce((a, b) => a + b, 0), by_vendor };
    };
    const booked = byVendor(db.prepare("SELECT vendor, COUNT(*) AS n FROM agent_requests WHERE route = 'book' AND outcome = 'ok' GROUP BY vendor").all() as { vendor: Vendor; n: number }[]);
    return {
      recent,
      today: span(dayStart),
      week: span(weekStart),
      bookings: { total: Object.values(booked).reduce((a, b) => a + b, 0), by_vendor: booked },
    };
  }
}

function byVendor(rows: { vendor: Vendor; n: number }[]): Record<Vendor, number> {
  const out = Object.fromEntries(VENDORS.map((v) => [v, 0])) as Record<Vendor, number>;
  for (const r of rows) out[feedVendor(r.vendor)] += Number(r.n);
  return out;
}
