// The setup wizard's website step (src/cli/init-website.ts) as runInit drives it, the masked prompt
// (src/cli/secret.ts) and what buildConfig writes for ask_services. The crawl, the model detection and
// the model call are scripted through InitDeps.website: no network, no child process. Pages are synthetic.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { PASTE_KEY_LABEL, PROVIDER_QUESTION, WEBSITE_NOTES, WEBSITE_QUESTION, type WebsiteDeps } from "../src/cli/init-website.js";
import { buildConfig, runInit, type InitDeps } from "../src/cli/init.js";
import type { LlmCandidate } from "../src/cli/profile.js";
import { readSecret } from "../src/cli/secret.js";
import { CRAWL_ERRORS, type CrawlResult, type SiteVendor } from "../src/cli/website.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { ScriptedPrompter } from "./helpers/scripted-prompter.js";

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SITE_ZONE = LOCAL_ZONE === "Asia/Tokyo" ? "Europe/Paris" : "Asia/Tokyo";
const PAGE = ["Example Salon", "Our services", "Haircut $45", "Balayage from $80", "Open Tuesday to Saturday", "12 Example Street, Springfield"].join("\n");
const crawled = (vendor?: SiteVendor): CrawlResult => ({
  url: "https://example.com/",
  pages: [{ url: "https://example.com/", title: "Example Salon", text: PAGE }],
  jsonLd: [],
  ...(vendor ? { vendor } : {}),
});
/** A model answer for PAGE: one fixed price, one "from" price. */
const ANSWER = {
  business: { name: "Example Salon", timezone: SITE_ZONE, currency: "CAD", hours: "tue-sat 10:00-18:00" },
  services: [
    { name: "Haircut", evidence: "Haircut $45", price_text: "$45", duration_min: 45 },
    { name: "Balayage", evidence: "Balayage from $80", price_text: "from $80", duration_min: null },
  ],
};
const CLAUDE: LlmCandidate = { kind: "claude", label: "Claude Code", status: "found on this machine", bin: "/opt/example/bin/claude" };
const KEY = { client_email: "gw@p.iam.gserviceaccount.com", private_key: "unused-by-fake" };
const NOT_YET = "Not yet, finish later";

const unexpected = (what: string) => () => {
  throw new Error(`${what} must not be called`);
};
/** A site that reads fine and a model that answers ANSWER. */
const reads = (vendor?: SiteVendor): Required<WebsiteDeps> => ({ crawl: async () => crawled(vendor), detect: () => [CLAUDE], extract: async () => ANSWER });

