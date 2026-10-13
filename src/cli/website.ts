// The init wizard's website crawl. Reads the merchant's own public site over
// plain HTTP (GET only, no browser): the start page plus a few same-host pages
// picked by link keywords. Returns each page's visible text, the site's
// schema.org JSON-LD and a booking-vendor fingerprint, which profile.ts turns
// into prompt defaults.
//
// The address comes from a prompt and the pages from the open web, so:
// - every hop (the start URL and each redirect) must be http(s), carry no
//   userinfo and name a public host;
// - the default transport resolves the host itself and hands the socket only
//   addresses that passed the block list, so the address that was checked is
//   the one connected to (a check-then-fetch guard is open to DNS rebinding);
// - HTML is read by linear scans, never a regex that can backtrack across the
//   whole page;
// - every Error thrown here has a fixed message: no response body, no redirect
//   target, no resolver or socket error text.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export const MAX_PAGES = 8;
export const PAGE_TIMEOUT_MS = 15_000;
export const PAGE_MAX_BYTES = 2_000_000;
export const CRAWL_DEADLINE_MS = 60_000;
export const PAGE_TEXT_MAX_CHARS = 12_000;
export const JSONLD_MAX_CHARS = 20_000;
export const MAX_REDIRECTS = 5;
/** Pages that fail are skipped, so the number of pages tried is bounded separately. */
const MAX_ATTEMPTS = MAX_PAGES * 2;
const MAX_LINKS_PER_PAGE = 2_000;
const MAX_CANDIDATES = 300;
const TITLE_MAX_CHARS = 200;
const LINK_TEXT_MAX_CHARS = 80;
const USER_AGENT = "gateway-init (one-time setup read of this site's public pages; +https://github.com/mudroom-ai/gateway)";

export interface CrawlPage {
  /** Final URL after redirects. */
  url: string;
  title: string;
  /** Visible text: entities decoded, one line per block element, spaces collapsed, capped. */
  text: string;
}

/** The booking system a site links to. `kind` is a slug: "square", "glossgenius", "mangomint", ... */
export interface SiteVendor {
  kind: string;
  label: string;
  /** GlossGenius only: the merchant's https://<name>.glossgenius.com booking page. */
  url?: string | undefined;
}

export interface CrawlResult {
  /** Final start URL after redirects; its host is the crawl host. */
  url: string;
  /** 1..MAX_PAGES, start page first. */
  pages: CrawlPage[];
  /** Each schema.org JSON-LD block as compact JSON text, deduplicated, capped in total. */
  jsonLd: string[];
  vendor?: SiteVendor | undefined;
}

/** One hop: never follows a redirect, and rejects for a blocked address. */
export type HttpGet = (url: URL, o: { timeoutMs: number; maxBytes: number }) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

/** Every message crawlSite and the default transport can reject with. */
export const CRAWL_ERRORS = {
  blocked: "That address is not a public website.",
  timeout: "The website did not respond in time.",
  unreachable: "The website could not be reached.",
  redirects: "The website redirected too many times.",
  status: "The website returned an error instead of a page.",
  notHtml: "That address did not return a web page.",
} as const;

class CrawlError extends Error {}

// ---- addresses ----

// Two lists, because BlockList checks an IPv4 address against IPv6 rules as its
// IPv4-mapped form: the "::ffff:0:0/96" row in a shared list would refuse all of IPv4.
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // unspecified, "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // Teredo, ORCHID, benchmarking
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, "ipv6");
}
/** Global unicast. An IPv6 address outside it is refused whether or not a row above names it. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

/**
 * True for an IP address on the public internet. False for loopback, private,
 * link-local, CGNAT, unique-local, NAT64, 6to4, multicast, documentation and
 * reserved ranges, for every IPv4-mapped IPv6 address, and for anything that
 * is not an IP address.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !BLOCKED_V4.check(ip, "ipv4");
  if (family === 6) return !ip.includes("%") && GLOBAL_V6.check(ip, "ipv6") && !BLOCKED_V6.check(ip, "ipv6");
  return false;
}

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;

/** Throws unless the URL is http(s), has no userinfo and names a host that may be public. */
function assertPublicUrl(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  const ok =
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    host !== "" &&
    !LOCAL_NAME.test(host) &&
    (isIP(literal) === 0 || isPublicAddress(literal));
  if (!ok) throw new CrawlError(CRAWL_ERRORS.blocked);
}

