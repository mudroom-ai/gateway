import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { EXISTING_ITEMS, GOAL_ITEMS, GOOGLE_SETUP_STEPS, INTRO, READY_ITEMS, buildEnvFile, guideUrl, parseHours, renderHours, runInit, validGlossGeniusUrl } from "../src/cli/init.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { ScriptedPrompter } from "./helpers/scripted-prompter.js";

describe("init wizard (--non-interactive)", () => {
  it("writes a valid config.json and a 0600 .env, and the write test leaves no event behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" }));
    const fake = new FakeCalendarConnector();
    let inserted = 0;
    const insert = fake.insertEvent.bind(fake);
    fake.insertEvent = async (ev) => {
      inserted++;
      return insert(ev);
    };
    const logs: string[] = [];

    const code = await runInit(
      [
        "--non-interactive",
        "--dir", dir,
        "--name", "Sam's Barbers",
        "--timezone", "Europe/London",
        "--service", "Haircut:45:15:40.00",
        "--service", "Beard trim:20:0:15",
        "--hours", "mon-fri 09:00-17:00; sat 10:00-14:00",
        "--google-key-file", keyFile,
        "--calendar-id", "cal#1@group.calendar.google.com",
        "--write-test",
      ],
      { env: {}, makeConnector: () => fake, log: (m) => logs.push(m) },
    );

    expect(code).toBe(0);
    const config = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    expect(config.name).toBe("Sam's Barbers");
    expect(config.services.map((s) => [s.id, s.price_cents])).toEqual([["haircut", 4000], ["beard-trim", 1500]]);
    expect(config.hours.sat).toEqual([{ start: "10:00", end: "14:00" }]);
    expect(config.hours.sun).toEqual([]);

    const envPath = join(dir, ".env");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain(`GOOGLE_SERVICE_ACCOUNT_FILE='${keyFile}'`);
    expect(env).toContain("GOOGLE_CALENDAR_ID='cal#1@group.calendar.google.com'");
    expect(env).toContain("# ALLOWED_HOSTS=");

    expect(inserted).toBe(1);
    expect(fake.events.size).toBe(0);
    expect(logs.join("\n")).toContain("Write test passed");

    // A second run refuses to overwrite without --force.
    expect(await runInit(["--non-interactive", "--dir", dir, "--name", "X", "--service", "A:30:0:1"], { env: {}, log: () => {} })).toBe(1);

    // --force with both files present is a full overwrite: no resume, hand edits gone.
    writeFileSync(envPath, `${env}ALLOWED_HOSTS=x.trycloudflare.com\n`);
    expect(await runInit(["--non-interactive", "--force", "--no-backend", "--dir", dir, "--name", "X", "--service", "A:30:0:1"], { env: {}, log: () => {} })).toBe(0);
    const forced = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    expect([forced.name, forced.merchant_id, forced.services.map((s) => s.id)]).toEqual(["X", "x", ["a"]]);
    const forcedEnv = readFileSync(envPath, "utf8");
    expect(forcedEnv).not.toContain("ALLOWED_HOSTS=x");
    expect(forcedEnv).not.toMatch(/^GOOGLE_/m);
  });

  it("--no-backend (and the older --skip-google) writes the files with no booking system", async () => {
    for (const flag of ["--no-backend", "--skip-google"]) {
      const dir = mkdtempSync(join(tmpdir(), "gw-init-"));
      const logs: string[] = [];
      const code = await runInit(["--non-interactive", flag, "--dir", dir, "--name", "Ace", "--service", "Haircut:30:0:35"], {
        env: {},
        log: (m) => logs.push(m),
      });
      expect(code).toBe(0);
      const env = readFileSync(join(dir, ".env"), "utf8");
      expect(env).toContain("# GOOGLE_SERVICE_ACCOUNT_FILE=");
      expect(env).not.toMatch(/^GOOGLE_|^SQUARE_/m);
      expect(logs.join("\n")).toContain("WARNING: no booking system configured");
    }
  });

  it("--square writes SQUARE_* from the environment, needs no services, and runs the Square check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sq-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--square", "--dir", dir, "--name", "Foyer", "--timezone", "America/Los_Angeles"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "LOC", SQUARE_REFRESH_TOKEN: "rt", SQUARE_APP_ID: "app", SQUARE_APP_SECRET: "sec", SQUARE_ENV: "SANDBOX" },
      makeSquare: (o) => {
        expect(o).toEqual({ accessToken: "at", locationId: "LOC", environment: "sandbox", timezone: "America/Los_Angeles" });
        return { checkAccess: async () => {}, listServices: async () => [{ id: "V1", name: "Bath", duration_min: 60, buffer_min: 0, price_cents: 6500 }] };
      },
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("SQUARE_ENV=sandbox");
    expect(env).toContain("SQUARE_ACCESS_TOKEN='at'");
    expect(env).toContain("SQUARE_LOCATION_ID='LOC'");
    expect(env).toContain("SQUARE_REFRESH_TOKEN='rt'");
    expect(env).toContain("SQUARE_APP_SECRET='sec'");
    expect(env).not.toContain("GOOGLE_");
    expect(parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).services).toEqual([]);
    expect(logs.join("\n")).toContain("Bath (60 min)");
  });
});