async function wizard(args: string[], answers: (string | boolean)[], website: WebsiteDeps, extra: InitDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-init-site-"));
  const prompter = new ScriptedPrompter(answers);
  const logs: string[] = [];
  const code = await runInit(["--dir", dir, ...args], { env: {}, prompter, website, makeConnector: () => new FakeCalendarConnector(), log: (m) => logs.push(m), ...extra });
  const config = () => parseConfig(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
  return { dir, code, out: logs.join("\n"), prompter, config };
}

describe("init wizard: website step", () => {
  // protects: Enter at the website question reads nothing and the rest of a first run is what it was.
  // fails_when: an empty answer is crawled anyway, the provider picker shows without a site, or a first
  //   run writes ask_services it was never told about.
  // seam: InitDeps.website (the three calls throw if reached).
  it("Enter at the website question skips the step", async () => {
    const off: WebsiteDeps = { crawl: unexpected("crawl"), detect: unexpected("detect"), extract: unexpected("extract") };
    const r = await wizard([], ["", "", "", NOT_YET, "Ace", "Europe/London", ""], off);
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.prompts[0]).toBe(WEBSITE_QUESTION);
    expect(r.prompter.prompts[1]).toBe("What do you want agents to do? [Book appointments]");
    expect(r.prompter.prompts).toContain("Business or your name"); // no default from anywhere
    expect(r.config().ask_services).toEqual([]);
  });

  // protects: what the site says becomes the default of each later question (name, time zone, currency,
  //   hours, the fixed-price service), --website pre-answers the question, the model CLI is denied the
  //   gateway's secrets, and config.json gets the confirmed service plus the ask-the-owner one.
  // fails_when: a default slot is skipped or filled from the wrong field, the "from $80" service is
  //   offered as bookable, ask_services is not written after the yes, or secretKeys loses a key family.
  // seam: InitDeps.website; buildProfile runs for real on the synthetic page.
  it("a read site prefills the defaults and writes services and ask_services", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "gw-init-site-key-")), "key.json");
    writeFileSync(keyFile, JSON.stringify(KEY));
    let start = "";
    let scrubbed: readonly string[] = [];
    const site: WebsiteDeps = {
      ...reads(),
      crawl: async (url) => {
        start = url.href;
        return crawled();
      },
      extract: async (_c, _crawl, deps) => {
        scrubbed = deps?.secretKeys ?? [];
        return ANSWER;
      },
    };
    const r = await wizard(
      ["--website", "example.com"],
      [
        "", // provider: Claude Code, the first one detected
        "", "", "Yes, I have these", // goal (book only), booking system (Google), ready
        "", "", "", // name, zone, currency: the site's
        "", "", "", "", // Haircut kept: name, duration, buffer, price
        "", // no more services
        true, // list Balayage as an ask-the-owner service
        "", // hours: the site's
        keyFile, "cal@example.com",
        false, // write test
      ],
      site,
    );
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(start).toBe("https://example.com/");
    expect(r.prompter.prompts).not.toContain(WEBSITE_QUESTION);
    for (const q of [
      `${PROVIDER_QUESTION} [Claude Code]`,
      "Business or your name [Example Salon]",
      `Time zone [${SITE_ZONE}]`,
      "Currency [CAD]",
      "  Service 1 name [Haircut]",
      "    Duration (minutes) [45]",
      "    Price (CAD) [45.00]",
      "List them as ask-the-owner services?",
      "Hours [tue-sat 10:00-18:00]",
    ]) {
      expect(r.prompter.prompts, q).toContain(q);
    }
    for (const k of ["SQUARE_ACCESS_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "SLACK_BOT_TOKEN", "TWILIO_AUTH_TOKEN", "API_KEYS"]) expect(scrubbed, k).toContain(k);
    expect(r.out).toContain("the text of those public pages is sent to the provider you choose");
    expect(r.out).toContain(`Your site points to the time zone ${SITE_ZONE}; this machine is set to ${LOCAL_ZONE}.`);
    expect(r.out).toContain("- Balayage (from $80)");
    expect(r.out).toContain("agents can only tell customers to contact you about these"); // goal is book only
    const config = r.config();
    expect([config.name, config.timezone, config.currency]).toEqual(["Example Salon", SITE_ZONE, "CAD"]);
    expect(config.services.map((s) => [s.id, s.duration_min, s.buffer_min, s.price_cents])).toEqual([["haircut", 45, 0, 4500]]);
    expect(config.ask_services).toEqual([{ id: "balayage", name: "Balayage", price_note: "from $80" }]);
    expect(config.hours.tue).toEqual([{ start: "10:00", end: "18:00" }]);
    expect(config.hours.mon).toEqual([]);
  });

  // protects: with the site on a supported platform the provider picker defaults to Skip, and skipping
  //   still pre-selects that booking system and offers the booking page found on the site.
  // fails_when: the vendor is dropped when no model runs, the picker default ignores it, or the found
  //   URL is written without passing the "Booking page URL" prompt.
  // seam: InitDeps.website and makeGlossGenius.
  it("Skip at the provider picker still applies the detected booking system", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "gw-init-site-key-")), "key.json");
    writeFileSync(keyFile, JSON.stringify(KEY));
    const vendor = { kind: "glossgenius", label: "GlossGenius", url: "https://example-studio.glossgenius.com" };
    const r = await wizard(
      [],
      ["example.com", "", "", "", "Yes, I have these", "Example Studio", "", "", "", keyFile, "cal@example.com", ""], // site, provider (Skip), goal, system, ready, name, zone, currency, booking URL, key, calendar, owner channel
      { ...reads(vendor), extract: unexpected("extract") },
      { makeGlossGenius: () => ({ checkAccess: async () => {}, listServices: async () => [] }) },
    );
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.prompts).toContain(`${PROVIDER_QUESTION} [Skip]`);
    expect(r.prompter.prompts.some((q) => q.startsWith("Booking system [GlossGenius"))).toBe(true);
    expect(r.prompter.prompts).toContain("Booking page URL [https://example-studio.glossgenius.com]");
    expect(r.prompter.prompts).toContain("Business or your name"); // nothing was read by a model
    expect(parseEnv(readFileSync(join(r.dir, ".env"), "utf8")).GLOSSGENIUS_BOOKING_URL).toBe("https://example-studio.glossgenius.com");
  });

  // protects: a site that cannot be read costs one fixed line and the wizard carries on by hand; a
  //   failure's own text is printed only when it is one of the crawl's fixed sentences.
  // fails_when: the crawl error escapes runInit, the provider picker still shows, or an arbitrary error
  //   message (an address, a redirect target) is echoed.
  // seam: InitDeps.website.crawl.
  it("a crawl failure prints a fixed note and the wizard continues", async () => {
    const answers = ["example.com", "", "", NOT_YET, "Ace", "", ""];
    const leaky = await wizard([], answers, { ...reads(), crawl: async () => Promise.reject(new Error("redirected to http://10.0.0.5/admin")) });
    expect(leaky.code).toBe(0);
    expect(leaky.prompter.remaining).toBe(0);
    expect(leaky.out).toContain(`${WEBSITE_NOTES.crawl} ${WEBSITE_NOTES.carryOn}`);
    expect(leaky.out).not.toContain("10.0.0.5");
    expect(leaky.prompter.prompts.some((q) => q.startsWith(PROVIDER_QUESTION))).toBe(false);
    const fixed = await wizard([], answers, { ...reads(), crawl: async () => Promise.reject(new Error(CRAWL_ERRORS.timeout)) });
    expect(fixed.out).toContain(CRAWL_ERRORS.timeout);
  });

  // protects: a pasted API key reaches the model call and nothing else: no log line, neither written
  //   file, not the recorded prompt, not even when the call fails with the key in its error text.
  // fails_when: the key is logged, echoed in a failure note, written to .env or config.json, or asked
  //   through the plain prompt.
  // seam: InitDeps.website.extract (records the candidate, then fails quoting the key).
  it("a pasted key is used for the call and appears nowhere else", async () => {
    const pasted = "sk-test-not-a-real-key-0123456789";
    let seen: LlmCandidate | undefined;
    const r = await wizard([], ["example.com", PASTE_KEY_LABEL, "Anthropic", pasted, "", "", NOT_YET, "Ace", "", ""], {
      crawl: async () => crawled(),
      detect: () => [],
      extract: async (c) => {
        seen = c;
        throw new Error(`401 Unauthorized for ${c.apiKey}`);
      },
    });
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect([seen?.kind, seen?.apiKey]).toEqual(["anthropic", pasted]);
    expect(r.prompter.prompts).toContain(`${PROVIDER_QUESTION} [Skip]`); // nothing detected: Skip is the default
    expect(r.prompter.prompts).toContain("Anthropic API key (hidden; Enter to skip) [secret]");
    expect(r.out).toContain(`${WEBSITE_NOTES.llm} ${WEBSITE_NOTES.carryOn}`);
    for (const text of [r.out, r.prompter.prompts.join("\n"), readFileSync(join(r.dir, ".env"), "utf8"), readFileSync(join(r.dir, "config.json"), "utf8")]) {
      expect(text).not.toContain(pasted);
    }
  });

  // protects: a "Review and update" run is not asked for a website, even with --website.
  // fails_when: the step runs whenever the flag is present, putting site values ahead of saved answers.
  // seam: InitDeps.website (the three calls are counted: the step swallows a crawl failure by design, so
  //   a fake that only throws would not show that it ran).
  it("a review run is not asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-site-saved-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Saved Co", timezone: "Europe/London", currency: "GBP", services: [{ id: "cut", name: "Cut", duration_min: 30, price_cents: 2000 }], hours: {} }));
    const prompter = new ScriptedPrompter(["", "", "", NOT_YET, "", "", ""]); // existing setup (Review), goal, system, not ready, name, zone, currency
    const logs: string[] = [];
    let reached = 0;
    const counted = (): never => {
      reached++;
      throw new Error("the website step must not run");
    };
    const code = await runInit(["--dir", dir, "--website", "example.com"], {
      env: {},
      prompter,
      website: { crawl: counted, detect: counted, extract: counted },
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(prompter.remaining).toBe(0);
    expect(reached).toBe(0);
    expect(logs.join("\n")).not.toContain("Reading example.com");
    expect(prompter.prompts).not.toContain(WEBSITE_QUESTION);
    expect(prompter.prompts).toContain("Business or your name [Saved Co]");
    expect(logs.join("\n")).toContain("--website is only used on a first run");
  });

  // protects: the one yes or no for ask-the-owner services covers exactly what was on screen: every
  //   entry is printed before the question, and an entry config.json then leaves out is named.
  // fails_when: the list is cut to its first few lines while all of it is written (text nobody saw
  //   reaches config.json and /llms.txt), or an entry whose id a bookable service has is dropped silently.
  // seam: InitDeps.website; buildProfile runs for real on the synthetic page.
  it("shows every ask-the-owner service before the confirm and names one it leaves out", async () => {
    const extras = Array.from({ length: 13 }, (_, i) => ({ name: `Extra ${i + 1}`, note: `from $${i + 11}` }));
    const text = ["Example Salon", "Haircut $45", "Haircut! from $80", ...extras.map((e) => `${e.name} ${e.note}`)].join("\n");
    const site: WebsiteDeps = {
      crawl: async () => ({ url: "https://example.com/", pages: [{ url: "https://example.com/", title: "Example Salon", text }], jsonLd: [] }),
      detect: () => [CLAUDE],
      extract: async () => ({
        business: { name: "Example Salon" },
        services: [
          { name: "Haircut", evidence: "Haircut $45", price_text: "$45", duration_min: null },
          { name: "Haircut!", evidence: "Haircut! from $80", price_text: "from $80", duration_min: null },
          ...extras.map((e) => ({ name: e.name, evidence: `${e.name} ${e.note}`, price_text: e.note, duration_min: null })),
        ],
      }),
    };
    const r = await wizard([], ["example.com", "", "", "", NOT_YET, "", "", "", "", "", "", "", "", true, ""], site); // address, provider, goal, system, not ready, name, zone, currency, Haircut kept (4), no more, ask services, hours
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.out).toContain("Your site also lists 14 services");
    for (const line of ["- Haircut! (from $80)", ...extras.map((e) => `- ${e.name} (${e.note})`)]) expect(r.out, line).toContain(`${line}\n`);
    expect(r.out).not.toMatch(/and \d+ more/);
    expect(r.out).toMatch(/Not listed as ask-the-owner \(.*\): Haircut!\./);
    const config = r.config();
    expect(config.services.map((s) => s.id)).toEqual(["haircut"]);
    expect(config.ask_services.map((s) => s.name)).toEqual(extras.map((e) => e.name));
  });

  // protects: "Not yet, finish later" with services and hours read from the site still asks about them
  //   (so the reading is not thrown away), accepts an empty bookable list, and a bad address is re-asked.
  // fails_when: the not-ready path skips services and hours as it does without a site, or insists on one
  //   bookable service before anything is connected.
  // seam: InitDeps.website.
  it("Not yet with a read site still asks services and hours", async () => {
    const r = await wizard(
      [],
      ["not a url", "example.com", "", "", "", NOT_YET, "", "", "", "-", "", true, ""], // bad address, address, provider, goal, system, not ready, name, zone, currency, remove Haircut, no more, ask services, hours
      reads(),
    );
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.out).toContain("That does not look like a website address");
    expect(r.out).toContain("Removed Haircut.");
    const config = r.config();
    expect(config.services).toEqual([]);
    expect(config.ask_services.map((s) => s.name)).toEqual(["Balayage"]);
    expect(config.hours.sat).toEqual([{ start: "10:00", end: "18:00" }]);
    expect(readFileSync(join(r.dir, ".env"), "utf8")).not.toMatch(/^GOOGLE_/m);
  });

  // protects: nothing read from the site is written unless its question was asked: with Square the
  //   services and hours questions are skipped, so the site's services and hours stay out of config.json.
  // fails_when: the site's hours become the unasked default, or its services are added behind a
  //   platform that supplies its own.
  // seam: InitDeps.website.
  it("with Square the site's services and hours are not written", async () => {
    const r = await wizard([], ["example.com", "", "", "Square Appointments", NOT_YET, "", "", ""], reads()); // address, provider, goal, system, not ready, name, zone, currency
    expect(r.code).toBe(0);
    expect(r.prompter.remaining).toBe(0);
    expect(r.prompter.prompts.some((q) => q.startsWith("Hours") || q.startsWith("  Service") || q.startsWith("List them"))).toBe(false);
    expect(r.out).toContain("Square supplies your services, so the ones found on your site were not added.");
    const config = r.config();
    expect(config.name).toBe("Example Salon"); // confirmed at its prompt
    expect([config.services, config.ask_services]).toEqual([[], []]);
    expect([config.hours.mon, config.hours.sat]).toEqual([[{ start: "09:00", end: "17:00" }], []]); // the wizard's default, not the site's tue-sat
  });
});