type ResolveAll = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/**
 * A `lookup` for http.request that resolves the host and keeps only public
 * addresses, so the socket can connect to nothing else. Node asks for every
 * address (`all: true`) when autoSelectFamily is on and for one otherwise;
 * both callback forms are answered. `resolve` is a test seam.
 */
export function guardedLookup(resolve: ResolveAll = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      const open = err ? [] : addresses.filter((a) => isPublicAddress(a.address));
      const first = open[0];
      if (!first) {
        callback(new CrawlError(err ? CRAWL_ERRORS.unreachable : CRAWL_ERRORS.blocked), options.all ? [] : "", 0);
      } else if (options.all) {
        callback(null, open);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

// ---- transport ----

/**
 * The real transport: one GET, no redirect following. The body is cut at
 * `maxBytes` (the socket is destroyed there) and `timeoutMs` covers the whole
 * exchange, body included. A redirect resolves without its body.
 */
export const defaultHttpGet: HttpGet = (url, o) =>
  new Promise((resolve, reject) => {
    let req: http.ClientRequest | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
      req?.destroy();
    };
    const fail = (e: unknown) => settle(() => reject(e instanceof CrawlError ? e : new CrawlError(CRAWL_ERRORS.unreachable)));

    try {
      assertPublicUrl(url);
      req = (url.protocol === "https:" ? https : http).request(url, {
        method: "GET",
        agent: false,
        lookup: guardedLookup(),
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
      });
    } catch (e) {
      fail(e);
      return;
    }
    timer = setTimeout(() => fail(new CrawlError(CRAWL_ERRORS.timeout)), o.timeoutMs);
    req.on("error", fail);
    // Second check on the connected socket: no response is read from an address the block list refuses.
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        if (!isPublicAddress(socket.remoteAddress ?? "")) fail(new CrawlError(CRAWL_ERRORS.blocked));
      });
    });
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => settle(() => resolve({ status, headers, body: Buffer.concat(chunks) }));
      if (status >= 300 && status < 400) {
        done();
        return;
      }
      res.on("data", (chunk: Buffer) => {
        const room = o.maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (size >= o.maxBytes) done();
      });
      res.on("end", done);
      res.on("error", fail);
      res.on("close", fail);
    });
    req.end();
  });

// ---- HTML ----

const ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["bull", "\u2022"],
  ["middot", "\u00b7"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["deg", "\u00b0"],
  ["frac12", "\u00bd"],
  ["times", "\u00d7"],
  ["laquo", "\u00ab"],
  ["raquo", "\u00bb"],
  ["larr", "\u2190"],
  ["rarr", "\u2192"],
  ["prime", "\u2032"],
  ["frac14", "\u00bc"],
  ["frac34", "\u00be"],
  ["ensp", " "],
  ["emsp", " "],
  ["thinsp", " "],
  ["shy", ""],
  ["agrave", "\u00e0"],
  ["ccedil", "\u00e7"],
  ["egrave", "\u00e8"],
  ["eacute", "\u00e9"],
  ["ntilde", "\u00f1"],
  ["ouml", "\u00f6"],
  ["uuml", "\u00fc"],
  ["dollar", "$"],
  ["cent", "\u00a2"],
  ["pound", "\u00a3"],
  ["euro", "\u20ac"],
  ["yen", "\u00a5"],
]);

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". Unknown names are left as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (whole, body: string) => {
    if (!body.startsWith("#")) return ENTITIES.get(body) ?? ENTITIES.get(body.toLowerCase()) ?? whole;
    const cp = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : " ";
  });
}

/** Entities decoded, control and invisible characters removed, spaces collapsed, at most one newline between lines. */
function tidy(s: string): string {
  return decodeEntities(s)
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\n ]*/g, "\n")
    .trim();
}

const oneLine = (s: string) => tidy(s).replace(/\n/g, " ");

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max).trimEnd();
}

