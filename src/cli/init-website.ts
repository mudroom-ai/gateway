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
export const PROVIDER_QUESTION = "Fill in the rest with";
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
  const crawlOnly: SiteProfile = { ...(vendor ? { vendor } : {}), bookable: [], ask: [] };
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
  log("\nTo fill in the rest, the text of those public pages is sent to the provider you choose below.");
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

  const found: string[] = [];
  if (profile.name) found.push(`  Name: ${cleanLine(profile.name, 80)}`);
  if (profile.timezone) found.push(`  Time zone: ${cleanLine(profile.timezone, 64)}`);
  if (profile.currency) found.push(`  Currency: ${cleanLine(profile.currency, 3)}`);
  if (profile.hours) found.push(`  Hours: ${cleanLine(profile.hours, 200)}`);
  if (profile.bookable.length || profile.ask.length) found.push(`  Services: ${profile.bookable.length} with one fixed price, ${profile.ask.length} without`);
  if (found.length) log(`\n${style.question("Found on your site")}\n${found.join("\n")}\n${style.dim("Each is offered as a default below: Enter keeps it, typing replaces it.")}`);
  else log(`\nNothing usable was found on your site. ${WEBSITE_NOTES.carryOn}`);
  return profile;
}
