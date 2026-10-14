// Demo mode (config `demo: true` or DEMO_MODE=1): the public agent playground.
// Off by default; with it off nothing in this folder runs and the gateway
// behaves exactly as before. With it on:
//   - `/` in a browser is the playground page (src/demo/page.ts); agents still get the markdown,
//   - every /api request is counted by vendor for GET /demo/feed (src/demo/traffic.ts),
//   - events are titled "[demo] ..." and bookings cancel themselves after an hour (src/demo/cleanup.ts),
//   - an owner thread unanswered for 10 minutes gets a templated owner reply (messages.ts ownerAway),
//   - bookings and messages have extra per-IP and per-vendor caps (src/demo/limits.ts).

import type { Express, RequestHandler, Response } from "express";
import type { BookingConnector } from "../connectors/types.js";
import type { GatewayError } from "../errors.js";
import type { ClientIpOptions } from "../middleware/ratelimit.js";
import type { Store } from "../store/sqlite.js";
import { startDemoJanitor } from "./cleanup.js";
import { demoLimits } from "./limits.js";
import { DEMO_BOOKING_TTL_MIN } from "./page.js";
import { AgentTraffic } from "./traffic.js";

export { demoConnector } from "./cleanup.js";
export { playgroundPage } from "./page.js";

export const OWNER_AWAY_AFTER_MS = 10 * 60_000;
export const OWNER_AWAY_TEXT = "Thanks, the human owner is away from the desk right now, this is a playground; your booking still goes through.";

/** The /api middleware (traffic first, so refused requests are counted too; limits after auth and the normal rate limit). */
export interface DemoWiring {
  traffic: AgentTraffic;
  record: RequestHandler;
  limits: RequestHandler;
  /** Starts the auto-cancel janitor (main() calls it after listen). Returns a stop function. */
  start(): () => void;
}

export function demoWiring(deps: {
  store: Store;
  connector: BookingConnector;
  merchantId: string;
  timezone: string;
  onError: (res: Response, e: GatewayError) => void;
  ipOpts: ClientIpOptions;
}): DemoWiring {
  const traffic = new AgentTraffic(deps.store, deps.timezone);
  return {
    traffic,
    record: traffic.middleware(deps.ipOpts),
    limits: demoLimits(deps.onError, deps.ipOpts),
    start: () =>
      startDemoJanitor({
        store: deps.store,
        connector: deps.connector,
        merchantId: deps.merchantId,
        timezone: deps.timezone,
        ttlMs: DEMO_BOOKING_TTL_MIN * 60_000,
      }),
  };
}

/** GET /demo/feed: the playground's public JSON. Never cached, so the page sees new rows at once. */
export function feedRoute(app: Express, traffic: AgentTraffic, limit: RequestHandler): void {
  app.get("/demo/feed", limit, (_req, res) => {
    res.set("Cache-Control", "no-store").json(traffic.feed());
  });
}