describe("init wizard: owner SMS (Twilio) with any booking system", () => {
  it("Google + Twilio flags write the four keys without the GlossGenius comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-tw-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" }));
    const logs: string[] = [];
    const code = await runInit(
      [
        "--non-interactive", "--dir", dir, "--name", "Sam", "--service", "Haircut:45:15:40",
        "--google-key-file", keyFile, "--calendar-id", "cal@x",
        "--owner-phone", "+12025550199", "--twilio-sid", "AC123", "--twilio-token", "tok", "--twilio-from", "+12025550100",
      ],
      { env: {}, makeConnector: () => new FakeCalendarConnector(), log: (m) => logs.push(m) },
    );
    expect(code).toBe(0);
    const text = readFileSync(join(dir, ".env"), "utf8");
    expect(parseEnv(text)).toMatchObject({ GOOGLE_CALENDAR_ID: "cal@x", OWNER_PHONE: "+12025550199", TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+12025550100" });
    expect(text).not.toContain("GlossGenius");
    expect(logs.join("\n")).toContain("texted to ***0199");
  });

  it("Square + a partial Twilio set exits 1 naming the missing vars and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-tw2-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", "--twilio-sid", "AC123"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      log: (m) => logs.push(m),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/TWILIO_AUTH_TOKEN, TWILIO_FROM, OWNER_PHONE/);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });
});

describe("init wizard: WhatsApp owner channel", () => {
  const WA_FLAGS = ["--owner-phone", "+12025550199", "--whatsapp-token", "EAAx", "--whatsapp-phone-id", "123456789012345", "--whatsapp-app-secret", "sec"];

  it("--help names whatsapp", async () => {
    const logs: string[] = [];
    expect(await runInit(["--help"], { log: (m) => logs.push(m) })).toBe(0);
    expect(logs.join("\n")).toMatch(/--whatsapp-token.*\(whatsapp\)/);
  });

  it("Square + WhatsApp flags write the keys with a generated verify token, run the check, and print the webhook URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-wa-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", ...WA_FLAGS, "--whatsapp-template", "agent_message:es"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1", PUBLIC_URL: "https://gw.example.com/" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      makeWhatsapp: () => ({ checkAccess: async () => Promise.reject(new Error("WhatsApp 190: WHATSAPP_ACCESS_TOKEN is invalid or expired")) }),
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env).toMatchObject({ OWNER_PHONE: "+12025550199", WHATSAPP_ACCESS_TOKEN: "EAAx", WHATSAPP_PHONE_NUMBER_ID: "123456789012345", WHATSAPP_APP_SECRET: "sec", WHATSAPP_TEMPLATE: "agent_message:es" });
    expect(env.WHATSAPP_VERIFY_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("WhatsApp check FAILED: WhatsApp 190");
    expect(out).toContain("Callback URL:  https://gw.example.com/webhooks/whatsapp");
    expect(out).toContain(`Verify token:  ${env.WHATSAPP_VERIFY_TOKEN}`);
  });

  it("a partial WhatsApp set exits 1 naming the missing vars and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-wa2-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", "--whatsapp-token", "EAAx"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      log: (m) => logs.push(m),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, OWNER_PHONE/);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("a resume keeps a WhatsApp channel already in .env, verify token included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-wa3-"));
    const logs: string[] = [];
    const first = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", ...WA_FLAGS], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      makeWhatsapp: () => ({ checkAccess: async () => {} }),
      log: () => {},
    });
    expect(first).toBe(0);
    const before = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    const again = await runInit(["--non-interactive", "--force", "--dir", dir, "--name", "Foyer", "--square"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1", ...before },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      makeWhatsapp: () => ({ checkAccess: async () => {} }),
      log: (m) => logs.push(m),
    });
    expect(again).toBe(0);
    expect(parseEnv(readFileSync(join(dir, ".env"), "utf8")).WHATSAPP_VERIFY_TOKEN).toBe(before.WHATSAPP_VERIFY_TOKEN);
  });
});

