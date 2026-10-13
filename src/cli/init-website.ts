// The init wizard's website step, asked once on a first run: the merchant gives
// their website, the wizard reads a few of its public pages (website.ts), has
// the merchant's own model fill in a profile (profile.ts) and hands that profile
// back. Kept out of init.ts like the owner-channel step.
//
// Nothing here writes a file. The profile only supplies defaults for the
// questions init.ts asks next, and a pasted API key lives in one local variable
// for one request: it is never logged, put in an error or saved.

import type { Prompter } from "./init.js";
import { style, type PickItem } from "./picker.js";
import { LLM_ERRORS, LLM_TIMEOUT_MS, buildProfile, cleanLine, detectLlm, extractWithLlm, keyCandidate, type LlmCandidate, type LlmKind, type SiteProfile } from "./profile.js";
import { CRAWL_ERRORS, MAX_PAGES, crawlSite, normalizeWebsiteUrl, type CrawlResult } from "./website.js";

/** The parts a test replaces, so no test reads the network or starts a process. */
export interface WebsiteDeps {
  crawl?: typeof crawlSite | undefined;
  detect?: typeof detectLlm | undefined;
  extract?: typeof extractWithLlm | undefined;
}

export const WEBSITE_QUESTION = "Your website (Enter to skip)";
export const PROVIDER_QUESTION = "Read the pages with";
export const PASTE_KEY_LABEL = "Paste an API key";
export const SKIP_LABEL = "Skip";
/** Printed when a failure carries no message of its own that is known to be safe to show. */
export const WEBSITE_NOTES = {
  crawl: "The website could not be read.",
  llm: "The model could not read the site.",
  carryOn: "Carrying on without it: answer the questions below yourself.",
} as const;

/** Where the page text goes, by candidate kind: the name used in the "sending" line. */
const PROVIDER: Record<LlmKind, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", anthropic: "Anthropic", openai: "OpenAI" };
const KEY_KINDS = [
  { kind: "anthropic", label: "Anthropic" },
  { kind: "openai", label: "OpenAI" },
] as const;
/** Booking systems the gateway connects to: the platform supplies the catalog, so reading the site adds little. */
const STORE_VENDORS = new Set(["square", "glossgenius"]);

/** How many left-out product names the summary shows before "and N more". */
const PRODUCTS_SHOWN = 3;

/** The summary's services line: how many the site lists with a fixed price (offered as bookable) and without. */
function servicesFound(fixed: number, other: number): string {
  if (!fixed) return `${other} listed, none with a fixed price`;
  return `${fixed} with a fixed price${other ? `, ${other} without` : ""}`;
}

/** "name", "name and currency", "name, time zone and currency". */
const listed = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? ""));

const FIXED_NOTES = new Set<unknown>([...Object.values(CRAWL_ERRORS), ...Object.values(LLM_ERRORS)]);
const HTTP_NOTE = /^The API [A-Za-z ]{1,60} \(HTTP \d{1,3}\)\.$/;
/** The error's own message when it is one of the fixed sentences website.ts and profile.ts reject with; anything else could hold a URL, a key or a child's output, so `fallback` is printed instead. */
function fixedNote(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : "";
  return FIXED_NOTES.has(message) || HTTP_NOTE.test(message) ? message : fallback;
}

/**
 * Ask for the website, read it and return what was found. Resolves undefined
 * when the question was skipped or the site could not be read, and a profile
 * holding only the detected booking system when no model read the pages. No
 * crawl or model failure makes it reject; only the prompter can (Ctrl+C).
 */
