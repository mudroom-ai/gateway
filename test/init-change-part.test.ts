// "Change one part" on a re-run of `npm run init`: only the picked part is asked, and everything else in
// config.json and .env stays as saved. Terminal flow first, then the browser flow.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildEnvFile, existingItems, runInit, type InitDeps } from "../src/cli/init.js";
import { OWNER_CHANNEL_ITEMS } from "../src/cli/init-channel.js";
import { READY_ITEMS } from "../src/cli/guide.js";
import { startSetupServer, type SetupStep } from "../src/cli/setup-server.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { ScriptedPrompter } from "./helpers/scripted-prompter.js";

const WHATSAPP = OWNER_CHANNEL_ITEMS[3];
const SLACK_LINES = "SLACK_BOT_TOKEN='xoxb-1'\nSLACK_APP_TOKEN='xapp-1'\nSLACK_CHANNEL_ID='C0123'\n";

/** A Google setup as a first run leaves it, plus a hand-added line in .env. */
function googleSetup(extraEnv = "") {
  const dir = mkdtempSync(join(tmpdir(), "gw-part-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, JSON.stringify({ client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" }));
  const config = {
    merchant_id: "sams-shop",
    name: "Sam's Barbers",
    timezone: "Europe/London",
    currency: "GBP",
    services: [{ id: "haircut", name: "Haircut", duration_min: 45, buffer_min: 15, price_cents: 4000 }],
    hours: { mon: [{ start: "09:00", end: "17:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, ".env"), `# hand-edited\nGOOGLE_SERVICE_ACCOUNT_FILE='${keyFile}'\nGOOGLE_CALENDAR_ID='cal@group.calendar.google.com'\nPORT=4000\nALLOWED_HOSTS=sam.trycloudflare.com\n${extraEnv}`);
  return { dir, keyFile };
}

const files = (dir: string) => [readFileSync(join(dir, "config.json"), "utf8"), readFileSync(join(dir, ".env"), "utf8")];
const envOf = (dir: string) => parseEnv(readFileSync(join(dir, ".env"), "utf8"));

async function run(dir: string, answers: (string | boolean)[], deps: Partial<InitDeps> = {}, argv: string[] = []) {
  const prompter = new ScriptedPrompter(answers);
  const logs: string[] = [];
  const calendars: string[] = [];
  const code = await runInit(["--dir", dir, ...argv], {
    env: {},
    prompter,
    makeConnector: (_json, calendarId) => {
      calendars.push(calendarId);
      return new FakeCalendarConnector();
    },
    makeWhatsapp: () => ({ checkAccess: async () => {} }),
    makeSlack: () => ({ checkAccess: async () => {} }),
    log: (m) => logs.push(m),
    ...deps,
  });
  return { code, out: logs.join("\n"), prompter, calendars };
}

const noOAuth: InitDeps["oauth"] = {
  waitForCallback: async () => { throw new Error("Square OAuth must not run"); },
  obtainToken: async () => { throw new Error("Square OAuth must not run"); },
  listLocations: async () => { throw new Error("Square OAuth must not run"); },
  open: () => {},
};

describe("init wizard: Change one part", () => {
  // protects: adding WhatsApp to a Google setup asks only the channel questions and keeps config.json and every other .env value
  it("Google saved -> Owner channel -> WhatsApp: no Google or business prompts, config untouched, Google keys kept", async () => {
    const { dir, keyFile } = googleSetup();
    const [configBefore] = files(dir);
    const r = await run(dir, ["Change one part", "Owner channel", WHATSAPP, READY_ITEMS.yes.label, "+1 202 555 0199", "123456", "EAA-secret-9", "sec", "", ""]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.choices[0]).toEqual(existingItems(true).items);
    expect(r.prompter.prompts.some((q) => /Business or your name|Booking system|Calendar ID|Currency|What do you want agents/.test(q))).toBe(false);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(configBefore);
    expect(envOf(dir)).toMatchObject({
      GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com", PORT: "4000", ALLOWED_HOSTS: "sam.trycloudflare.com",
      OWNER_PHONE: "+1 202 555 0199", WHATSAPP_PHONE_NUMBER_ID: "123456", WHATSAPP_ACCESS_TOKEN: "EAA-secret-9", WHATSAPP_APP_SECRET: "sec",
    });
    expect(r.out).toContain("Changing: Owner channel (none -> WhatsApp");
    expect(r.out).toContain("Booking system (Google Calendar (calendar cal@group.calendar.google.com))");
    expect(r.out).not.toContain("EAA-secret-9");
    expect(r.calendars).toEqual([]); // the kept booking system is not rechecked
  });

  // protects: a kept Square setup never re-runs OAuth, and replacing Slack with WhatsApp is said out loud
  it("Square + Slack saved -> Owner channel -> WhatsApp: no OAuth, Slack replaced and named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-part-sq-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ merchant_id: "foyer", name: "Foyer", timezone: "America/Los_Angeles", currency: "USD", services: [], hours: {} }));
    writeFileSync(join(dir, ".env"), `SQUARE_ENV=sandbox\nSQUARE_ACCESS_TOKEN='at'\nSQUARE_LOCATION_ID='L1'\nSQUARE_APP_ID='app'\nSQUARE_APP_SECRET='sec'\n${SLACK_LINES}`);
    const r = await run(dir, ["Change one part", "Owner channel", WHATSAPP, READY_ITEMS.yes.label, "+1 202 555 0199", "123456", "tok", "sec", "", ""], { oauth: noOAuth });
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.choices[1]!.map((i) => i.label)).toEqual(["Business details", "Booking system", "Owner channel"]); // Square supplies services
    const env = envOf(dir);
    expect(env).toMatchObject({ SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1", SQUARE_APP_SECRET: "sec", WHATSAPP_ACCESS_TOKEN: "tok" });
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(r.out).toContain("Owner channel (Slack C0123 -> WhatsApp");
    expect(r.out).toContain("Slack settings removed from .env");
  });

  // protects: changing the booking system keeps the saved owner channel, and warns about bookings left in the old system
  it("Google + Slack saved -> Booking system -> Square: Slack kept, old-calendar warning shown", async () => {
    const { dir } = googleSetup(SLACK_LINES);
    let authorized = 0;
    const r = await run(dir, ["Change one part", "Booking system", "Square Appointments", READY_ITEMS.yes.label, "sandbox", "app-1", "sec-1", ""], {
      oauth: {
        waitForCallback: async () => { authorized++; return "code"; },
        obtainToken: async () => ({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: undefined, merchantId: "M1" }),
        listLocations: async () => [{ id: "L-1", name: "Shop", status: "ACTIVE", timezone: undefined }],
        open: () => {},
      },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
    });
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(authorized).toBe(1);
    const env = envOf(dir);
    expect(env).toMatchObject({ SQUARE_LOCATION_ID: "L-1", SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", SLACK_CHANNEL_ID: "C0123", PORT: "4000" });
    expect(env.GOOGLE_CALENDAR_ID).toBeUndefined();
    expect(r.out).toContain("Bookings made through Google Calendar (calendar cal@group.calendar.google.com) stay there");
  });

  // protects: "Not yet, finish later" on a new channel keeps the saved one instead of reading as None
  it("Slack saved -> Owner channel -> WhatsApp -> finish later: Slack kept", async () => {
    const { dir } = googleSetup(SLACK_LINES);
    const r = await run(dir, ["Change one part", "Owner channel", WHATSAPP, READY_ITEMS.later.label, ""]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(envOf(dir)).toMatchObject({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL_ID: "C0123" });
    expect(r.out).toContain("Owner channel (Slack C0123, new one not connected)");
  });

  // protects: the terminal's second save choice writes nothing
  it("Exit without saving leaves both files byte-identical", async () => {
    const { dir } = googleSetup();
    const before = files(dir);
    const r = await run(dir, ["Change one part", "Business details", "New Name", "", "Exit without saving"]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(files(dir)).toEqual(before);
    expect(r.out).toContain("Nothing changed.");
  });

  // protects: a business edit writes config.json only: .env keeps its bytes even with --port given; currency is not asked
  it("Business details: name changes, .env untouched, no currency question", async () => {
    const { dir } = googleSetup();
    const [, envBefore] = files(dir);
    const r = await run(dir, ["Change one part", "Business details", "Sam & Co", "", ""], {}, ["--port", "5000"]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.prompts.some((q) => q.startsWith("Currency"))).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envBefore);
    const config = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    expect([config.name, config.currency, config.services.map((s) => s.id)]).toEqual(["Sam & Co", "GBP", ["haircut"]]);
    expect(r.out).toContain("Changing: Business details (name Sam's Barbers -> Sam & Co)");
  });

  // protects: picking the booking system and keeping its values still rechecks access (the documented recovery path)
  it("Booking system with the same values: listed as kept, access check still runs", async () => {
    const { dir } = googleSetup();
    const r = await run(dir, ["Change one part", "Booking system", "", "", "", "", false]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.calendars).toEqual(["cal@group.calendar.google.com"]);
    expect(r.out).toContain("Booking system (Google Calendar (calendar cal@group.calendar.google.com), rechecked)");
    expect(r.out).not.toContain("stay there");
  });

  // protects: connecting Google with no saved services asks for them (it cannot book without one), before the credentials
  it("no booking system saved -> Booking system -> Google: services asked too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-part-new-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" }));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ merchant_id: "ace", name: "Ace", timezone: "Europe/London", currency: "GBP", services: [], hours: {} }));
    writeFileSync(join(dir, ".env"), "PORT=4000\n");
    const r = await run(dir, ["Change one part", "Booking system", "", READY_ITEMS.yes.label, "Cut", "30", "0", "20", "", "", keyFile, "cal@x", "", false]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    const i = r.prompter.prompts.findIndex((q) => q.startsWith("  Service 1 name"));
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(r.prompter.prompts.findIndex((q) => q.startsWith("Calendar ID")));
    expect(parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).services.map((s) => s.id)).toEqual(["cut"]);
    expect(envOf(dir)).toMatchObject({ GOOGLE_CALENDAR_ID: "cal@x", PORT: "4000" });
  });

  // protects: an owner-channel edit keeps booking keys that are present but incomplete
  it("Owner channel edit keeps extra saved booking keys (Square app id and secret beside Google)", async () => {
    const { dir } = googleSetup("SQUARE_APP_ID='app'\nSQUARE_APP_SECRET='sec'\n");
    const r = await run(dir, ["Change one part", "Owner channel", OWNER_CHANNEL_ITEMS[0], ""]);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(envOf(dir)).toMatchObject({ SQUARE_APP_ID: "app", SQUARE_APP_SECRET: "sec", GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" });
  });

  it("only .env saved: Change one part is not offered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-part-env-"));
    writeFileSync(join(dir, ".env"), "PORT=4000\n");
    const r = await run(dir, [""]);
    expect(r.prompter.choices[0]).toEqual(existingItems(false).items);
  });
});