describe("init wizard: Slack owner channel", () => {
  const SLACK_FLAGS = ["--slack-bot-token", "xoxb-1", "--slack-app-token", "xapp-1", "--slack-channel", "C0123"];

  it("--help names slack", async () => {
    const logs: string[] = [];
    expect(await runInit(["--help"], { log: (m) => logs.push(m) })).toBe(0);
    expect(logs.join("\n")).toMatch(/--slack-bot-token.*\(slack\)/);
  });

  it("Square + Slack flags write the SLACK_* keys and run the Slack check with its hint on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sl-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", ...SLACK_FLAGS, "--slack-owner-ids", "U1,U2"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      makeSlack: () => ({ checkAccess: async () => Promise.reject(new Error("Slack conversations.info: not_in_channel: invite the app to the channel")) }),
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(parseEnv(readFileSync(join(dir, ".env"), "utf8"))).toMatchObject({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", SLACK_CHANNEL_ID: "C0123", SLACK_OWNER_USER_IDS: "U1,U2" });
    expect(logs.join("\n")).toContain("Slack check FAILED: Slack conversations.info: not_in_channel: invite the app");
  });

  it("a partial Slack set exits 1 naming the missing vars and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sl2-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Foyer", "--square", "--slack-bot-token", "xoxb-1"], {
      env: { SQUARE_ACCESS_TOKEN: "at", SQUARE_LOCATION_ID: "L1" },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
      log: (m) => logs.push(m),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/SLACK_APP_TOKEN, SLACK_CHANNEL_ID too/);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("interactive: choosing Slack asks for the tokens, channel and optional owner ids, then checks access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sli-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify(KEY));
    const prompter = new ScriptedPrompter([
      "", // website: skipped
      "Book appointments and message me", "1", "Yes, I have these", // goal, booking system (Google), ready
      "Ace", "Europe/London", "", "Haircut", "30", "0", "35", "", "", // name..hours
      keyFile, "cal@x", // Google
      "", "Yes, I have these", // owner channel: Slack (the default for this goal), ready
      "xapp-swapped", "xoxb-1", "xapp-1", "C0123", "", // bad bot token re-asked, app token, channel, no owner ids
      false, // write test
    ]);
    let checked = 0;
    const code = await runInit(["--dir", dir], {
      env: {},
      prompter,
      makeConnector: () => new FakeCalendarConnector(),
      makeSlack: () => ({ checkAccess: async () => void checked++ }),
      log: () => {},
    });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(checked).toBe(1);
    const text = readFileSync(join(dir, ".env"), "utf8");
    expect(parseEnv(text)).toMatchObject({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", SLACK_CHANNEL_ID: "C0123" });
    expect(text).toContain("# SLACK_OWNER_USER_IDS=");
  });
});

describe("init wizard: GlossGenius", () => {
  const ggKey = (dir: string) => {
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" }));
    return keyFile;
  };
  const okGlossGenius = () => ({ checkAccess: async () => {}, listServices: async () => [{ id: "S1", name: "Brow lamination", duration_min: 60, buffer_min: 0, price_cents: 8500 }] });

  it("--glossgenius-url writes the GlossGenius, Google and Twilio keys, needs no services, and runs checkAccess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-gg-"));
    const keyFile = ggKey(dir);
    const logs: string[] = [];
    let seen: { bookingUrl: string; timezone: string } | undefined;
    const code = await runInit(
      [
        "--non-interactive", "--dir", dir, "--name", "Luna Studio", "--timezone", "America/New_York",
        "--glossgenius-url", "luna-studio.glossgenius.com",
        "--google-key-file", keyFile, "--calendar-id", "cal@group.calendar.google.com",
        "--owner-phone", "+12025550199", "--twilio-sid", "AC123", "--twilio-from", "+12025550199",
      ],
      {
        env: { TWILIO_AUTH_TOKEN: "tok" },
        makeConnector: () => new FakeCalendarConnector(),
        makeGlossGenius: (o) => {
          seen = { bookingUrl: o.bookingUrl, timezone: o.timezone };
          return okGlossGenius();
        },
        log: (m) => logs.push(m),
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ bookingUrl: "https://luna-studio.glossgenius.com", timezone: "America/New_York" });
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env).toMatchObject({
      GLOSSGENIUS_BOOKING_URL: "https://luna-studio.glossgenius.com",
      GOOGLE_SERVICE_ACCOUNT_FILE: keyFile,
      GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com",
      OWNER_PHONE: "+12025550199",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_FROM: "+12025550199",
    });
    expect(parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).services).toEqual([]);
    expect(logs.join("\n")).toContain("GlossGenius access OK. Bookable services: Brow lamination (60 min)");
  });

  it("prints the checkAccess fix hint when the booking page cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-gg2-"));
    const logs: string[] = [];
    const hint = "Could not read the GlossGenius booking page at https://luna-studio.glossgenius.com (x). Check GLOSSGENIUS_BOOKING_URL opens in a browser and shows your services.";
    const code = await runInit(
      ["--non-interactive", "--dir", dir, "--name", "Luna", "--glossgenius-url", "https://luna-studio.glossgenius.com", "--google-key-file", ggKey(dir), "--calendar-id", "cal@x"],
      {
        env: {},
        makeConnector: () => new FakeCalendarConnector(),
        makeGlossGenius: () => ({ checkAccess: async () => { throw new Error(hint); }, listServices: async () => [] }),
        log: (m) => logs.push(m),
      },
    );
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(`GlossGenius check FAILED: ${hint}`);
    expect(out).toContain("No owner channel configured");
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toMatch(/^TWILIO_/m);
  });

  it("rejects a URL that is not a GlossGenius booking page, a partial Twilio set, and a missing calendar", async () => {
    expect(() => validGlossGeniusUrl("https://luna.vagaro.com")).toThrow(/not a GlossGenius booking page/);
    expect(() => validGlossGeniusUrl("https://glossgenius.com.evil.example")).toThrow(/not a GlossGenius booking page/);
    expect(validGlossGeniusUrl("https://Luna.GlossGenius.com/services")).toBe("https://luna.glossgenius.com/services");

    const run = async (extra: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "gw-init-gg3-"));
      const logs: string[] = [];
      const code = await runInit(["--non-interactive", "--dir", dir, "--name", "Luna", ...extra], { env: {}, makeGlossGenius: () => okGlossGenius(), log: (m) => logs.push(m) });
      return { code, out: logs.join("\n"), wrote: existsSync(join(dir, ".env")), keyFile: ggKey(dir) };
    };
    const bad = await run(["--glossgenius-url", "https://luna.vagaro.com", "--google-key-file", "/nonexistent", "--calendar-id", "c"]);
    expect([bad.code, bad.wrote]).toEqual([1, false]);
    expect(bad.out).toContain("not a GlossGenius booking page");

    const noCal = await run(["--glossgenius-url", "https://luna.glossgenius.com"]);
    expect(noCal.code).toBe(1);
    expect(noCal.out).toContain("--glossgenius-url needs --google-key-file and --calendar-id");

    const dir = mkdtempSync(join(tmpdir(), "gw-init-gg4-"));
    const logs: string[] = [];
    const partial = await runInit(
      ["--non-interactive", "--dir", dir, "--name", "Luna", "--glossgenius-url", "https://luna.glossgenius.com", "--google-key-file", ggKey(dir), "--calendar-id", "c", "--owner-phone", "+12025550199", "--twilio-sid", "AC1"],
      { env: {}, makeGlossGenius: () => okGlossGenius(), log: (m) => logs.push(m) },
    );
    expect(partial).toBe(1);
    expect(logs.join("\n")).toContain("TWILIO_AUTH_TOKEN, TWILIO_FROM");
  });

  it("interactive: the GlossGenius choice asks for the URL, the Google pair and (optionally) Twilio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-ggi-"));
    const keyFile = ggKey(dir);
    const prompter = new ScriptedPrompter([
      "", // website: skipped
      "", // goal: Book appointments (the default); GlossGenius asks the owner channel anyway
      "3", "Yes, I have these", // booking system: GlossGenius, ready
      "Luna Studio", "America/New_York", "", // name, zone, currency
      "https://luna.vagaro.com", "luna.glossgenius.com", // rejected, then accepted
      keyFile, "cal@group.calendar.google.com",
      "", // owner channel: None (the default)
    ]);
    const code = await runInit(["--dir", dir], { env: {}, prompter, makeConnector: () => new FakeCalendarConnector(), makeGlossGenius: () => okGlossGenius(), log: () => {} });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(prompter.prompts.some((q) => q.startsWith("  Service"))).toBe(false);
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.GLOSSGENIUS_BOOKING_URL).toBe("https://luna.glossgenius.com");
    expect(env.GOOGLE_CALENDAR_ID).toBe("cal@group.calendar.google.com");
    expect(env.OWNER_PHONE).toBeUndefined();
  });
});