describe("buildConfig: ask_services", () => {
  const example = JSON.parse(readFileSync("config.example.json", "utf8")) as Record<string, unknown>;
  const answers = { name: "Ace", timezone: "Europe/London", currency: "GBP", services: [{ name: "Balayage", duration_min: 60, buffer_min: 0, price_cents: 9000 }], hours: "mon-fri 09:00-17:00" };

  // protects: buildConfig always hands parseConfig an ask list it accepts: a saved ask service whose id
  //   is now bookable is dropped, a first run takes nothing from the base, and answered names get ids
  //   that are slug-shaped, at most 64 characters and unique.
  // fails_when: the saved list is carried over unfiltered (parseConfig then throws "already in services"
  //   after the merchant has answered everything), the example's list leaks into a first run, or a long
  //   or repeated name yields an id the schema rejects.
  // seam: none (buildConfig is pure).
  it("drops an ask service that became bookable, never inherits from the base, and caps and de-duplicates ids", () => {
    const saved = parseConfig({
      name: "Ace",
      timezone: "Europe/London",
      currency: "GBP",
      services: [{ id: "cut", name: "Cut", duration_min: 30, price_cents: 2000 }],
      ask_services: [{ id: "balayage", name: "Balayage" }, { id: "perm", name: "Perm", price_note: "from £60" }],
      hours: {},
    });
    const resumed = buildConfig(answers, saved, saved);
    expect(resumed.services.map((s) => s.id)).toEqual(["balayage"]);
    expect(resumed.ask_services).toEqual([{ id: "perm", name: "Perm", price_note: "from £60" }]);

    expect(buildConfig(answers, { ...example, ask_services: [{ id: "x", name: "X" }] }).ask_services).toEqual([]);

    const long = "x".repeat(70);
    const answered = buildConfig({ ...answers, ask_services: [{ name: `${long} one` }, { name: `${long} two` }, { name: "Balayage" }, { name: "Up<do>" }, { name: "Colour", price_note: "from $80" }] }, example);
    expect(answered.ask_services.map((s) => s.id)).toEqual(["x".repeat(64), `${"x".repeat(62)}-2`, "colour"]);
    expect(answered.ask_services[2]).toEqual({ id: "colour", name: "Colour", price_note: "from $80" });
    const many = buildConfig({ ...answers, ask_services: Array.from({ length: 60 }, (_, i) => ({ name: `Extra ${i}` })) }, example);
    expect(many.ask_services).toHaveLength(50);
  });
});