/** Elements whose content is not page text: skipped up to their closing tag. */
const RAW_CLOSE = new Map(["script", "style", "svg", "noscript", "template", "title"].map((t) => [t, new RegExp(`</${t}\\b[^>]{0,100}>`, "gi")]));
/** Elements that start a new line of text. */
const BLOCK = new Set(
  "address article aside blockquote br dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol option p pre section table tr ul".split(" "),
);
const TAG_OPEN = /<(\/?)([a-z][a-z0-9:-]*)/iy;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

interface ParsedHtml {
  title: string;
  text: string;
  links: { href: string; label: string }[];
  jsonLd: string[];
}

/**
 * Title, visible text, links and JSON-LD from one page, in a single forward
 * scan. Not a DOM: a ">" inside an attribute value ends the tag early, and
 * hidden elements count as visible. A block that never closes (a page cut at
 * the byte cap) ends the scan.
 */
export function parseHtml(html: string): ParsedHtml {
  const out: string[] = [];
  const links: ParsedHtml["links"] = [];
  const jsonLd: string[] = [];
  let title = "";
  let link: { href: string; at: number } | undefined;
  const endLink = () => {
    if (link && links.length < MAX_LINKS_PER_PAGE) links.push({ href: link.href, label: cap(oneLine(out.slice(link.at).join("")), LINK_TEXT_MAX_CHARS) });
    link = undefined;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    TAG_OPEN.lastIndex = lt;
    const tag = TAG_OPEN.exec(html);
    const next = html[lt + 1];
    if (!tag && next !== "!" && next !== "?") {
      out.push("<"); // a literal "<" in text
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    i = gt + 1;
    if (!tag) continue; // doctype or processing instruction
    const name = tag[2]!.toLowerCase();
    const closing = tag[1] === "/";
    const attrs = html.slice(lt + tag[0].length, gt);

    const close = closing || attrs.endsWith("/") ? undefined : RAW_CLOSE.get(name);
    if (close) {
      close.lastIndex = i;
      const end = close.exec(html);
      const body = html.slice(i, end ? end.index : html.length);
      if (name === "title") title ||= cap(oneLine(body), TITLE_MAX_CHARS);
      if (name === "script" && /application\/ld\+json/i.test(attrs)) jsonLd.push(body);
      if (!end) break;
      i = close.lastIndex;
      out.push(" ");
      continue;
    }
    if (name === "a") {
      endLink();
      const href = closing ? null : HREF.exec(attrs);
      if (href) link = { href: decodeEntities(href[1] ?? href[2] ?? href[3] ?? "").trim(), at: out.length };
    }
    out.push(BLOCK.has(name) ? "\n" : " ");
  }
  endLink();
  return { title, text: cap(tidy(out.join("")), PAGE_TEXT_MAX_CHARS), links, jsonLd };
}

/** A JSON-LD block parsed and re-serialised without whitespace; undefined when it is not a JSON object or array. */
function compactJson(body: string): string | undefined {
  if (body.length > JSONLD_MAX_CHARS * 4) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    return v !== null && typeof v === "object" ? JSON.stringify(v) : undefined;
  } catch {
    return undefined;
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  const label =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]{0,200}charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1];
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // unknown charset label: read as UTF-8
    }
  }
  return body.toString("utf8");
}

// ---- vendor fingerprint ----

interface VendorRule {
  kind: string;
  label: string;
  /** Host or host/path fragments (matched on a host-label boundary), or a pattern, that only this system's booking pages use. */
  urls: readonly (string | RegExp)[];
  /** Optional capture of the merchant's own booking page; group 1 is its host label. */
  page?: { pattern: RegExp; url: (name: string) => string } | undefined;
}

