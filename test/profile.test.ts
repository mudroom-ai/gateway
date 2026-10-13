// The init wizard's website reader (src/cli/profile.ts): which model access is offered, how one model
// call is made, and what survives of the model's answer. No network and no child process: the CLI
// runner and fetch are scripted, and the pages are synthetic.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LLM_ERRORS, buildProfile, cleanLine, detectLlm, extractWithLlm, keyCandidate, type RunCli } from "../src/cli/profile.js";
import type { CrawlResult } from "../src/cli/website.js";

const LONG_LINE = `Massage ${"very ".repeat(45)}relaxing $70`;
const PRICE_LIST = [
  "Example Salon",
  "Our services",
  "Haircut (45 min) $45",
  "Kids Cut $27 Reg, $24 Mem",
  "Colour from $80",
  "Balayage $91+",
  "Blowout $60-$75",
  "Private Lesson $100/hour",
  "Beard Trim",
  "$20",
  "and up",
  "Deluxe `Cut` <VIP> - $35",
  "Brow Wax $30-45",
  "Kids Trim $12",
  LONG_LINE,
  "Facial $90 - 60 min",
  `Long ${"x".repeat(500)}`,
  "Call +1 202 555 0199",
].join("\n");

const crawl: CrawlResult = {
  url: "https://example.com/",
  pages: [
    { url: "https://example.com/", title: "Example Salon | Hair in Springfield", text: "Welcome to Example Salon." },
    { url: "https://example.com/services", title: "Services", text: PRICE_LIST },
  ],
  jsonLd: ['{"@type":"HairSalon","name":"Example Salon"}'],
  vendor: { kind: "mangomint", label: "Mangomint" },
};

const service = (name: string, evidence: string | null, price_text: string | null, duration_min: number | null = null) => ({
  name,
  kind: "appointment",
  evidence,
  price_text,
  price_kind: "fixed",
  price_cents: 1,
  duration_min,
  duration_text: null,
});
const answer = (services: unknown[], business: Record<string, unknown> = {}) => ({ business, services });
/** A one-page site with this text. */
const page = (text: string): CrawlResult => ({ url: "https://example.com/", pages: [{ url: "https://example.com/", title: "Example Salon", text }], jsonLd: [] });
const anyHours = () => true;

