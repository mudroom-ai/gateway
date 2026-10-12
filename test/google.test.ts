import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleCalendarConnector } from "../src/connectors/google.js";
import { ConnectorError } from "../src/connectors/types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = JSON.stringify({
  client_email: "gw@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const CAL = "merchant@example.com";
const range = { start: "2026-10-08T00:00:00-07:00", end: "2026-10-09T00:00:00-07:00" };

type Handler = (url: string, init: RequestInit) => Response | "hang";

function fakeFetch(api: Handler[]) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    calls.push(`${init.method ?? "GET"} ${url}`);
    const h = api.shift();
    if (!h) throw new Error(`unexpected call ${url}`);
    const r = h(url, init);
    if (r !== "hang") return r;
    return new Promise<Response>((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    );
  }) as typeof fetch;
  return { f, calls };
}

function connector(f: typeof fetch) {
  return new GoogleCalendarConnector({
    serviceAccountJson: SA,
    calendarId: CAL,
    timeoutMs: 20,
    fetch: f,
    sleep: async () => {},
  });
}

const busyOk = () =>
  Response.json({
    calendars: { [CAL]: { busy: [{ start: "2026-10-08T17:00:00Z", end: "2026-10-08T18:00:00Z" }] } },
  });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ConnectorError ? e.code : `other: ${String(e)}`;
  }
}

describe("google connector (fake HTTP)", () => {
  it("freebusy timeout twice -> calendar_unavailable after one retry", async () => {
    const { f, calls } = fakeFetch([() => "hang", () => "hang"]);
    expect(await codeOf(connector(f).getBusy(range))).toBe("calendar_unavailable");
    expect(calls).toHaveLength(2);
  });

  it("freebusy 5xx then ok -> busy intervals", async () => {
    const { f, calls } = fakeFetch([() => new Response("boom", { status: 503 }), busyOk]);
    const busy = await connector(f).getBusy(range);
    expect(busy).toEqual([{ start: "2026-10-08T17:00:00Z", end: "2026-10-08T18:00:00Z" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("POST https://www.googleapis.com/calendar/v3/freeBusy");
  });

  it("getEvent treats a deleted (status cancelled) event as missing", async () => {
    const { f } = fakeFetch([
      () => Response.json({ id: "abc123", status: "cancelled", start: { dateTime: "2026-10-08T10:00:00-07:00" }, end: { dateTime: "2026-10-08T11:00:00-07:00" } }),
      () => Response.json({ id: "abc123", status: "confirmed", start: { dateTime: "2026-10-08T10:00:00-07:00" }, end: { dateTime: "2026-10-08T11:00:00-07:00" } }),
    ]);
    const c = connector(f);
    expect(await c.getEvent("abc123")).toBeNull();
    expect((await c.getEvent("abc123"))?.id).toBe("abc123");
  });

  it("insert 409 -> already_exists, not retried", async () => {
    const { f, calls } = fakeFetch([
      () => Response.json({ error: { code: 409, message: "The requested identifier already exists." } }, { status: 409 }),
    ]);
    const code = await codeOf(
      connector(f).insertEvent({
        id: "abc123",
        start: "2026-10-08T10:00:00-07:00",
        end: "2026-10-08T11:00:00-07:00",
        title: "Haircut",
        description: "",
      }),
    );
    expect(code).toBe("already_exists");
    expect(calls).toHaveLength(1);
  });
});