describe("readSecret", () => {
  /** A raw-mode-capable terminal that records what is drawn on it (as in picker.test.ts). */
  function fakeTty() {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode(on: boolean) {
        this.isRaw = on;
        return this;
      },
      resume() {},
      pause() {},
    });
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true,
      out: "",
      write(s: string) {
        this.out += s;
        return true;
      },
    });
    const io = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream };
    const type = (...keys: string[]) => queueMicrotask(() => keys.forEach((k) => stdin.emit("data", Buffer.from(k))));
    return { stdin, stdout, io, type };
  }

  // protects: typed and pasted characters are returned but only dots are drawn, backspace removes one
  //   character, an arrow key adds nothing, Enter ends the input and the terminal leaves raw mode.
  // fails_when: the value is echoed, a paste is dropped or read key by key into escape handling,
  //   backspace is taken as a character, or raw mode / the data listener is left behind.
  // seam: none (the `io` option is the reader's own test hook).
  it("returns what was typed and pasted, drawing only dots, and restores the terminal", async () => {
    const { stdin, stdout, io, type } = fakeTty();
    type("s", "k", "-pasted-KEY9", "\x1b[A", "\x7f", "\r");
    expect(await readSecret("API key", { io, color: false })).toBe("sk-pasted-KEY");
    expect(stdout.out).toContain("API key: ");
    expect(stdout.out).not.toMatch(/pasted|KEY/);
    expect(stdout.out.match(/•/g)).toHaveLength(14);
    expect(stdout.out.endsWith("\n")).toBe(true);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  // protects: Ctrl+C leaves raw mode and exits 130 like the picker; without a terminal that can hide
  //   typing the question is skipped with one note and "" comes back.
  // fails_when: Ctrl+C is taken as a character (the wizard hangs in raw mode), or a piped stdin is read
  //   in the clear.
  // seam: process.exit stubbed with vi.spyOn in the test only.
  it("Ctrl+C exits 130 with the terminal restored; without a terminal it skips with a note", async () => {
    const { stdin, io, type } = fakeTty();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      type("abc", "\x03");
      expect(await readSecret("API key", { io, color: false })).toBe("");
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
    }
    expect(stdin.isRaw).toBe(false);

    const piped = new PassThrough();
    const out = new PassThrough();
    let printed = "";
    out.on("data", (c) => (printed += c.toString()));
    piped.write("sk-typed-into-a-pipe\n");
    expect(await readSecret("API key", { io: { stdin: piped as unknown as NodeJS.ReadStream, stdout: out as unknown as NodeJS.WriteStream } })).toBe("");
    expect(printed).toContain("skipped");
  });
});