type WebAnswer = string | { back: true };

/** Drives the setup page: `answer` gets each step and returns a value (choose: an item label) or Back. */
async function web(dir: string, answer: (step: SetupStep) => WebAnswer, deps: Partial<InitDeps> = {}) {
  const asked: string[] = [];
  const logs: string[] = [];
  let driver: Promise<void> | undefined;
  let failure: unknown;
  const code = await runInit(["--web", "--dir", dir], {
    env: {}, log: (m) => logs.push(m),
    makeConnector: () => new FakeCalendarConnector(),
    makeWhatsapp: () => ({ checkAccess: async () => {} }),
    ...deps,
    startWebSetup: async (opts) => {
      const session = await startSetupServer({ ...opts, open: false, exitOnEnter: false });
      driver = (async () => {
        const res = await fetch(new URL("events", session.url));
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const split = buf.indexOf("\n\n");
            if (split < 0) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("setup closed before completion");
              buf += dec.decode(chunk.value, { stream: true });
              continue;
            }
            const raw = buf.slice(0, split);
            buf = buf.slice(split + 2);
            if (!raw.includes("event: step")) continue;
            const step = JSON.parse(raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as SetupStep;
            if (step.kind === "done") { await fetch(new URL("done", session.url), { method: "POST" }); return; }
            asked.push(step.question ?? "");
            const a = answer(step);
            const back = typeof a !== "string";
            let value = typeof a === "string" ? a : "";
            if (!back && step.kind === "choose") {
              const i = step.items!.findIndex((it) => it.label === a);
              if (i < 0) throw new Error(`"${step.question}" has no item ${a}`);
              value = String(i);
            }
            await fetch(new URL(back ? "back" : "answer", session.url), {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify(back ? { id: step.id } : { id: step.id, value }),
            });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      })().catch(async (e) => { failure = e; await session.close(); });
      return session;
    },
  });
  await driver;
  if (failure) throw failure;
  return { code, asked, out: logs.join("\n") };
}

