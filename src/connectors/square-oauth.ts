// Square OAuth for the setup wizard and the running gateway.
//
// Code flow with the application secret (not PKCE): its refresh token is
// multi-use and never expires, so `.env` can hold it and the gateway mints
// its own 30-day access tokens without persisting anything.
//
// Wizard:  authorizeUrl -> merchant clicks Allow -> waitForCallback catches the
//          code on localhost -> obtainToken -> listLocations.
// Gateway: SquareTokenSource refreshes on first use and again a day before
//          each access token expires.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { ConnectorError } from "./types.js";
import { SQUARE_VERSION } from "./square.js";

export type SquareEnv = "sandbox" | "production";

/** Buyer-level scopes: enough to read services, find slots and book, move or cancel. Nothing about payments. */
export const SQUARE_SCOPES = [
  "APPOINTMENTS_READ",
  "APPOINTMENTS_WRITE",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "ITEMS_READ",
  "MERCHANT_PROFILE_READ",
] as const;

export const DEFAULT_CALLBACK_PORT = 3099;
export const callbackUrl = (port: number) => `http://localhost:${port}/callback`;

export function squareBase(env: SquareEnv): string {
  return env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

export interface SquareApp {
  appId: string;
  appSecret: string;
  env: SquareEnv;
}

export interface SquareTokens {
  accessToken: string;
  refreshToken: string | undefined;
  /** ISO timestamp, absent when Square did not say. */
  expiresAt: string | undefined;
  merchantId: string | undefined;
}

export function authorizeUrl(app: Pick<SquareApp, "appId" | "env">, state: string, redirectUri?: string): string {
  const u = new URL("/oauth2/authorize", squareBase(app.env));
  u.searchParams.set("client_id", app.appId);
  u.searchParams.set("state", state);
  // Square wants the scopes joined with "+", which URLSearchParams would encode as %2B.
  if (redirectUri) u.searchParams.set("redirect_uri", redirectUri);
  return `${u.toString()}&scope=${SQUARE_SCOPES.join("+")}`;
}

export const newState = () => randomBytes(16).toString("hex");

type Fetch = typeof fetch;

async function tokenRequest(app: SquareApp, body: Record<string, unknown>, fetchImpl: Fetch): Promise<SquareTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`${squareBase(app.env)}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "square-version": SQUARE_VERSION },
      body: JSON.stringify({ client_id: app.appId, client_secret: app.appSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ConnectorError("calendar_unavailable", `Square OAuth: ${(e as Error).message}`, { retry_after_s: 5 });
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: string;
    merchant_id?: string;
    errors?: { code?: string; detail?: string }[];
    message?: string;
  };
  if (!res.ok || !json.access_token) {
    const why = json.errors?.[0] ? `${json.errors[0].code ?? ""} ${json.errors[0].detail ?? ""}`.trim() : (json.message ?? `HTTP ${res.status}`);
    throw new ConnectorError(res.status >= 500 ? "calendar_unavailable" : "calendar_auth_failed", `Square OAuth token request failed: ${why}`);
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_at, merchantId: json.merchant_id };
}

/** Exchange the authorization code. `redirectUri` must match what the authorize URL carried, if anything. */
export function obtainToken(app: SquareApp, code: string, redirectUri: string | undefined, fetchImpl: Fetch = fetch): Promise<SquareTokens> {
  return tokenRequest(app, { grant_type: "authorization_code", code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) }, fetchImpl);
}

export function refreshToken(app: SquareApp, token: string, fetchImpl: Fetch = fetch): Promise<SquareTokens> {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: token }, fetchImpl);
}

export interface SquareLocation {
  id: string;
  name: string;
  status: string | undefined;
  timezone: string | undefined;
}

export async function listLocations(env: SquareEnv, accessToken: string, fetchImpl: Fetch = fetch): Promise<SquareLocation[]> {
  const res = await fetchImpl(`${squareBase(env)}/v2/locations`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "square-version": SQUARE_VERSION },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { locations?: { id: string; name?: string; status?: string; timezone?: string }[]; errors?: { detail?: string }[] };
  if (!res.ok) throw new ConnectorError("calendar_auth_failed", `Square ListLocations failed: ${json.errors?.[0]?.detail ?? `HTTP ${res.status}`}`);
  return (json.locations ?? []).map((l) => ({ id: l.id, name: l.name ?? l.id, status: l.status, timezone: l.timezone }));
}

/**
 * Listen on localhost for Square's redirect and resolve with the code once a
 * request arrives with the expected state. Rejects on timeout or a Square error.
 */
export function waitForCallback(port: number, state: string, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    // Query values come from whoever hit the listener; never put them in the page raw.
    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;margin:3rem"><h1>${esc(title)}</h1><p>${esc(body)}</p>`;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const okState = u.searchParams.get("state") === state;
      if (err || !code || !okState) {
        const why = err ? `${err}: ${u.searchParams.get("error_description") ?? ""}` : !okState ? "state mismatch (stale or forged link)" : "no code";
        res.writeHead(400, { "content-type": "text/html" }).end(page("Square authorisation failed", `${why}. Go back to the terminal.`));
        if (okState || err) finish(new Error(`Square authorisation failed: ${why}`));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(page("Square connected", "You can close this tab and return to the terminal."));
      finish(undefined, code);
    });
    const timer = setTimeout(() => finish(new Error(`no response from Square within ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
    const finish = (e: Error | undefined, code?: string) => {
      clearTimeout(timer);
      server.close();
      e ? reject(e) : resolve(code!);
    };
    server.on("error", (e) => finish(new Error(`cannot listen on port ${port}: ${e.message}`)));
    server.listen(port, "127.0.0.1");
  });
}

const DAY_MS = 86_400_000;

/**
 * Hands the connector a valid access token. With a refresh token it refreshes
 * on first use (so a stale SQUARE_ACCESS_TOKEN in .env does no harm) and again
 * a day before expiry; without one it returns the static token.
 */
export class SquareTokenSource {
  private token: string;
  private expiresAtMs = 0;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly opts: {
      accessToken: string;
      refreshToken?: string | undefined;
      app?: SquareApp | undefined;
      fetch?: Fetch;
      now?: () => number;
      warn?: (msg: string) => void;
    },
  ) {
    this.token = opts.accessToken;
  }

  get canRefresh(): boolean {
    return !!(this.opts.refreshToken && this.opts.app);
  }

  async get(): Promise<string> {
    if (!this.canRefresh) return this.token;
    const now = (this.opts.now ?? Date.now)();
    if (this.expiresAtMs && now < this.expiresAtMs - DAY_MS) return this.token;
    this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const warn = this.opts.warn ?? ((m: string) => console.warn(m));
    try {
      const t = await refreshToken(this.opts.app!, this.opts.refreshToken!, this.opts.fetch ?? fetch);
      this.token = t.accessToken;
      this.expiresAtMs = t.expiresAt ? Date.parse(t.expiresAt) : (this.opts.now ?? Date.now)() + 29 * DAY_MS;
      if (t.refreshToken && t.refreshToken !== this.opts.refreshToken) {
        warn("[gateway] Square returned a new refresh token; put it in .env as SQUARE_REFRESH_TOKEN before the next restart");
      }
      return this.token;
    } catch (e) {
      if (!this.expiresAtMs) {
        // Never refreshed: fall back to the static token rather than refuse to start.
        warn(`[gateway] Square token refresh failed (${(e as Error).message}); using SQUARE_ACCESS_TOKEN as is`);
        this.expiresAtMs = (this.opts.now ?? Date.now)() + DAY_MS + 60 * 60_000; // retry in an hour
        return this.token;
      }
      throw e;
    }
  }
}
