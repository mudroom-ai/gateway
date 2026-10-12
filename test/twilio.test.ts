import { describe, expect, it } from "vitest";
import { createTwilioChannel, maskPhone, twilioOwnerChannel } from "../src/connectors/twilio.js";

const PHONE = "+12025550199";
const FROM = "+12025550100";

type Req = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams };

/** Scripted Twilio: records each request and answers with the given response (or throws). */
function twilio(respond: () => Response | Promise<Response> = () => new Response(JSON.stringify({ sid: "SM1" }), { status: 201 })) {
  const reqs: Req[] = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    reqs.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: new URLSearchParams(String(init?.body)),
    });
    return respond();
  };
  const ch = twilioOwnerChannel({ accountSid: "AC123", authToken: "secret-token", from: FROM, to: PHONE, fetch: fetchImpl, warn: (m) => logs.push(m) });
  return { ch, reqs, logs };
}

describe("twilioOwnerChannel", () => {
  it("posts the form to Twilio with Basic auth", async () => {
    const { ch, reqs, logs } = twilio();
    await ch.notify("New booking: Bath and brush, Tue 10:00");
    expect(reqs).toHaveLength(1);
    const r = reqs[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.body.get("To")).toBe(PHONE);
    expect(r.body.get("From")).toBe(FROM);
    expect(r.body.get("Body")).toBe("New booking: Bath and brush, Tue 10:00");
    expect(logs).toEqual([]);
  });

  it("truncates the body to 1500 characters", async () => {
    const { ch, reqs } = twilio();
    await ch.notify("x".repeat(2000));
    expect(reqs[0]!.body.get("Body")).toHaveLength(1500);
  });

  it("logs a non-2xx with Twilio's message and does not throw", async () => {
    const { ch, logs } = twilio(() => new Response(JSON.stringify({ code: 21211, message: "The 'To' number +12025550199 is not a valid phone number." }), { status: 400 }));
    await expect(ch.notify("hi")).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("400");
    expect(logs[0]).toContain("is not a valid phone number");
    expect(logs[0]).toContain("0199");
    expect(logs[0]).not.toContain("2025550199");
    expect(logs[0]).not.toContain("secret-token");
  });

  it("logs a network error and does not throw", async () => {
    const { ch, logs } = twilio(() => {
      throw new TypeError("fetch failed");
    });
    await expect(ch.notify("hi")).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("fetch failed");
    expect(logs[0]).not.toContain("2025550199");
  });
});

describe("createTwilioChannel", () => {
  it("returns undefined when nothing is set", () => {
    expect(createTwilioChannel({})).toBeUndefined();
  });

  it("throws naming the missing vars when partly set", () => {
    expect(() => createTwilioChannel({ twilio_account_sid: "AC123", owner_phone: PHONE })).toThrow(/TWILIO_AUTH_TOKEN, TWILIO_FROM too/);
  });

  it("returns the Twilio channel when all are set", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response("{}", { status: 201 });
    };
    const ch = createTwilioChannel(
      { twilio_account_sid: "AC123", twilio_auth_token: "t", twilio_from: FROM, owner_phone: PHONE },
      { fetch: fetchImpl, warn: () => {} },
    );
    await ch!.notify("hi");
    expect(urls).toEqual(["https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"]);
  });
});

describe("maskPhone", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhone("+1 202 555 0199")).toBe("***0199");
    expect(maskPhone("12")).toBe("****");
  });
});