describe("browser setup: Change one part", () => {
  // protects: a part backed out of is never written; only the part picked last is
  it("Business picked then backed out of, Owner channel -> WhatsApp: name not written, Google kept", async () => {
    const { dir, keyFile } = googleSetup();
    const [configBefore] = files(dir);
    let backs = 0;
    const r = await web(dir, (step) => {
      switch (step.question) {
        case "Existing setup": return "Change one part";
        case "What do you want to change?": return backs ? "Owner channel" : "Business details";
        case "Business or your name": return backs ? (backs++, { back: true }) : "Renamed Shop";
        case "Time zone": return backs++ === 0 ? { back: true } : "";
        case "Owner channel": return "WhatsApp";
        case "Ready to connect?": return "Ready to connect";
        case "Your WhatsApp number (e.g. +1 202 555 0199)": return "+1 202 555 0199";
        case "Phone number ID": return "123456";
        case "Access token": return "EAA-secret-9";
        case "App Secret": return "sec";
        case "Save this setup?": return "Save and finish";
        default: return step.kind === "choose" ? step.items![step.index ?? 0]!.label : step.def ?? "";
      }
    });
    expect(r.code).toBe(0);
    expect(backs).toBe(2);
    expect(r.asked.some((q) => /Booking system|Calendar ID|Currency|What do you want agents/.test(q))).toBe(false);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(configBefore);
    expect(envOf(dir)).toMatchObject({
      GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com", PORT: "4000",
      OWNER_PHONE: "+1 202 555 0199", WHATSAPP_PHONE_NUMBER_ID: "123456", WHATSAPP_ACCESS_TOKEN: "EAA-secret-9",
    });
  });

  // protects: connecting Google with no saved services runs the services questions too (Google cannot book without one)
  it("Booking system -> Google with no saved services: services asked before the key file", async () => {
    const { dir, keyFile } = googleSetup();
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, services: [] }, null, 2));
    const r = await web(dir, (step) => {
      switch (step.question) {
        case "Existing setup": return "Change one part";
        case "What do you want to change?": return "Booking system";
        case "Booking system": return "Google Calendar";
        case "  Service 1 name": return "Beard trim";
        case "  Service 2 name": return "";
        case "Calendar ID": return "cal2@group.calendar.google.com";
        case "Save this setup?": return "Save and finish";
        default: return step.kind === "choose" ? step.items![step.index ?? 0]!.label : step.def ?? "";
      }
    });
    expect(r.code).toBe(0);
    expect(r.asked.indexOf("  Service 1 name")).toBeGreaterThan(-1);
    expect(r.asked.indexOf("  Service 1 name")).toBeLessThan(r.asked.indexOf("Path to the service account JSON key"));
    expect(r.asked.some((q) => /Business or your name|Currency|Owner channel/.test(q))).toBe(false);
    const saved = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    expect(saved.services.map((s) => s.name)).toEqual(["Beard trim"]);
    expect(saved.name).toBe("Sam's Barbers");
    expect(envOf(dir)).toMatchObject({ GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, GOOGLE_CALENDAR_ID: "cal2@group.calendar.google.com", ALLOWED_HOSTS: "sam.trycloudflare.com" });
  });
});

