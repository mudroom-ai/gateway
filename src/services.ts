// list_services core op. The connector owns the service list: config services
// for calendar-backed merchants, the catalog for Square. Ask-the-owner services
// always come from the config and are listed beside it, never bookable.

import type { Config, ServiceConfig } from "./config.js";
import { ConnectorError, type BookingConnector } from "./connectors/types.js";
import { err, ok, type GatewayError, type Result } from "./errors.js";
import type { AskService, ListServicesResult, Service } from "./types.js";

export function toService(s: ServiceConfig): Service {
  const out: Service = {
    id: s.id,
    name: s.name,
    duration_min: s.duration_min,
    buffer_min: s.buffer_min,
    price_cents: s.price_cents,
  };
  if (s.description !== undefined) out.description = s.description;
  return out;
}

/** The config's ask-the-owner services, minus any whose id is also a bookable service (bookable wins). */
export function askServices(config: Config, bookable: Service[]): AskService[] {
  const taken = new Set(bookable.map((s) => s.id));
  const out: AskService[] = [];
  for (const a of config.ask_services) {
    if (taken.has(a.id)) continue;
    out.push(a.price_note ? { id: a.id, name: a.name, price_note: a.price_note } : { id: a.id, name: a.name });
  }
  return out;
}

/** Map a thrown connector failure to the shared error body. */
export function connectorErr(e: unknown, what: string): { ok: false; error: GatewayError } {
  if (e instanceof ConnectorError && (e.code === "calendar_unavailable" || e.code === "calendar_auth_failed")) {
    return err(e.code, e.message, e.retry_after_s !== undefined ? { retry_after_s: e.retry_after_s } : {});
  }
  return err("internal", `${what} failed`);
}

export async function findService(connector: BookingConnector, id: string): Promise<Service | undefined> {
  return (await connector.listServices()).find((x) => x.id === id);
}

export async function listServices(config: Config, connector: BookingConnector): Promise<Result<ListServicesResult>> {
  let services: Service[];
  try {
    services = await connector.listServices();
  } catch (e) {
    return connectorErr(e, "service lookup");
  }
  const out: ListServicesResult = { currency: config.currency, timezone: config.timezone, services };
  const ask = askServices(config, services);
  if (ask.length) out.ask_services = ask;
  return ok(out);
}