export async function askWebsite(
  p: Prompter,
  ctx: {
    /** --website: pre-answers the question. */
    flag: string | undefined;
    env: NodeJS.ProcessEnv;
    log: (m: string) => void;
    /** Answers already given as flags: the summary does not offer the site's value for these. */
    given?: { name?: string | undefined; timezone?: string | undefined; currency?: string | undefined; hours?: string | undefined } | undefined;
    /** True when the wizard's hours parser and the config schema both accept the spec. */
    validHours: (spec: string) => boolean;
    /** Env names kept away from a model CLI: the gateway's own secrets. */
    secretKeys: readonly string[];
    deps?: WebsiteDeps | undefined;
  },
): Promise<SiteProfile | undefined> {
  const { log } = ctx;
  let start: URL | undefined;
  if (ctx.flag !== undefined) {
    if (!ctx.flag.trim()) return undefined;
    try {
      start = normalizeWebsiteUrl(ctx.flag);
    } catch (e) {
      log(`--website: ${(e as Error).message} ${WEBSITE_NOTES.carryOn}`);
      return undefined;
    }
  } else {
    log(style.dim("Optional: the wizard can read your public website and offer what it finds as the answers below."));
    while (!start) {
      const answer = (await p.ask(WEBSITE_QUESTION)).trim();
      if (!answer) return undefined;
      try {
        start = normalizeWebsiteUrl(answer);
      } catch (e) {
        log(`  ${(e as Error).message}`);
      }
    }
  }

  // The host as typed: a redirect target is never printed.
  log(`Reading ${cleanLine(start.hostname, 80)} (up to ${MAX_PAGES} pages, a minute at most) ...`);
  let crawl: CrawlResult;
  try {
    crawl = await (ctx.deps?.crawl ?? crawlSite)(start);
  } catch (e) {
    log(`${fixedNote(e, WEBSITE_NOTES.crawl)} ${WEBSITE_NOTES.carryOn}`);
    return undefined;
  }
  const vendor = crawl.vendor;
  const vendorLabel = vendor ? cleanLine(vendor.label, 40) : "";
  log(`Read ${crawl.pages.length} page${crawl.pages.length === 1 ? "" : "s"}.${vendor ? ` Booking system found: ${vendorLabel}.` : ""}`);
  /** What the crawl gives without a model: the booking system, which init.ts uses to pre-select its picker. */
  const crawlOnly: SiteProfile = { ...(vendor ? { vendor } : {}), bookable: [], ask: [], products: [], shop: false };
  if (!crawl.pages.some((page) => page.text.trim()) && !crawl.jsonLd.length) {
    log(`The pages had no text to read (the site may be drawn by JavaScript). ${WEBSITE_NOTES.carryOn}`);
    return crawlOnly;
  }

  let candidates: LlmCandidate[] = [];
  try {
    candidates = (ctx.deps?.detect ?? detectLlm)(ctx.env);
  } catch {
    // Nothing detected: the picker still offers a pasted key.
  }
  const store = !!vendor && STORE_VENDORS.has(vendor.kind);
  log("\nTo turn them into answers, the text of those public pages is sent to the provider you choose below.");
  log("Gateway saves nothing from this step; what comes back only becomes the default answer to the questions that follow.");
  if (store) log(style.dim(`${vendorLabel} supplies your services and hours, so this would only fill in your name, time zone and currency.`));
  const items: PickItem[] = [
    ...candidates.map((c) => ({ emoji: "🤖", label: c.label, status: c.status })),
    { emoji: "🔑", label: PASTE_KEY_LABEL },
    { emoji: "⏭", label: SKIP_LABEL },
  ];
  const skipAt = items.length - 1;
  // ESC backs out: it answers Skip, never the pre-selected provider, so the page text is only sent on an explicit pick.
  const choice = await p.choose(PROVIDER_QUESTION, items, candidates.length && !store ? 0 : skipAt, undefined, skipAt);
  if (choice === skipAt) return crawlOnly;
  let candidate = candidates[choice];
  if (!candidate) {
    const picked = KEY_KINDS[await p.choose("API key from", KEY_KINDS.map((k) => ({ label: k.label })))]!;
    log(style.dim("The key is used for this one request. It is not shown, logged or saved."));
    const key = await p.secret(`${picked.label} API key (hidden; Enter to skip)`);
    if (!key.trim()) {
      log(`No key entered. ${WEBSITE_NOTES.carryOn}`);
      return crawlOnly;
    }
    candidate = keyCandidate(picked.kind, key);
  }

  log(`Sending the page text to ${PROVIDER[candidate.kind]} (up to ${Math.round(LLM_TIMEOUT_MS / 60_000)} minutes) ...`);
  let profile: SiteProfile;
  try {
    const raw = await (ctx.deps?.extract ?? extractWithLlm)(candidate, crawl, { env: ctx.env, secretKeys: ctx.secretKeys });
    profile = buildProfile(crawl, raw, ctx.validHours);
  } catch (e) {
    log(`${fixedNote(e, WEBSITE_NOTES.llm)} ${WEBSITE_NOTES.carryOn}`);
    return crawlOnly;
  }

  const given = ctx.given ?? {};
  const found: string[] = [];
  if (profile.name) found.push(`  Name: ${cleanLine(profile.name, 80)}`);
  if (profile.timezone) found.push(`  Time zone: ${cleanLine(profile.timezone, 64)}`);
  if (profile.currency) found.push(`  Currency: ${cleanLine(profile.currency, 3)}`);
  if (profile.hours) found.push(`  Hours: ${cleanLine(profile.hours, 200)}`);
  // A price written in a currency the flag overrides is offered as ask-the-owner, not as a fixed price.
  const kept = profile.bookable.filter((b) => !b.price_currency || !given.currency || b.price_currency === given.currency.trim().toUpperCase()).length;
  const [fixed, other] = [kept, profile.ask.length + profile.bookable.length - kept];
  if (fixed || other) found.push(`  Services: ${servicesFound(fixed, other)}`);
  if (profile.products.length) {
    const names = profile.products.slice(0, PRODUCTS_SHOWN).map((n) => cleanLine(n, 40));
    const more = profile.products.length - names.length;
    found.push(`  Products: ${profile.products.length} left out (${names.join(", ")}${more ? ` and ${more} more` : ""})`);
  }
  if (!found.length) {
    log(`\nNothing usable was found on your site${profile.shop ? " (it looks like an online shop)" : ""}. ${WEBSITE_NOTES.carryOn}`);
    return profile;
  }
  // What the summary promises is what the questions below do: a default for each of these, one yes or no for
  // the services without a fixed price. A connected booking platform supplies hours and services itself.
  const defaults = [
    profile.name && given.name === undefined && "name",
    profile.timezone && given.timezone === undefined && "time zone",
    profile.currency && given.currency === undefined && "currency",
    !store && profile.hours && given.hours === undefined && "hours",
    !store && fixed > 0 && "fixed-price services",
  ].filter(
    (d): d is string => !!d,
  );
  const notes: string[] = [];
  if (profile.products.length) {
    notes.push(profile.shop && !fixed && !other ? "This looks like an online shop. Gateway books appointments, so its products were not added." : "Gateway books appointments, so products for sale were not added.");
  }
  if (defaults.length) notes.push(`Offered as ${defaults.length === 1 ? "a default" : "defaults"} below: ${listed(defaults)}. Enter keeps ${defaults.length === 1 ? "it" : "one"}, typing replaces it.`);
  if (other && !store) notes.push("Services without a fixed price are shown for a yes or no: agents can ask you about them but not book them.");
  log(`\n${style.question("Found on your site")}\n${found.join("\n")}\n${notes.map((n) => style.dim(n)).join("\n")}`);
  return profile;
}