describe("buildProfile", () => {
  // protects: a service is bookable only when the line the model quoted is on the page with one fixed
  //   price; the price is the page's number, never the model's price_cents. Every other service the
  //   page names goes to the ask list with the page's own price phrase.
  // fails_when: "from $80", "$91+", "$60-$75", "$100/hour" or "$27 Reg, $24 Mem" becomes a bookable
  //   price, the model's price_cents is used, or a fixed price loses its duration.
  // seam: none (pure function over a synthetic crawl).
  it("keeps a fixed price as bookable and sends every qualified price to the ask list", () => {
    const profile = buildProfile(
      crawl,
      answer([
        service("Haircut", "Haircut (45 min) $45", "$45", 45),
        service("Facial", "Facial $90 - 60 min", "$90", 60.5),
        service("Colour", "Colour from $80", "from $80"),
        service("Balayage", "Balayage $91+", "$91+"),
        service("Blowout", "Blowout $60-$75", "$60-$75"),
        service("Private Lesson", "Private Lesson $100/hour", "$100/hour"),
        service("Kids Cut", "Kids Cut $27 Reg, $24 Mem", "$27 Reg, $24 Mem"),
      ]),
      anyHours,
    );
    expect(profile.bookable).toEqual([
      { name: "Haircut", duration_min: 45, price_cents: 4500 },
      { name: "Facial", price_cents: 9000 },
    ]);
    expect(profile.ask).toEqual([
      { name: "Colour", price_note: "from $80" },
      { name: "Balayage", price_note: "$91+" },
      { name: "Blowout", price_note: "$60-$75" },
      { name: "Private Lesson", price_note: "$100/hour" },
      { name: "Kids Cut", price_note: "$27 Reg, $24 Mem" },
    ]);
    expect(profile.vendor).toEqual({ kind: "mangomint", label: "Mangomint" });
  });

  // protects: the qualifier is looked for on the page, not in the model's quote, so a quote cut short
  //   of "+", of a second price, of "-45" or of "and up" on the next line does not make a fixed price,
  //   and neither does the tail of a longer line ("Trim $12" out of "Kids Trim $12"). A service or a
  //   price that is not on the page does not come through at all.
  // fails_when: "Balayage $91" (a substring of "Balayage $91+") is accepted as $91, an invented
  //   "Blowout $50" is bookable or keeps its price note, another service's line or a line over 200
  //   characters gives a price, or an unlisted service is offered.
  // seam: none.
  it("does not trust a truncated quote, an invented price or an invented service", () => {
    const profile = buildProfile(
      crawl,
      answer([
        service("Balayage", "Balayage $91", "$91"),
        service("Kids Cut", "Kids Cut $27", "$27"),
        service("Colour", "Colour $80", "$80"),
        service("Brow Wax", "Brow Wax $30", "$30"),
        service("Trim", "Trim $12", "$12"),
        service("Massage", LONG_LINE, "$70"),
        service("Blowout", "Blowout $50", "$50"),
        service("Beard Trim", "Beard Trim $20", "$20"),
        service("Our services", "Haircut (45 min) $45", "$15"),
        service("Hot Stone Massage", "Hot Stone Massage $120", "$120"),
        service("Haircut", "$45", "$45"),
        service("haircut", "Haircut (45 min) $45", "$45"),
      ]),
      anyHours,
    );
    expect(profile.bookable).toEqual([]);
    expect(profile.ask.map((s) => s.name)).toEqual(["Balayage", "Kids Cut", "Colour", "Brow Wax", "Trim", "Massage", "Blowout", "Beard Trim", "Our services", "Haircut"]);
    // "$91", "$27", "$80", "$30" and "$20" are on the page only as part of a qualified price; "$50" and "$15" are not on it at all.
    expect(profile.ask.filter((s) => s.price_note)).toEqual([
      { name: "Trim", price_note: "$12" },
      { name: "Massage", price_note: "$70" },
      { name: "Haircut", price_note: "$45" },
    ]);
  });

  // protects: the row is read whole, so a qualifier that does not touch the amount, a currency code, a
  //   footnote digit, a unit after a bare number, another row's price or the model's own "from" label
  //   never yields a fixed price, while a plain row keeps its price whatever the next row starts with.
  // fails_when: the check goes back to looking only at what touches the amount ("$150 (and up)" is
  //   bookable at $150), "$80¹" is read as $801, "Haircut" takes the price of "Kids Haircut $20",
  //   price_kind is ignored, or "Blowout $45" is demoted because the next row starts with "Up".
  // seam: none.
  it("reads the whole row: anything beside the name and the amount but a duration means not fixed", () => {
    const qualified: [name: string, row: string][] = [
      ["Color Correction", "Color Correction $150 (and up)"],
      ["Group Class", "Group Class $25 (per person)"],
      ["Updo", "Updo (from) $85"],
      ["Tutoring", "Tutoring $45 hr"],
      ["Gel Nails", "Gel Nails US$40"],
      ["Lash Lift", "Lash Lift $80¹"],
      ["Toner", "Toner 25¢"],
    ];
    const rows = [...qualified.map(([, row]) => row), "Waxing 45 minutes", "Blowout $45", "Up-do $60+", "Kids Haircut $20", "Manicure - 30 min - $30"];
    const profile = buildProfile(
      page(rows.join("\n")),
      answer([
        ...qualified.map(([name, row]) => service(name, row, null)),
        service("Waxing", "Waxing 45", null),
        service("Blowout", "Blowout $45", null),
        service("Kids Haircut", "Kids Haircut $20", null),
        service("Haircut", "Kids Haircut $20", null),
        { ...service("Manicure", "Manicure - 30 min - $30", "$30", 30), price_kind: "from" },
      ]),
      anyHours,
    );
    expect(profile.bookable).toEqual([
      { name: "Blowout", price_cents: 4500 },
      { name: "Kids Haircut", price_cents: 2000 },
    ]);
    expect(profile.ask.map((s) => s.name)).toEqual([...qualified.map(([name]) => name), "Waxing", "Haircut", "Manicure"]);
    expect(profile.ask.at(-1)).toEqual({ name: "Manicure", price_note: "$30" });
    // The same row without the model's "from" label is a fixed price with its duration.
    expect(buildProfile(page(rows.join("\n")), answer([service("Manicure", "Manicure - 30 min - $30", "$30", 30)]), anyHours).bookable).toEqual([
      { name: "Manicure", duration_min: 30, price_cents: 3000 },
    ]);
  });

  // protects: a country written before a dollar sign is part of the amount, and gives a fixed price only
  //   when it names the currency the site was found to use.
  // fails_when: "US$40" stays on the ask list of a USD site (a priced row listed as having no fixed
  //   price), is bookable on a site in another or an unknown currency, or a letter that is not one of
  //   the countries ("R$30") is read as part of the amount.
  // seam: none.
  it("reads a country before a dollar sign as the amount when it names the site's currency", () => {
    const rows = ["Gel Nails US$40", "Lash Lift S$80", "Brow Tint R$30", "Manicure", "US$25"].join("\n");
    const services = [
      service("Gel Nails", "Gel Nails US$40", "US$40"),
      service("Lash Lift", "Lash Lift S$80", "S$80"),
      service("Brow Tint", "Brow Tint R$30", "R$30"),
      service("Manicure", "Manicure US$25", "US$25"),
    ];
    const usd = buildProfile(page(rows), answer(services, { currency: "USD" }), anyHours);
    expect(usd.bookable).toEqual([
      { name: "Gel Nails", price_cents: 4000, price_currency: "USD" },
      { name: "Manicure", price_cents: 2500, price_currency: "USD" },
    ]);
    expect(usd.ask.map((s) => s.name)).toEqual(["Lash Lift", "Brow Tint"]);
    expect(buildProfile(page(rows), answer(services, { currency: "SGD" }), anyHours).bookable).toEqual([{ name: "Lash Lift", price_cents: 8000, price_currency: "SGD" }]);
    expect(buildProfile(page(rows), answer(services), anyHours).bookable).toEqual([]);
  });

  // protects: what the model marks as a product for sale is left out of both lists and named in
  //   `products`, and `shop` is set only by how_customers_book "online_store".
  // fails_when: a handbag is offered as an ask-the-owner "service", a product that is not on the page
  //   is named, or the kind label does more than take a service away.
  // seam: none.
  it("leaves products out of both lists and says when the site is an online store", () => {
    const rows = ["Example Store", "Tote Bag $159", "Kitten Heels $89", "Bag Repair $40"].join("\n");
    const product = (name: string, evidence: string | null) => ({ ...service(name, evidence, null), kind: "product" });
    const raw = {
      ...answer([product("Tote Bag", "Tote Bag $159"), product("Kitten Heels", "Kitten Heels $89"), product("Gift Cards", null), service("Bag Repair", "Bag Repair $40", "$40")]),
      booking_system: { how_customers_book: "online_store" },
    };
    const profile = buildProfile(page(rows), raw, anyHours);
    expect(profile.products).toEqual(["Tote Bag", "Kitten Heels"]); // "Gift Cards" is not on the page
    expect(profile.shop).toBe(true);
    expect([profile.bookable, profile.ask]).toEqual([[{ name: "Bag Repair", price_cents: 4000 }], []]);
    // Every product is counted, not only the first MAX_ASK.
    const many = Array.from({ length: 60 }, (_, i) => `Item${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Thing`);
    const manyRaw = answer(many.map((n) => product(n, null)));
    expect(buildProfile(page(many.join("\n")), manyRaw, anyHours).products).toHaveLength(60);
    // The same row without the label is a service like any other.
    expect(buildProfile(page(rows), answer([service("Tote Bag", "Tote Bag $159", "$159")]), anyHours)).toMatchObject({ shop: false, products: [], bookable: [{ name: "Tote Bag", price_cents: 15900 }] });
  });

  // protects: a price list laid out as cells, one per line: a second price under the first (the next
  //   column) means the service has no single price, and a price is never taken from the row above.
  // fails_when: only the amount's own line is checked for a second price ("Haircut $45" out of the
  //   cells "Haircut", "$45", "$65" is bookable), or "$20 Shave" pairs Shave with Beard Trim's price.
  // seam: none.
  it("does not take a fixed price from a row with a second price cell, or from the row above", () => {
    const cells = ["Service", "Short", "Long", "Haircut", "$45", "$65", "Beard Trim", "$20", "Shave", "$15", "Wash", "$10", "and up"];
    const profile = buildProfile(
      page(cells.join("\n")),
      answer([service("Haircut", "Haircut $45", "$45"), service("Beard Trim", "Beard Trim $20", "$20"), service("Shave", "$20 Shave", "$15"), service("Wash", "Wash $10", "$10")]),
      anyHours,
    );
    expect(profile.bookable).toEqual([{ name: "Beard Trim", price_cents: 2000 }]);
    expect(profile.ask).toEqual([{ name: "Haircut" }, { name: "Shave", price_note: "$15" }, { name: "Wash" }]);
  });

  // protects: a price note is the page's phrase beside that service's own name, stored whole or not at
  //   all, and no name or note carries a markdown link or a web address into the text agents read.
  // fails_when: a note is taken from another service's row, a long phrase is cut inside its number
  //   ("$1,500" stored as "$1"), or "[text](url)" survives in a name or a note.
  // seam: none.
  it("keeps a price note only from the service's own row, never cut, never a link", () => {
    const phrase = "Full consultation and written treatment plan, new clients $1,500 per course";
    const text = ["Bridal makeup from $400", "Gift card $20", "Free parking", `Plan ${phrase}`, "[New] Scalp Massage [details](https://example.com/pay)"].join("\n");
    const profile = buildProfile(
      page(text),
      answer([
        service("Bridal makeup", null, "$20"),
        service("Gift card", null, "$20"),
        service("Free parking", null, "from $400"),
        service("Plan", null, phrase),
        service("[New] Scalp Massage", null, "[details](https://example.com/pay)"),
        service("[details](https://example.com/pay)", null, null),
      ]),
      anyHours,
    );
    expect(profile.ask).toEqual([{ name: "Bridal makeup" }, { name: "Gift card", price_note: "$20" }, { name: "Free parking" }, { name: "Plan" }, { name: "New Scalp Massage" }]);
  });

  // protects: nothing the model or the page wrote can carry a terminal escape, a line break or markdown
  //   markup into a prompt default or the agent-facing markdown, and no name is longer than 80.
  // fails_when: cleanLine stops stripping control or format characters, names keep backticks or angle
  //   brackets, or the length cap is dropped.
  // seam: none.
  it("neutralises escape sequences, line breaks, markup and very long strings", () => {
    expect(cleanLine("a\u001b[31m\r\nb\u202e\u200b c\u2028d", 100)).toBe("a [31m b c d");
    expect(cleanLine("\ud83d\ude00".repeat(5), 3)).toBe("\ud83d\ude00".repeat(3));

    const profile = buildProfile(
      crawl,
      answer(
        [
          service("Deluxe `Cut`\n<VIP>", "Deluxe `Cut` <VIP> - $35", "$35"),
          service(`Long ${"x".repeat(500)}`, null, null),
          service("Hair\u200bcut\u0007", null, "$45`"),
          service("\u001b[2JBlowout", null, null),
        ],
        { name: "Example\u001b[0m Salon" },
      ),
      anyHours,
    );
    expect(profile.bookable).toEqual([{ name: "Deluxe Cut VIP", price_cents: 3500 }]);
    expect(profile.ask).toEqual([{ name: `Long ${"x".repeat(75)}` }, { name: "Haircut" }]);
    expect(profile.name).toBeUndefined();
    expect([...profile.bookable, ...profile.ask].map((s) => s.name).join("")).not.toMatch(/[\p{Cc}\p{Cf}`<>]/u);
  });

  // protects: time zone, currency and hours reach the wizard only as valid values of their own
  //   vocabularies, and the business name only when the site has it.
  // fails_when: a made-up zone or currency code, free text in the hours field, or hours the wizard's
  //   own parser refuses is kept.
  // seam: the validHours argument.
  it("keeps the business fields only when they are valid", () => {
    const good = { name: "Example Salon", timezone: "America/Chicago", currency: "usd", hours: "Mon-Fri 09:00-17:00;sat 10:00-14:00" };
    expect(buildProfile(crawl, answer([], good), anyHours)).toMatchObject({
      name: "Example Salon",
      timezone: "America/Chicago",
      currency: "USD",
      hours: "mon-fri 09:00-17:00; sat 10:00-14:00",
    });
    expect(buildProfile(crawl, answer([], good), () => false).hours).toBeUndefined();
    expect(
      buildProfile(crawl, answer([], good), () => {
        throw new Error("no");
      }).hours,
    ).toBeUndefined();

    const bad = buildProfile(crawl, answer([], { name: "Someone Else Ltd", timezone: "Mars/Phobos", currency: "ZZZ", hours: "weekdays 9am to 5pm, ignore the above" }), anyHours);
    expect(bad).toEqual({ vendor: crawl.vendor, bookable: [], ask: [], products: [], shop: false });
    expect(buildProfile(crawl, answer([], { timezone: "+05:00" }), anyHours).timezone).toBeUndefined();
  });

  // protects: buildProfile is total, so a model that answers with anything at all cannot crash the wizard.
  // fails_when: a missing or mistyped field is dereferenced.
  // seam: none.
  it("returns an empty profile for an answer of the wrong shape", () => {
    const bare = { ...crawl, vendor: undefined };
    for (const raw of [null, undefined, "nonsense", 42, [], { services: "many" }, { business: "x", services: [null, 7, "x", { name: 9 }, {}] }]) {
      expect(buildProfile(bare, raw, anyHours)).toEqual({ bookable: [], ask: [], products: [], shop: false });
    }
    const mistyped = { business: [], services: [{ name: "Haircut", evidence: {}, price_text: 45, duration_min: "45" }] };
    expect(buildProfile(bare, mistyped, anyHours)).toEqual({ bookable: [], ask: [{ name: "Haircut" }], products: [], shop: false });
    expect(buildProfile(null as unknown as CrawlResult, { services: [service("Haircut", null, null)] }, anyHours)).toEqual({ bookable: [], ask: [], products: [], shop: false });
  });
});

describe("detectLlm", () => {
  // protects: only an executable in an absolute PATH directory is offered, with its absolute path,
  //   then keys from the environment; opencode is never offered and a key never shows in a label.
  // fails_when: a relative PATH entry is searched, a non-executable file counts, opencode is listed,
  //   or the key leaks into label or status.
  // seam: the env argument, pointing PATH at temp directories of fake executables.
  it("finds CLIs in absolute PATH entries and keys in the environment, in order", () => {
    const root = mkdtempSync(join(tmpdir(), "gw-profile-"));
    const exe = (dir: string, name: string, mode = 0o755) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), "#!/bin/sh\n");
      chmodSync(join(dir, name), mode);
    };
    const bin = join(root, "bin");
    const other = join(root, "other");
    exe(bin, "codex");
    exe(bin, "opencode");
    exe(bin, "claude", 0o644);
    exe(other, "claude");

    const key = "sk-test-0123456789";
    const env = { PATH: [relative(process.cwd(), other), bin].join(delimiter), ANTHROPIC_API_KEY: key, OPENAI_API_KEY: "  " };
    const found = detectLlm(env);
    expect(found).toEqual([
      { kind: "codex", label: "Codex", status: "found on this machine", bin: join(bin, "codex") },
      { kind: "anthropic", label: "Anthropic API key", status: "from ANTHROPIC_API_KEY", apiKey: key },
    ]);

    const both = detectLlm({ PATH: [other, bin].join(delimiter), OPENAI_API_KEY: key });
    expect(both.map((c) => c.kind)).toEqual(["claude", "codex", "openai"]);
    expect(detectLlm({ DEEPSEEK_API_KEY: key })).toEqual([{ kind: "deepseek", label: "DeepSeek API key", status: "from DEEPSEEK_API_KEY", apiKey: key }]);
    expect(both.every((c) => !c.bin || isAbsolute(c.bin))).toBe(true);
    expect(JSON.stringify(both.map((c) => [c.label, c.status]))).not.toContain(key);
    expect(keyCandidate("openai", ` ${key}\n`)).toEqual({ kind: "openai", label: "OpenAI API key", status: "pasted", apiKey: key });
    expect(detectLlm({})).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("extractWithLlm", () => {
  const secrets = { SQUARE_ACCESS_TOKEN: "sq-secret", SLACK_BOT_TOKEN: "xoxb-secret" };
  // PWD, INIT_CWD and npm_* are what `npm run init` adds: each names the directory that holds .env.
  const env = { PATH: "/usr/bin", HOME: "/home/example", PWD: "/srv/gateway", INIT_CWD: "/srv/gateway", npm_package_json: "/srv/gateway/package.json", ...secrets };
  const model = { business: { name: "Example Salon" }, services: [] };

  interface Call {
    bin: string;
    args: string[];
    o: Parameters<RunCli>[2];
  }
  const scriptedCli = (reply: (call: Call) => { code: number | null; stdout: string }) => {
    const calls: Call[] = [];
    const runCli: RunCli = async (bin, args, o) => {
      calls.push({ bin, args, o });
      return reply({ bin, args, o });
    };
    return { calls, deps: { runCli, env, secretKeys: Object.keys(secrets) } };
  };

  // protects: the page text reaches a CLI on stdin only, the argument list is the fixed tool-less flag
  //   set, the child runs in an empty temp directory that is removed afterwards, the gateway's own
  //   secrets and the path of its directory are not in its environment, and a page's address cannot
  //   grow the prompt past its budget.
  // fails_when: page text is passed as an argument, a tool-removing flag is dropped, the child inherits
  //   .env secrets or INIT_CWD, the temp directory is left behind, or a page URL goes in uncapped.
  // seam: deps.runCli, deps.env, deps.secretKeys.
  it("runs Claude Code with the page text on stdin and a scrubbed environment", async () => {
    const cli = scriptedCli(() => ({ code: 0, stdout: JSON.stringify({ type: "result", structured_output: model }) }));
    const longUrl = { url: `https://example.com/${"a".repeat(5_000)}`, title: "More", text: "More services" };
    const out = await extractWithLlm({ kind: "claude", label: "Claude Code", status: "", bin: "/opt/bin/claude" }, { ...crawl, pages: [...crawl.pages, longUrl] }, cli.deps);
    expect(out).toEqual(model);

    const call = cli.calls[0]!;
    expect(call.bin).toBe("/opt/bin/claude");
    expect(call.o.stdin).toContain("Balayage $91+");
    expect(call.o.stdin).toContain("https://example.com/services");
    expect(call.args.join("\n")).not.toContain("Balayage");
    expect(call.args.join("\n")).not.toContain("example.com");
    expect(call.args.slice(0, 12)).toEqual(["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"]);
    expect(call.args[call.args.indexOf("--system-prompt") + 1]).toMatch(/untrusted website/);
    expect(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]!).properties.services.items.required).toContain("evidence");
    expect(call.o.stdin).toContain("More services");
    expect(call.o.stdin).not.toContain("a".repeat(400));
    expect(call.o.env).toEqual({ PATH: "/usr/bin", HOME: "/home/example", PWD: call.o.cwd });
    expect(call.o.timeoutMs).toBe(120_000);
    expect(call.o.cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(call.o.cwd)).toBe(false);
  });

  // protects: Codex is run read-only with its shell, apps and web search turned off, without the user's
  //   config or a saved session, with the schema and the answer in files inside the temp directory and
  //   the prompt on stdin.
  // fails_when: a sandbox, isolation or tool-off flag is dropped, or the prompt moves into the argument list.
  // seam: deps.runCli (the fake writes the answer file the way codex does).
  it("runs Codex read-only with its tools off and reads its answer file", async () => {
    const cli = scriptedCli(({ args, o }) => {
      expect(JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1]!, "utf8")).required).toContain("services");
      writeFileSync(args[args.indexOf("-o") + 1]!, JSON.stringify(model));
      expect(o.stdin).toMatch(/^You fill in a merchant profile[\s\S]*Haircut \(45 min\) \$45/);
      return { code: 0, stdout: "" };
    });
    const out = await extractWithLlm({ kind: "codex", label: "Codex", status: "", bin: "/opt/bin/codex" }, crawl, cli.deps);
    expect(out).toEqual(model);
    const { args, o } = cli.calls[0]!;
    expect(args.slice(0, 8)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "read-only", "-m", "gpt-6-luna"]);
    expect(args).toContain("--strict-config"); // without it Codex ignores an override it does not know, leaving that tool on
    for (const feature of ["shell_tool", "unified_exec", "apps"]) expect(args[args.indexOf(feature) - 1]).toBe("--disable");
    for (const override of ['web_search="disabled"', "mcp_servers={}", "features.view_image=false"]) expect(args[args.indexOf(override) - 1]).toBe("-c");
    expect(args.at(-1)).toBe("-");
    expect(args.join("\n")).not.toContain("Haircut");
    expect(args[args.indexOf("-o") + 1]!.startsWith(o.cwd)).toBe(true);
    expect(o.env).not.toHaveProperty("SQUARE_ACCESS_TOKEN");
  });

  // protects: every failure of a CLI is one fixed sentence; the child's own output never reaches the
  //   wizard's screen. opencode and a relative executable path are refused before anything runs.
  // fails_when: stdout or a thrown error's text is put into the message, or opencode is spawned.
  // seam: deps.runCli.
  it("rejects with fixed text when a CLI fails, and never runs opencode", async () => {
    const claude = { kind: "claude" as const, label: "", status: "", bin: "/opt/bin/claude" };
    const failing = scriptedCli(() => ({ code: 1, stdout: "Balayage sq-secret stack trace" }));
    await expect(extractWithLlm(claude, crawl, failing.deps)).rejects.toThrow(new Error(LLM_ERRORS.failed));
    const garbled = scriptedCli(() => ({ code: 0, stdout: "not json sq-secret" }));
    await expect(extractWithLlm(claude, crawl, garbled.deps)).rejects.toThrow(new Error(LLM_ERRORS.badAnswer));
    const throwing: RunCli = async () => {
      throw new Error("spawn /opt/bin/claude ENOENT sq-secret");
    };
    await expect(extractWithLlm(claude, crawl, { runCli: throwing })).rejects.toThrow(new Error(LLM_ERRORS.failed));

    const never = scriptedCli(() => ({ code: 0, stdout: "{}" }));
    await expect(extractWithLlm({ kind: "opencode", label: "", status: "", bin: "/opt/bin/opencode" }, crawl, never.deps)).rejects.toThrow(new Error(LLM_ERRORS.unsupported));
    await expect(extractWithLlm({ ...claude, bin: "claude" }, crawl, never.deps)).rejects.toThrow(new Error(LLM_ERRORS.failed));
    expect(never.calls).toEqual([]);
  });

  const KEY = "sk-test-0123456789abcdef";
  const scriptedFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, deps: { fetch: fake } };
  };
  const apis = [
    {
      kind: "anthropic" as const,
      url: "https://api.anthropic.com/v1/messages",
      header: "x-api-key",
      value: KEY,
      model: "claude-haiku-5-5",
      format: '"type":"json_schema"',
      ok: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(model) }] },
      refusal: { stop_reason: "refusal", content: [] },
    },
    {
      kind: "openai" as const,
      url: "https://api.openai.com/v1/responses",
      header: "authorization",
      value: `Bearer ${KEY}`,
      model: "gpt-6-luna",
      format: '"type":"json_schema"',
      ok: { status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(model) }] }] },
      refusal: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: `no, ${KEY}` }] }] },
    },
    {
      kind: "deepseek" as const,
      url: "https://api.deepseek.com/chat/completions",
      header: "authorization",
      value: `Bearer ${KEY}`,
      model: "deepseek-flash",
      format: '"response_format":{"type":"json_object"}',
      ok: { choices: [{ finish_reason: "stop", message: { role: "assistant", reasoning_content: "", content: JSON.stringify(model) } }] },
      refusal: { choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }] },
    },
  ];

  // protects: an API key travels in one request header and nowhere else, the request asks for
  //   schema-constrained JSON, and a failure is fixed text plus the status number.
  // fails_when: the key is put in the URL or the body, the structured-output field is dropped, or the
  //   response body or the key is copied into the thrown message.
  // seam: deps.fetch.
  it.each(apis)("calls the $kind API with the key in a header only", async (api) => {
    const good = scriptedFetch(200, api.ok);
    expect(await extractWithLlm(keyCandidate(api.kind, KEY), crawl, good.deps)).toEqual(model);
    const { url, init } = good.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(url).toBe(api.url);
    expect(headers[api.header]).toBe(api.value);
    expect(JSON.stringify(headers).split(KEY)).toHaveLength(2);
    expect(body).not.toContain(KEY);
    expect(body).toContain("Balayage $91+");
    expect(JSON.parse(body).model).toBe(api.model);
    expect(body).toContain(api.format);
    expect(body).toContain("price_kind"); // the schema reaches every provider, in the format field or the prompt
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("error");

    const denied = scriptedFetch(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
    const failure = await extractWithLlm(keyCandidate(api.kind, KEY), crawl, denied.deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("The API key was not accepted (HTTP 401).");
    expect(String((failure as Error).stack)).not.toContain(KEY);

    await expect(extractWithLlm(keyCandidate(api.kind, KEY), crawl, scriptedFetch(500, "upstream exploded").deps)).rejects.toThrow(new Error("The API returned an error (HTTP 500)."));
    await expect(extractWithLlm(keyCandidate(api.kind, KEY), crawl, scriptedFetch(402, {}).deps)).rejects.toThrow(new Error("The API account is rate limited or out of credit (HTTP 402)."));
    await expect(extractWithLlm(keyCandidate(api.kind, KEY), crawl, scriptedFetch(200, api.refusal).deps)).rejects.toThrow(new Error(LLM_ERRORS.refused));
    const offline = { fetch: (async () => Promise.reject(new TypeError(`fetch failed for ${KEY}`))) as typeof fetch };
    await expect(extractWithLlm(keyCandidate(api.kind, KEY), crawl, offline)).rejects.toThrow(new Error(LLM_ERRORS.unreachable));

    const unsent = scriptedFetch(200, api.ok);
    await expect(extractWithLlm(keyCandidate(api.kind, "bad key\r\nx-injected: 1"), crawl, unsent.deps)).rejects.toThrow(new Error(LLM_ERRORS.key));
    expect(unsent.calls).toEqual([]);
  });

  // protects: DeepSeek's JSON mode is not schema-checked, so an empty, cut-off or interrupted reply is reported, not parsed.
  // fails_when: an empty `content` or a finish_reason other than "stop" reaches the JSON parser or buildProfile.
  // seam: deps.fetch.
  it("rejects an empty or cut-off DeepSeek answer", async () => {
    const reply = (finish_reason: string, content: string) => scriptedFetch(200, { choices: [{ finish_reason, message: { content } }] }).deps;
    for (const deps of [
      reply("stop", ""),
      reply("length", '{"business":'),
      reply("insufficient_system_resource", JSON.stringify(model)),
      scriptedFetch(200, {}).deps,
    ]) {
      await expect(extractWithLlm(keyCandidate("deepseek", KEY), crawl, deps)).rejects.toThrow(new Error(LLM_ERRORS.badAnswer));
    }
  });
});