// ---------- interactive wizard (scripted prompter) ----------

const KEY = { client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" };

async function interactive(dir: string, answers: (string | boolean)[], env: Record<string, string> = {}) {
  const prompter = new ScriptedPrompter(answers);
  const logs: string[] = [];
  const code = await runInit(["--dir", dir], { env, prompter, makeConnector: () => new FakeCalendarConnector(), log: (m) => logs.push(m) });
  return { code, out: logs.join("\n"), prompter };
}

/** A directory as a merchant leaves it after a first run plus hand edits to config.json and .env. */
function savedSetup() {
  const dir = mkdtempSync(join(tmpdir(), "gw-resume-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, JSON.stringify(KEY));
  const config = {
    merchant_id: "sams-shop",
    name: "Sam's Barbers",
    timezone: "Europe/London",
    currency: "GBP",
    services: [
      { id: "cut-v1", name: "Haircut", description: "Wash and cut.", duration_min: 45, buffer_min: 15, price_cents: 4000 },
      { id: "beard", name: "Beard trim", duration_min: 20, buffer_min: 0, price_cents: 1500 },
    ],
    hours: { mon: [], tue: [{ start: "09:00", end: "17:00" }], wed: [{ start: "09:00", end: "17:00" }], thu: [], fri: [], sat: [{ start: "10:00", end: "14:00" }], sun: [] },
    blackout_days: ["2026-12-25"],
    discounts: [{ id: "early", label: "Early bird", pct: 10, time_of_day: { start: "09:00", end: "11:00" } }],
    floor_cents: 1000,
    quote_ttl_min: 30,
    limits: { max_window_days: 21 },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(
    join(dir, ".env"),
    [
      "# hand-edited",
      `GOOGLE_SERVICE_ACCOUNT_FILE='${keyFile}'`,
      "GOOGLE_CALENDAR_ID='cal@group.calendar.google.com'",
      `GOOGLE_SERVICE_ACCOUNT_JSON='{"stale":true}'`,
      "PORT=4000",
      "ALLOWED_HOSTS=sam.trycloudflare.com,localhost,127.0.0.1",
      "TRUST_PROXY=1",
      "",
    ].join("\n"),
  );
  return { dir, keyFile, config };
}

// A resumed Google run: "Review and update" (Enter would keep the setup and exit), then Enter through goal
// (Book appointments), system, name, zone, currency, 2 saved services x 4, "add another" (empty = done), hours,
// key path, calendar id, write test.
const ENTER_THROUGH: (string | boolean)[] = ["Review and update", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", false];

describe("init wizard (interactive)", () => {
  // protects: the Booking system question is a picker (answer by label or number), choosing Square runs
  //   the OAuth flow, an INACTIVE location is hidden, and with several active locations the merchant picks
  //   one from a picker whose default is the first active one; the chosen id lands in .env.
  // fails_when: the picker items lose their labels/order, INACTIVE locations are offered, the location
  //   picker's default is not the first active one, or the chosen index is mapped to the wrong location.
  // why_new: init.test.ts drove Square only through --non-interactive (env tokens, no location choice);
  //   the interactive Square branch, including the new `p.choose` location step, had no test.
  // seam: none (InitDeps.oauth and makeSquare are the wizard's existing injection points).
  it("Square interactive: picker answers by label, inactive locations hidden, location picked and written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sqi-"));
    const prompter = new ScriptedPrompter([
      "", // website: skipped
      "", // goal: Book appointments (the default), so no owner channel question
      "Square Appointments", "Yes, I have these", // booking system, by label; ready
      "Foyer", "America/Los_Angeles", "", // name, zone, currency
      "sandbox", "app-1", "sec-1", // env, app id, secret
      "2", // Book at location: second *active* one
    ]);
    const logs: string[] = [];
    const code = await runInit(["--dir", dir], {
      env: {},
      prompter,
      log: (m) => logs.push(m),
      oauth: {
        waitForCallback: async () => "code-1",
        obtainToken: async () => ({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: undefined, merchantId: "M1" }),
        listLocations: async () => [
          { id: "L-OLD", name: "Closed shop", status: "INACTIVE", timezone: undefined },
          { id: "L-DT", name: "Downtown", status: "ACTIVE", timezone: "America/Los_Angeles" },
          { id: "L-UP", name: "Uptown", status: "ACTIVE", timezone: "America/New_York" },
        ],
        open: () => {},
      },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
    });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(prompter.prompts).toContain("Booking system [Google Calendar]");
    expect(prompter.prompts).toContain("Book at location [Downtown]");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("SQUARE_LOCATION_ID='L-UP'");
    expect(env).toContain("SQUARE_ACCESS_TOKEN='at-1'");
    expect(env).toContain("SQUARE_APP_ID='app-1'");
    expect(logs.join("\n")).toContain("Square has this location in America/New_York; the gateway will use America/Los_Angeles");
  });

  // protects: when OAuth succeeds but every Square location is INACTIVE the wizard stops with
  //   "error: this Square account has no active locations", exits 1, asks no location question and
  //   writes neither config.json nor .env (the merchant must fix the account, not re-run blind).
  // fails_when: the INACTIVE filter is dropped so a closed location is offered or auto-selected, the
  //   throw is removed so the wizard writes an .env with a dead SQUARE_LOCATION_ID, or the error is
  //   swallowed and the run exits 0.
  // why_new: the happy paths (several active, one active) were covered; the no-active-locations
  //   branch had no test.
  // seam: none (InitDeps.oauth and makeSquare are the wizard's existing injection points).
  it("Square interactive: no active locations exits 1 with the error and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sqna-"));
    const prompter = new ScriptedPrompter([
      "", "", // website (skipped), goal
      "Square Appointments", "Yes, I have these", // booking system, by label; ready
      "Foyer", "America/Los_Angeles", "", // name, zone, currency
      "sandbox", "app-1", "sec-1", // env, app id, secret
    ]);
    const logs: string[] = [];
    let squareMade = false;
    const code = await runInit(["--dir", dir], {
      env: {},
      prompter,
      log: (m) => logs.push(m),
      oauth: {
        waitForCallback: async () => "code-3",
        obtainToken: async () => ({ accessToken: "at-3", refreshToken: undefined, expiresAt: undefined, merchantId: "M3" }),
        listLocations: async () => [
          { id: "L-OLD", name: "Closed shop", status: "INACTIVE", timezone: undefined },
          { id: "L-OLDER", name: "Older shop", status: "INACTIVE", timezone: "America/New_York" },
        ],
        open: () => {},
      },
      makeSquare: () => {
        squareMade = true;
        return { checkAccess: async () => {}, listServices: async () => [] };
      },
    });
    expect(code).toBe(1);
    expect(prompter.remaining).toBe(0);
    expect(prompter.prompts.some((q) => q.startsWith("Book at location"))).toBe(false);
    expect(logs.join("\n")).toContain("Square authorised.");
    expect(logs.join("\n")).toContain("error: this Square account has no active locations");
    expect(squareMade).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  // protects: with Square already in .env the picker pre-selects Square Appointments (Enter keeps it), and a
  //   single active location is taken without asking.
  // fails_when: the default index is computed from the wrong source (Google pre-selected on a Square resume)
  //   or the single-location shortcut asks anyway / picks nothing.
  // why_new: the old numeric default ("2") was never asserted; the picker rewrite changed how it is expressed.
  // seam: none.
  it("Square resume: picker defaults to Square Appointments and a single location is auto-selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-sqr-"));
    writeFileSync(join(dir, ".env"), "SQUARE_ENV=sandbox\nSQUARE_ACCESS_TOKEN='old'\nSQUARE_LOCATION_ID='L-OLD'\nSQUARE_APP_ID='app-1'\nSQUARE_APP_SECRET='sec-1'\n");
    const prompter = new ScriptedPrompter(["Review and update", "", "", "Foyer", "America/Los_Angeles", "", "", "", ""]); // existing setup, goal, booking system (no guide: Square is configured), name, zone, then Enter through: currency, env, app id, secret
    const code = await runInit(["--dir", dir], {
      env: {},
      prompter,
      log: () => {},
      oauth: {
        waitForCallback: async () => "code-2",
        obtainToken: async () => ({ accessToken: "at-2", refreshToken: undefined, expiresAt: undefined, merchantId: undefined }),
        listLocations: async () => [{ id: "L-ONLY", name: "Only", status: "ACTIVE", timezone: undefined }],
        open: () => {},
      },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
    });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(prompter.prompts).toContain("Booking system [Square Appointments]");
    expect(prompter.prompts.some((q) => q.startsWith("Book at location"))).toBe(false);
    expect(prompter.prompts).toContain("Application secret [from .env]");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("SQUARE_LOCATION_ID='L-ONLY'");
  });

  // protects: the Booking system picker marks Google "configured" when the key is given inline as
  //   GOOGLE_SERVICE_ACCOUNT_JSON (the Docker/PaaS form) and the calendar id is set, and "not configured"
  //   when neither key form is present; Square's status follows SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID.
  // fails_when: the status only checks GOOGLE_SERVICE_ACCOUNT_FILE (a JSON-configured merchant sees
  //   "not configured" beside a working connector), or the two conditions are swapped.
  // why_new: ScriptedPrompter discarded picker items until now, so no test could see the status text.
  // seam: none (the prompter fake records what it was shown).
  it("Booking system picker: status reflects GOOGLE_SERVICE_ACCOUNT_JSON and the Square vars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-status-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify(KEY));
    // name, zone, currency, 1 service x4, add another, hours, key path, calendar id, write test
    const rest = ["Foyer", "Europe/London", "", "Haircut", "30", "0", "35", "", "", keyFile, "cal@example.com", false];
    // website (skipped), goal, system, then "ready" only where Google (the default pick) is not configured yet
    const answers = ["", "", "", "Yes, I have these", ...rest];
    const json = await interactive(dir, ["", "", "", ...rest], {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY),
      GOOGLE_CALENDAR_ID: "cal@example.com",
    });
    expect(json.prompter.choices[1]!.map((i) => `${i.label}: ${i.status}`)).toEqual(["Google Calendar: configured", "Square Appointments: not configured", "GlossGenius (shadow mode: reads your booking page, writes to Google Calendar): not configured"]);

    const none = await interactive(mkdtempSync(join(tmpdir(), "gw-init-status2-")), answers, {
      SQUARE_ACCESS_TOKEN: "at",
      SQUARE_LOCATION_ID: "L1",
    });
    expect(none.prompter.choices[1]!.map((i) => `${i.label}: ${i.status}`)).toEqual(["Google Calendar: not configured", "Square Appointments: configured", "GlossGenius (shadow mode: reads your booking page, writes to Google Calendar): not configured"]);

    // Half set is not configured: a key without a calendar id (and vice versa) still needs the Google steps.
    const half = await interactive(mkdtempSync(join(tmpdir(), "gw-init-status3-")), answers, {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY),
      SQUARE_ACCESS_TOKEN: "at",
    });
    expect(half.prompter.choices[1]!.map((i) => `${i.label}: ${i.status}`)).toEqual(["Google Calendar: not configured", "Square Appointments: not configured", "GlossGenius (shadow mode: reads your booking page, writes to Google Calendar): not configured"]);
  });

  it("no backend: ends with cd <dir>, the Google steps and npm run init, not npm start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-i-"));
    const { code, out, prompter } = await interactive(dir, ["", "", "", "Not yet, finish later", "Ace", "Europe/London", ""]); // the first "" skips the website question
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(existsSync(join(dir, "config.json")) && existsSync(join(dir, ".env"))).toBe(true);
    expect(out).not.toContain("WARNING");
    const tail = out.slice(out.lastIndexOf("Next steps:"));
    expect(tail).toContain(`cd ${dir}`);
    for (const step of GOOGLE_SETUP_STEPS) expect(tail).toContain(step);
    expect(tail).toContain("docs/connectors/google.md");
    expect(tail.indexOf("npm run init")).toBeGreaterThan(tail.indexOf(GOOGLE_SETUP_STEPS[2]!)); // the wizard again, after the setup steps
    expect(out).not.toContain("npm start");
  });

  it("resume keeps hand-edited config fields and the ids of unchanged services", async () => {
    const { dir, config } = savedSetup();
    const { code, prompter } = await interactive(dir, ENTER_THROUGH);
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(prompter.prompts).toContain("Business or your name [Sam's Barbers]");
    expect(prompter.prompts).toContain("    Price (GBP) [40.00]");
    expect(prompter.prompts).toContain("Hours [tue-wed 09:00-17:00; sat 10:00-14:00]");
    expect(prompter.prompts[0]).toBe("Existing setup [Keep it as it is]");
    expect(prompter.prompts[1]).toBe("What do you want agents to do? [Book appointments]");
    expect(prompter.prompts.some((q) => q.startsWith("Owner channel"))).toBe(false);
    expect(prompter.prompts.some((q) => q.startsWith("Ready to connect?"))).toBe(false); // Google is configured: no guide
    const after = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    const before = parseConfig(config);
    expect(after.merchant_id).toBe("sams-shop");
    expect(after.services).toEqual(before.services);
    expect(after.hours).toEqual(before.hours);
    expect([after.blackout_days, after.discounts, after.floor_cents, after.quote_ttl_min, after.limits.max_window_days]).toEqual([
      config.blackout_days,
      config.discounts,
      1000,
      30,
      21,
    ]);
  });

  it("resume keeps ALLOWED_HOSTS, TRUST_PROXY and PORT, rewrites the Google keys, drops GOOGLE_SERVICE_ACCOUNT_JSON", async () => {
    const { dir, keyFile } = savedSetup();
    const { code } = await interactive(dir, ENTER_THROUGH);
    expect(code).toBe(0);
    const text = readFileSync(join(dir, ".env"), "utf8");
    expect(parseEnv(text)).toEqual({
      GOOGLE_SERVICE_ACCOUNT_FILE: keyFile,
      GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com",
      PORT: "4000",
      ALLOWED_HOSTS: "sam.trycloudflare.com,localhost,127.0.0.1",
      TRUST_PROXY: "1",
    });
    expect(text).not.toContain("# ALLOWED_HOSTS=");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("Next steps: cd first, then tunnel (with install hint), npm start + local curl, agent entry page", async () => {
    const { dir } = savedSetup();
    const { code, out } = await interactive(dir, ENTER_THROUGH);
    expect(code).toBe(0);
    const tail = out.slice(out.lastIndexOf("Next steps:"));
    expect([...tail.matchAll(/^ {2}(\d)\. /gm)].map((m) => m[1])).toEqual(["1", "2", "3", "4"]);
    const at = (s: string) => {
      const i = tail.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at(`cd ${dir}`),
      at("cloudflared tunnel --url http://localhost:4000"),
      at("install: brew install cloudflared"),
      at("ALLOWED_HOSTS=<tunnel-host>"),
      at("npm start"),
      at("curl localhost:4000/api/services"),
      at("Point your agent at the entry page"),
      // The tunnel step prints the same URL earlier, so take the last one: the link handed to the agent.
      tail.lastIndexOf("https://<tunnel-host>.trycloudflare.com"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("first run prints the introduction before the goal question; a resume prints the short header", async () => {
    const first = await interactive(mkdtempSync(join(tmpdir(), "gw-init-intro-")), ["", "", "", "Not yet, finish later", "Ace", "", ""]); // website (skipped), goal, system, ...
    for (const line of INTRO.filter(Boolean)) expect(first.out).toContain(line);
    expect(first.prompter.choices[0]).toEqual(GOAL_ITEMS);
    const { dir } = savedSetup();
    const again = await interactive(dir, ENTER_THROUGH);
    expect(again.out).not.toContain(INTRO[1]);
    expect(again.out).toContain("Press Enter to keep each saved answer");
  });

  it("a system that is not set up shows its guide; the browser opens only when asked, and Not yet ends on that guide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-guide-"));
    const prompter = new ScriptedPrompter(["", "", "Square Appointments", READY_ITEMS.open.label, READY_ITEMS.later.label, "Foyer", "", ""]); // website (skipped), goal, ...
    const logs: string[] = [];
    const opened: string[] = [];
    const code = await runInit(["--dir", dir], { env: { DISPLAY: ":0" }, prompter, openUrl: (u) => opened.push(u), log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(opened).toEqual([guideUrl("square")]);
    expect(prompter.choices[2]!.map((i) => i.label)).toEqual([READY_ITEMS.yes.label, READY_ITEMS.open.label, READY_ITEMS.later.label]);
    expect(prompter.choices[3]!.map((i) => i.label)).toEqual([READY_ITEMS.yes.label, READY_ITEMS.later.label]);
    const out = logs.join("\n");
    expect(out.indexOf("Square Appointments: before you connect")).toBeLessThan(out.indexOf("Wrote "));
    const tail = out.slice(out.lastIndexOf("Next steps:"));
    expect(tail).toContain("Set up Square Appointments");
    expect(tail).toContain(guideUrl("square"));
    expect(tail).toContain("docs/connectors/square.md");
    expect(tail).not.toContain(GOOGLE_SETUP_STEPS[0]);

    // Over SSH there is no browser to open, so the option is not offered and nothing opens.
    const ssh = new ScriptedPrompter(["", "", "", READY_ITEMS.later.label, "Foyer", "", ""]);
    await runInit(["--dir", mkdtempSync(join(tmpdir(), "gw-init-guide2-"))], { env: { SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, prompter: ssh, openUrl: (u) => opened.push(u), log: () => {} });
    expect(ssh.choices[2]!.map((i) => i.label)).toEqual([READY_ITEMS.yes.label, READY_ITEMS.later.label]);
    expect(opened).toHaveLength(1);
  });

  it("existing setup: Keep changes nothing and exits; Start over ignores the saved answers", async () => {
    const { dir } = savedSetup();
    const before = [readFileSync(join(dir, "config.json"), "utf8"), readFileSync(join(dir, ".env"), "utf8")];
    const keep = await interactive(dir, [""]); // Enter: Keep is the default once a booking system is connected
    expect(keep.code).toBe(0);
    expect(keep.prompter.choices[0]).toEqual(EXISTING_ITEMS);
    expect([readFileSync(join(dir, "config.json"), "utf8"), readFileSync(join(dir, ".env"), "utf8")]).toEqual(before);
    expect(keep.out).toContain("nothing was changed");
    expect(keep.out).toContain("curl localhost:4000/api/services");

    const fresh = await interactive(dir, ["Start over", "", "", "", READY_ITEMS.later.label, "New Name", "", ""]); // Start over asks the website question again (skipped here)
    expect(fresh.code).toBe(0);
    expect(fresh.prompter.prompts).toContain("Business or your name"); // no saved default
    expect(fresh.out).toContain(INTRO[1]);
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect([env.GOOGLE_CALENDAR_ID, env.ALLOWED_HOSTS]).toEqual([undefined, undefined]);
    expect(parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).merchant_id).toBe("new-name");
  });

  it("owner channel: a channel that is not set up shows its guide; Not yet leaves it off", async () => {
    const { dir } = savedSetup();
    const answers = [...ENTER_THROUGH];
    answers[1] = "Book appointments and message me";
    // owner channel (Slack is pre-selected), open the guide, then not yet; then the write test
    answers.splice(-1, 1, "", READY_ITEMS.open.label, READY_ITEMS.later.label, false);
    const prompter = new ScriptedPrompter(answers);
    const opened: string[] = [];
    const logs: string[] = [];
    const code = await runInit(["--dir", dir], { env: { DISPLAY: ":0" }, prompter, makeConnector: () => new FakeCalendarConnector(), openUrl: (u) => opened.push(u), log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(opened).toEqual([guideUrl("square").replace("square.md", "slack.md")]);
    expect(logs.join("\n")).toContain("Slack: before you connect");
    expect(logs.join("\n")).toContain("docs/connectors/slack.md");
    expect(parseEnv(readFileSync(join(dir, ".env"), "utf8")).SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("Book appointments on a resume keeps a Slack channel already in .env without asking", async () => {
    const { dir } = savedSetup();
    appendFileSync(join(dir, ".env"), "SLACK_BOT_TOKEN='xoxb-1'\nSLACK_APP_TOKEN='xapp-1'\nSLACK_CHANNEL_ID='C0123'\n");
    const answers = [...ENTER_THROUGH];
    answers[1] = "Book appointments"; // the default is "...and message me" once a channel is saved
    const prompter = new ScriptedPrompter(answers);
    const code = await runInit(["--dir", dir], { env: {}, prompter, makeConnector: () => new FakeCalendarConnector(), makeSlack: () => ({ checkAccess: async () => {} }), log: () => {} });
    expect(code).toBe(0);
    expect(prompter.prompts[1]).toBe("What do you want agents to do? [Book appointments and message me]");
    expect(prompter.prompts.some((q) => q.startsWith("Owner channel"))).toBe(false);
    expect(parseEnv(readFileSync(join(dir, ".env"), "utf8"))).toMatchObject({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", SLACK_CHANNEL_ID: "C0123" });
  });

  it("resume with an invalid config.json exits 1 with the Invalid config message and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-resume-bad-"));
    const bad = JSON.stringify({ name: "Sam", timezone: "Not/AZone", currency: "GBP", hours: {} });
    writeFileSync(join(dir, "config.json"), bad);
    const { code, out, prompter } = await interactive(dir, []);
    expect(code).toBe(1);
    expect(out).toContain("Invalid config");
    expect(prompter.prompts).toEqual([]);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(bad);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("a renamed service gets a new id and the wizard says so", async () => {
    const { dir } = savedSetup();
    const answers = [...ENTER_THROUGH];
    answers[6] = "Hair cut"; // the first saved service's name
    const { code, out } = await interactive(dir, answers);
    expect(code).toBe(0);
    const after = parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
    expect(after.services.map((s) => [s.id, s.name])).toEqual([["hair-cut", "Hair cut"], ["beard", "Beard trim"]]);
    expect(out).toContain("Renamed services get a new id; agents need to call list_services again.");
  });

  it("CONFIG_PATH: reads that file as the base and writes it back there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-cfgpath-"));
    mkdirSync(join(dir, "conf"));
    const custom = join(dir, "conf", "gw.json");
    writeFileSync(
      custom,
      JSON.stringify({ name: "Custom Co", timezone: "Asia/Tokyo", currency: "JPY", services: [{ id: "x1", name: "Massage", duration_min: 60, price_cents: 800000 }], hours: { mon: [{ start: "10:00", end: "18:00" }] }, floor_cents: 500 }),
    );
    // existing setup (Review: nothing is connected yet), goal, system, not ready (so the saved service is not asked about), name, zone, currency
    const { code, out, prompter } = await interactive(dir, ["", "", "", "Not yet, finish later", "Custom Co Two", "", ""], { CONFIG_PATH: "conf/gw.json" });
    expect(code).toBe(0);
    expect(out).toContain(`Using ${custom}`);
    expect(out).toContain(`Wrote ${custom}`);
    expect(out).toContain(`Wrote ${join(dir, ".env")}`);
    expect(prompter.prompts).toContain("Business or your name [Custom Co]");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    const after = parseConfig(JSON.parse(readFileSync(custom, "utf8")));
    expect([after.name, after.timezone, after.floor_cents, after.services[0]?.id]).toEqual(["Custom Co Two", "Asia/Tokyo", 500, "x1"]);
  });
});

describe("init helpers", () => {
  it("renderHours is the inverse of parseHours", () => {
    for (const spec of ["mon-fri 09:00-17:00", "mon-fri 09:00-17:00; sat 10:00-14:00"]) {
      expect(renderHours(parseHours(spec))).toBe(spec);
    }
    const split = parseHours("mon-tue 09:00-12:00; mon-tue 13:00-17:00; thu 10:00-11:00");
    expect(parseHours(renderHours(split))).toEqual(split);
  });

  it(".env values with ', \" or both (and inline JSON) round-trip through util.parseEnv", () => {
    const carried = {
      A: "Sam's",
      B: 'say "hi"',
      C: `it's "quoted"`,
      D: `{"label":"Sam's gateway"}`,
      E: "it's a \\n literal backslash-n",
      F: "plain # not a comment",
    };
    const parsed = parseEnv(buildEnvFile(undefined, 3000, carried));
    for (const [k, v] of Object.entries(carried)) expect(parsed[k], k).toBe(v);
    expect(() => buildEnvFile(undefined, 3000, { BAD: `' " \`` })).toThrow(/BAD/);
  });
});