describe("buildEnvFile: keep modes", () => {
  const carried = { GOOGLE_SERVICE_ACCOUNT_FILE: "/k.json", GOOGLE_CALENDAR_ID: "cal", GLOSSGENIUS_BOOKING_URL: "https://x.glossgenius.com", SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", SLACK_CHANNEL_ID: "C1", ALLOWED_HOSTS: "h" };
  const whatsapp = { whatsapp: { phone: "+12025550199", accessToken: "tok", phoneNumberId: "1", appSecret: "s", verifyToken: "v" } };
  const google = { kind: "google" as const, keyFile: "/new.json", calendarId: "cal2" };

  it("keep + keep matches the full walk's carry of a saved setup", () => {
    expect(buildEnvFile("keep", 4000, carried, "keep")).toBe(buildEnvFile(undefined, 4000, carried));
  });

  it.each([
    ["keep booking, new channel", "keep" as const, whatsapp, { GLOSSGENIUS_BOOKING_URL: "https://x.glossgenius.com", WHATSAPP_ACCESS_TOKEN: "tok", SLACK_BOT_TOKEN: undefined }],
    ["keep booking, no channel", "keep" as const, {}, { GOOGLE_CALENDAR_ID: "cal", SLACK_BOT_TOKEN: undefined, OWNER_PHONE: undefined }],
    ["new booking, keep channel", google, "keep" as const, { GOOGLE_CALENDAR_ID: "cal2", GLOSSGENIUS_BOOKING_URL: undefined, SLACK_CHANNEL_ID: "C1" }],
    ["new booking, new channel", google, whatsapp, { GOOGLE_CALENDAR_ID: "cal2", WHATSAPP_ACCESS_TOKEN: "tok", SLACK_BOT_TOKEN: undefined }],
  ])("%s", (_name, backend, channel, expected) => {
    const env = parseEnv(buildEnvFile(backend, 4000, carried, channel));
    for (const [k, v] of Object.entries(expected)) expect(env[k], k).toBe(v);
    expect(env.ALLOWED_HOSTS).toBe("h");
  });

  it("keep copies booking keys even when the saved set is incomplete", () => {
    expect(parseEnv(buildEnvFile("keep", 3000, { SQUARE_APP_ID: "app", SQUARE_APP_SECRET: "sec" }, "keep"))).toMatchObject({ SQUARE_APP_ID: "app", SQUARE_APP_SECRET: "sec" });
  });
});
