// Abuse limits that only apply in demo mode, on top of the normal per-IP and
// per-contact limits: the playground is public and its calendar and Slack
// channel are shared by everyone who tries it.

import type { NextFunction, Request, Response } from "express";
import { err, type GatewayError } from "../errors.js";
import { clientIp, ipBucket, TtlCounter, type ClientIpOptions } from "../middleware/ratelimit.js";
import { routeKind } from "./traffic.js";
import { classifyVendor } from "./vendor.js";

export const DEMO_LIMITS = {
  /** POST /api/book per IP per day. */
  bookings_per_ip_per_day: 10,
  /** POST /api/book per vendor per hour (all callers of one vendor together). */
  bookings_per_vendor_per_hour: 30,
  /** leave_message and follow-ups per IP per day. */
  messages_per_ip_per_day: 30,
} as const;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function demoLimits(onError: (res: Response, e: GatewayError) => void, opts: ClientIpOptions & { now?: () => number; limits?: Record<keyof typeof DEMO_LIMITS, number> } = {}) {
  const limits = opts.limits ?? DEMO_LIMITS;
  const now = opts.now ?? Date.now;
  const bookIp = new TtlCounter(DAY_MS);
  const bookVendor = new TtlCounter(HOUR_MS);
  const msgIp = new TtlCounter(DAY_MS);
  const refuse = (res: Response, wait: number, what: string) =>
    onError(res, err("rate_limited", `Playground limit: too many ${what}; retry in ${wait}s`, { retry_after_s: wait }).error);
  return (req: Request, res: Response, next: NextFunction) => {
    const kind = routeKind(req.method, req.path);
    const t = now();
    if (kind === "book") {
      const ip = ipBucket(clientIp(req, opts));
      const vendor = classifyVendor(req.get("user-agent"), req.get("x-agent-name"));
      // Check both before counting either, so a refused request spends nothing.
      const wait = bookIp.peek(ip, limits.bookings_per_ip_per_day, t) ?? bookVendor.peek(vendor, limits.bookings_per_vendor_per_hour, t);
      if (wait !== null) return refuse(res, wait, "bookings");
      bookIp.hit(ip, limits.bookings_per_ip_per_day, t);
      bookVendor.hit(vendor, limits.bookings_per_vendor_per_hour, t);
    } else if (kind === "message" && req.method === "POST" && !req.path.endsWith("/close")) {
      const wait = msgIp.hit(ipBucket(clientIp(req, opts)), limits.messages_per_ip_per_day, t);
      if (wait !== null) return refuse(res, wait, "messages");
    }
    next();
  };
}