// Recognised by a URL fragment anywhere in a page's raw HTML, inline scripts
// included, because the booking link is often only in a script's settings.
// The first row that matches wins, so the systems the gateway connects to come
// first. To add one: a slug, a display name, and fragments that appear only in
// its booking links (never a payment, analytics or marketing script).
const VENDORS: readonly VendorRule[] = [
  {
    kind: "square",
    label: "Square Appointments",
    // Appointments URLs only: js.squareup.com, web.squarecdn.com and connect.squareup.com are payments.
    urls: ["book.squareup.com", "squareup.com/appointments", /(?<![a-z0-9-])square\.site\/(?:[^\s"'<>\\]{0,200}?[/?=_-])?(?:book(?:ings?)?|appointments?)(?![a-z])/i],
  },
  {
    kind: "glossgenius",
    label: "GlossGenius",
    urls: ["glossgenius.com"],
    page: {
      pattern: /https?:\/\/(?!(?:www|api|app|cdn|help|blog|support|static|assets|images)\.)([a-z0-9][a-z0-9-]{0,62})\.glossgenius\.com(?![a-z0-9-])/i,
      url: (name) => `https://${name.toLowerCase()}.glossgenius.com`,
    },
  },
  { kind: "calendly", label: "Calendly", urls: ["calendly.com"] },
  { kind: "acuity", label: "Acuity Scheduling", urls: ["acuityscheduling.com", "squarespacescheduling.com", /(?<![a-z0-9-])[a-z0-9-]+\.as\.me(?![a-z0-9.-])/i] },
  { kind: "vagaro", label: "Vagaro", urls: ["vagaro.com"] },
  { kind: "booksy", label: "Booksy", urls: ["booksy.com"] },
  { kind: "fresha", label: "Fresha", urls: ["fresha.com"] },
  { kind: "styleseat", label: "StyleSeat", urls: ["styleseat.com"] },
  { kind: "schedulicity", label: "Schedulicity", urls: ["schedulicity.com"] },
  { kind: "boulevard", label: "Boulevard", urls: ["joinblvd.com", "blvd.co", "boulevard.io"] },
  { kind: "mangomint", label: "Mangomint", urls: ["mangomint.com"] },
  { kind: "booker", label: "Booker", urls: ["booker.com", "secure-booker.com"] },
  { kind: "mindbody", label: "Mindbody", urls: ["mindbodyonline.com", "mindbody.io", "healcode.com"] },
  { kind: "momence", label: "Momence", urls: ["momence.com"] },
  { kind: "jobber", label: "Jobber", urls: ["getjobber.com"] },
  { kind: "housecallpro", label: "Housecall Pro", urls: ["housecallpro.com"] },
  { kind: "servicetitan", label: "ServiceTitan", urls: ["servicetitan.com"] },
  { kind: "phorest", label: "Phorest", urls: ["phorest.com"] },
  { kind: "zenoti", label: "Zenoti", urls: ["zenoti.com"] },
  { kind: "wellnessliving", label: "WellnessLiving", urls: ["wellnessliving.com"] },
  { kind: "setmore", label: "Setmore", urls: ["setmore.com"] },
  { kind: "moego", label: "MoeGo", urls: ["moego.pet"] },
  { kind: "opentable", label: "OpenTable", urls: ["opentable.com"] },
  { kind: "resy", label: "Resy", urls: ["resy.com"] },
];

const VENDOR_PATTERNS: readonly (readonly RegExp[])[] = VENDORS.map((v) =>
  v.urls.map((u) => (typeof u === "string" ? new RegExp(`(?<![a-z0-9-])${u.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![a-z0-9-])`, "i") : u)),
);

interface VendorHit {
  rank: number;
  vendor: SiteVendor;
}

/** The first vendor row found in `raw` (HTML or a URL). JSON-escaped slashes are unescaped first. */
function fingerprint(raw: string): VendorHit | undefined {
  const s = raw.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  for (const [rank, rule] of VENDORS.entries()) {
    if (!VENDOR_PATTERNS[rank]!.some((re) => re.test(s))) continue;
    const name = rule.page?.pattern.exec(s)?.[1];
    return { rank, vendor: { kind: rule.kind, label: rule.label, ...(rule.page && name ? { url: rule.page.url(name) } : {}) } };
  }
  return undefined;
}

/** The earlier table row wins; the same row seen again may supply the URL the first sighting lacked. */
function betterVendor(a: VendorHit | undefined, b: VendorHit | undefined): VendorHit | undefined {
  if (!a || !b) return a ?? b;
  if (b.rank < a.rank) return b;
  return b.rank === a.rank && !a.vendor.url && b.vendor.url ? b : a;
}

// ---- page selection ----

// What a link's path and text say about the page behind it. A link scores the
// sum of its keywords, each halved for every page already read that had it
// (so one "services" page does not crowd out hours and contact), minus its
// path depth. A link with no keyword is never followed.
const WANT: readonly (readonly [RegExp, number])[] = [
  [/\bservic/, 6],
  [/\bpric|\brates?\b|\bfees?\b/, 6],
  [/\bmenu/, 6],
  [/\bbook/, 5], // word start, so "facebook" is not "book"
  [/\bappoint/, 5],
  [/\bschedul/, 5],
  [/\btreatment/, 5],
  [/\bclass(?:es)?\b/, 5],
  [/\bhours\b/, 4],
  [/\bcontact/, 4],
  [/\blocation|\bvisit\b/, 4],
  [/\bmember|\bpackage/, 4],
  [/\bfaqs?\b/, 3],
  [/\babout/, 3],
  [/\bpolic/, 3],
  [/\border/, 3],
  [/\bquot/, 3],
  [/\bestimat/, 3],
  [/\binquir|\benquir/, 3],
];
const SKIP_PATH =
  /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|css|js|json|xml|txt|mp[34]|mov|webm|woff2?|ttf|zip|docx?|xlsx?)$|\/(?:blog|news|press|tags?|categor(?:y|ies)|author|cart|checkout|basket|account|my-account|log-?in|sign-?in|wp-json|wp-admin|wp-login\.php|feed|rss|search|cdn-cgi)(?:\/|$)/i;
/** Legal boilerplate, by path or link text. "cookie" alone is a bakery's product, so it needs a second word. */
const SKIP_LEGAL = /\b(?:privacy|terms|disclaimer|gdpr|accessibility|sitemap|cookies? (?:policy|notice|settings|preferences|consent))\b/;

interface Candidate {
  url: URL;
  hits: Set<number>;
  depth: number;
}

const siteOf = (url: URL) => url.host.replace(/^www\./, "");
const pageKey = (url: URL) => `${siteOf(url)}${url.pathname.replace(/\/+$/, "")}${url.search}`;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");

function scoreOf(c: Candidate, covered: ReadonlyMap<number, number>): number {
  let score = -c.depth;
  for (const k of c.hits) score += WANT[k]![1] / 2 ** (covered.get(k) ?? 0);
  return score;
}

// ---- crawl ----

type Fetched = { url: URL; html: string } | { left: URL };

const header = (headers: Record<string, string>, name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";

/**
 * One page, redirects followed by hand: each hop is checked like the start
 * URL. With `stay`, a redirect that leaves the site is not followed and comes
 * back as `{ left }`.
 */
async function fetchPage(get: HttpGet, start: URL, deadline: number, stay?: ((url: URL) => boolean) | undefined): Promise<Fetched> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrl(url);
    const left = deadline - Date.now();
    if (left <= 0) throw new CrawlError(CRAWL_ERRORS.timeout);
    let res: Awaited<ReturnType<HttpGet>>;
    try {
      res = await get(url, { timeoutMs: Math.min(PAGE_TIMEOUT_MS, left), maxBytes: PAGE_MAX_BYTES });
    } catch (e) {
      throw e instanceof CrawlError ? e : new CrawlError(CRAWL_ERRORS.unreachable);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = header(res.headers, "location").trim();
      let next: URL;
      try {
        if (!location) throw new Error("redirect without a Location");
        next = new URL(location, url);
      } catch {
        throw new CrawlError(CRAWL_ERRORS.status);
      }
      next.hash = "";
      if (stay && !stay(next)) return { left: next };
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new CrawlError(CRAWL_ERRORS.status);
    const type = header(res.headers, "content-type");
    const encoding = header(res.headers, "content-encoding").trim().toLowerCase();
    // The request asked for identity; a server that compresses anyway is treated as unreadable (nothing is decompressed here).
    if (!/html/i.test(type) || (encoding !== "" && encoding !== "identity")) throw new CrawlError(CRAWL_ERRORS.notHtml);
    return { url, html: decodeBody(res.body.subarray(0, PAGE_MAX_BYTES), type) };
  }
  throw new CrawlError(CRAWL_ERRORS.redirects);
}

/**
 * Crawl a merchant's site: the start page, then up to seven more pages on the
 * same host. A page that fails is skipped; only a start page that cannot be
 * read rejects, with one of CRAWL_ERRORS as the whole message. `start` should
 * come from normalizeWebsiteUrl.
 */
export async function crawlSite(start: URL, deps: { httpGet?: HttpGet | undefined } = {}): Promise<CrawlResult> {
  const get = deps.httpGet ?? defaultHttpGet;
  const deadline = Date.now() + CRAWL_DEADLINE_MS;

  const first = await fetchPage(get, start, deadline);
  if ("left" in first) throw new CrawlError(CRAWL_ERRORS.unreachable); // cannot happen: the start page may change host
  const site = siteOf(first.url);
  const onSite = (url: URL) => siteOf(url) === site;

  const pages: CrawlPage[] = [];
  const jsonLd: string[] = [];
  let jsonLdChars = 0;
  let vendor: VendorHit | undefined;
  const seen = new Set([pageKey(start), pageKey(first.url)]);
  const candidates = new Map<string, Candidate>();
  const covered = new Map<number, number>();

  const read = (page: { url: URL; html: string }, hits: ReadonlySet<number>): void => {
    vendor = betterVendor(vendor, fingerprint(`${page.url.href}\n${page.html}`));
    const parsed = parseHtml(page.html);
    if (!parsed.text && pages.length > 0) return;
    pages.push({ url: page.url.href, title: parsed.title, text: parsed.text });
    for (const k of hits) covered.set(k, (covered.get(k) ?? 0) + 1);
    for (const block of parsed.jsonLd) {
      const json = compactJson(block);
      if (!json || jsonLd.includes(json) || jsonLdChars + json.length > JSONLD_MAX_CHARS) continue;
      jsonLd.push(json);
      jsonLdChars += json.length;
    }
    for (const l of parsed.links) {
      let url: URL;
      try {
        url = new URL(l.href, page.url);
      } catch {
        continue;
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !onSite(url)) continue;
      url.hash = "";
      const hay = words(`${url.pathname} ${l.label}`);
      if (SKIP_PATH.test(url.pathname) || SKIP_LEGAL.test(hay)) continue;
      const key = pageKey(url);
      const known = candidates.get(key);
      if (!known && (seen.has(key) || candidates.size >= MAX_CANDIDATES)) continue;
      const c = known ?? { url, hits: new Set<number>(), depth: url.pathname.split("/").filter(Boolean).length };
      for (const [k, [re]] of WANT.entries()) if (re.test(hay)) c.hits.add(k);
      if (c.hits.size > 0) candidates.set(key, c);
    }
  };
  read(first, new Set());

  for (let attempts = 0; pages.length < MAX_PAGES && attempts < MAX_ATTEMPTS && Date.now() < deadline; attempts++) {
    let best: [string, Candidate] | undefined;
    for (const entry of candidates) {
      if (!best || scoreOf(entry[1], covered) > scoreOf(best[1], covered)) best = entry;
    }
    if (!best) break;
    const [key, candidate] = best;
    candidates.delete(key);
    seen.add(key);
    let page: Fetched;
    try {
      page = await fetchPage(get, candidate.url, deadline, onSite);
    } catch {
      continue;
    }
    if ("left" in page) {
      // A "Book" link that redirects to the booking system names the vendor without being read.
      vendor = betterVendor(vendor, fingerprint(page.left.href));
      continue;
    }
    const landed = pageKey(page.url);
    if (landed !== key && seen.has(landed)) continue;
    seen.add(landed);
    candidates.delete(landed);
    read(page, candidate.hits);
  }

  return { url: first.url.href, pages, jsonLd, ...(vendor ? { vendor: vendor.vendor } : {}) };
}

const NOT_A_SITE = "That does not look like a website address. Try something like example.com.";

/** A typed website address as a URL; https:// is assumed when no scheme is given. Throws an Error with a printable message. */
export function normalizeWebsiteUrl(raw: string): URL {
  const s = raw.trim();
  if (!s) throw new Error("Enter a website address, like example.com.");
  if (s.length > 2000) throw new Error(NOT_A_SITE);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new Error(NOT_A_SITE);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// website addresses work here.");
  if (url.username || url.password) throw new Error("Leave the username and password out of the website address.");
  if (!url.hostname.replace(/\.$/, "").includes(".")) throw new Error(NOT_A_SITE);
  url.hash = "";
  return url;
}
