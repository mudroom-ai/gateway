import { describe, expect, it } from "vitest";
import { SquareTokenSource, authorizeUrl, obtainToken, waitForCallback } from "../src/connectors/square-oauth.js";

const APP = { appId: "sq0idp-app", appSecret: "sq0csp-secret", env: "sandbox" as const };

function tokenServer(reply: (body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(String(url)).toBe("https://connect.squareupsandbox.com/oauth2/token");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify(reply(body)), { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("Square OAuth", () => {
  it("builds the authorize link with buyer scopes joined by + and the state", () => {
    const url = authorizeUrl(APP, "abc123");
    expect(url.startsWith("https://connect.squareupsandbox.com/oauth2/authorize?client_id=sq0idp-app&state=abc123")).toBe(true);
    expect(url).toContain("&scope=APPOINTMENTS_READ+APPOINTMENTS_WRITE+");
    expect(url).not.toContain("PAYMENTS");
    expect(url).not.toContain("ALL_WRITE");
  });

  it("exchanges the code with the app secret and returns the tokens", async () => {
    const { calls, fetchImpl } = tokenServer(() => ({ access_token: "at", refresh_token: "rt", expires_at: "2026-11-07T00:00:00Z", merchant_id: "M1" }));
    const t = await obtainToken(APP, "code-1", undefined, fetchImpl);
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-07T00:00:00Z", merchantId: "M1" });
    expect(calls[0]).toEqual({ client_id: "sq0idp-app", client_secret: "sq0csp-secret", grant_type: "authorization_code", code: "code-1" });
  });

  it("token source refreshes on first use, then not again until a day before expiry", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    let n = 0;
    const { calls, fetchImpl } = tokenServer(() => ({ access_token: `at${++n}`, refresh_token: "rt", expires_at: "2026-11-07T00:00:00Z" }));
    const src = new SquareTokenSource({ accessToken: "stale", refreshToken: "rt", app: APP, fetch: fetchImpl, now: () => now, warn: () => {} });
    expect(await Promise.all([src.get(), src.get()])).toEqual(["at1", "at1"]); // concurrent calls share one refresh
    expect(calls).toEqual([{ client_id: "sq0idp-app", client_secret: "sq0csp-secret", grant_type: "refresh_token", refresh_token: "rt" }]);
    now = Date.parse("2026-11-05T00:00:00Z");
    expect(await src.get()).toBe("at1");
    now = Date.parse("2026-11-06T12:00:00Z");
    expect(await src.get()).toBe("at2");
  });

  it("token source without a refresh token returns the static token; a failed first refresh falls back to it", async () => {
    const plain = new SquareTokenSource({ accessToken: "fixed" });
    expect(plain.canRefresh).toBe(false);
    expect(await plain.get()).toBe("fixed");
    const warnings: string[] = [];
    const failing: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "bad secret" }] }), { status: 401 });
    const src = new SquareTokenSource({ accessToken: "fixed", refreshToken: "rt", app: APP, fetch: failing, warn: (m) => warnings.push(m) });
    expect(await src.get()).toBe("fixed");
    expect(warnings[0]).toContain("bad secret");
  });

  it("the callback listener accepts the code only with the expected state, and reports the stale one", async () => {
    const port = 3000 + Math.floor(Math.random() * 20000);
    const ignored: string[] = [];
    const pending = waitForCallback(port, "good", 5000, (why) => ignored.push(why));
    const bad = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=forged`);
    expect(bad.status).toBe(400);
    expect(ignored).toEqual(["redirect from an older Square link (state mismatch)"]);
    // localhost may resolve to ::1 first; the listener answers there too.
    const ok = await fetch(`http://[::1]:${port}/callback?code=the-code&state=good`);
    expect(ok.status).toBe(200);
    expect(await pending).toBe("the-code");
  });
});

describe("callback page", () => {
  it("escapes what Square (or anyone) puts in the query string", async () => {
    const port = 3000 + Math.floor(Math.random() * 20000);
    // Attach the rejection handler before the request: the listener rejects as soon as it sees the error.
    const pending = expect(waitForCallback(port, "s", 5000)).rejects.toThrow("Square authorisation failed");
    const res = await fetch(`http://127.0.0.1:${port}/callback?error=<script>alert(1)</script>&state=s`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<script>");
    await pending;
  });
});
