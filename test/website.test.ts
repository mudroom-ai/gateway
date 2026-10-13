// The init wizard's website crawl (src/cli/website.ts) against a scripted
// transport: no network, no DNS. Every site here is synthetic.
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRAWL_ERRORS, crawlSite, defaultHttpGet, guardedLookup, isPublicAddress, normalizeWebsiteUrl, PAGE_TIMEOUT_MS, type HttpGet } from "../src/cli/website.js";

type Scripted = string | { status: number; location?: string; type?: string };

/** A transport that answers from a map of URL -> HTML (or a status/redirect) and records what was asked. */
function scripted(site: Record<string, Scripted>) {
  const calls: string[] = [];
  const timeouts: number[] = [];
  const get: HttpGet = async (url, o) => {
    calls.push(url.href);
    timeouts.push(o.timeoutMs);
    const hit = site[url.href];
    if (hit === undefined) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("not found") };
    if (typeof hit === "string") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(hit) };
    return { status: hit.status, headers: { "content-type": hit.type ?? "text/html", ...(hit.location ? { location: hit.location } : {}) }, body: Buffer.alloc(0) };
  };
  return { get, calls, timeouts };
}

const page = (body: string) => `<!doctype html><html><head><title>Example Studio</title></head><body>${body}</body></html>`;
const crawlOne = (html: string) => crawlSite(new URL("https://example.com/"), { httpGet: scripted({ "https://example.com/": html }).get });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("crawlSite page selection", () => {
  // protects: the crawl reads the start page plus at most seven same-host pages, picks them by link
  //   keywords, spreads them over topics, and never spends a request on legal pages, blogs, carts,
  //   assets, other hosts or a link whose only "book" is inside "Facebook".
  // fails_when: the page limit is dropped, the skip lists stop applying, the keyword match loses its
  //   word boundary, or six /services/* detail pages crowd out contact and about.
  // seam: deps.httpGet.
  it("reads the start page and seven keyword pages, skipping legal, blog, cart, asset and off-site links", async () => {
    const detail = ["cut", "color", "nails", "brows", "lashes", "wax"];
    const home = page(`
      <nav>
        <a href="/services">Services</a>
        ${detail.map((d) => `<a href="/services/${d}">${d}</a>`).join("")}
        <a href="/pricing">Pricing</a>
        <a href="/book-now">Book now</a>
        <a href="http://www.example.com/contact/">Contact</a>
        <a href="/about">About us</a>
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/blog/our-services">Blog</a>
        <a href="/cart">Cart</a>
        <a href="/img/price-menu.png">Price menu</a>
        <a href="/social">Facebook</a>
        <a href="https://other.example.net/services">Our services elsewhere</a>
        <a href="mailto:hello@example.com">Contact by email</a>
      </nav>`);
    const site: Record<string, Scripted> = { "https://example.com/": home, "http://www.example.com/contact/": page("<p>Call +1 202 555 0199</p>") };
    for (const p of ["services", ...detail.map((d) => `services/${d}`), "pricing", "book-now", "about"]) site[`https://example.com/${p}`] = page(`<p>${p}</p>`);
    const t = scripted(site);

    const r = await crawlSite(new URL("https://example.com/"), { httpGet: t.get });

    expect(r.pages).toHaveLength(8); // the start page and seven more, although eleven keyword pages exist
    expect(r.pages[0]!.url).toBe("https://example.com/");
    expect(t.calls).toHaveLength(8);
    for (const wanted of ["services", "pricing", "book-now", "about"]) expect(t.calls).toContain(`https://example.com/${wanted}`);
    expect(t.calls).toContain("http://www.example.com/contact/");
    expect(t.calls.filter((u) => /privacy|terms|blog|cart|\.png|social|example\.net/.test(u))).toEqual([]);
  });

  // protects: a page that fails (404, non-HTML) is skipped without failing the crawl, and the crawl
  //   stops asking once its 60s deadline has passed, handing each request no more than 15s.
  // fails_when: a sub-page error rejects the whole crawl, or requests keep going out after the deadline.
  // seam: deps.httpGet; Date faked by vitest.
  it("skips pages that fail and stops at the whole-crawl deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = scripted({
      "https://example.com/": page('<a href="/services">Services</a><a href="/pricing">Pricing</a><a href="/menu.html">Menu</a><a href="/contact">Contact</a>'),
      "https://example.com/pricing": { status: 200, type: "application/pdf" },
      "https://example.com/menu.html": page("<p>Menu</p>"),
      "https://example.com/contact": page("<p>Contact</p>"),
    });
    const get: HttpGet = async (url, o) => {
      const res = await t.get(url, o);
      if (url.pathname === "/menu.html") vi.advanceTimersByTime(61_000); // this page used up the deadline
      return res;
    };

    const r = await crawlSite(new URL("https://example.com/"), { httpGet: get });

    // /services is a 404 and /pricing is a PDF: both skipped. /contact is never asked for.
    expect(r.pages.map((p) => p.url)).toEqual(["https://example.com/", "https://example.com/menu.html"]);
    expect(t.calls).not.toContain("https://example.com/contact");
    expect(Math.max(...t.timeouts)).toBeLessThanOrEqual(PAGE_TIMEOUT_MS);
  });
});

describe("crawlSite extraction", () => {
  // protects: page text is what a visitor reads (no script, style, svg, noscript, template or comment
  //   content), with entities decoded once, one line per block element and no control characters;
  //   JSON-LD blocks come back as compact JSON, bad or duplicate blocks dropped.
  // fails_when: script text leaks into the page text, "&amp;lt;" is decoded twice, an escape sequence
  //   survives into text that is later printed, or a malformed JSON-LD block throws.
  // seam: deps.httpGet.
  it("returns the title, visible text and compact JSON-LD", async () => {
    const ld = `{\n  "@context": "https://schema.org",\n  "@type": "HairSalon",\n  "name": "Example Studio",\n  "telephone": "+1 202 555 0199"\n}`;
    const html = `<!doctype html><html><head>
      <title>Example  Studio &amp; Spa</title>
      <style>body { color: red }</style>
      <script>var hidden = "<p>not text</p>";</script>
      <script type="application/ld+json">${ld}</script>
      <script type="application/ld+json">${ld}</script>
      <script type="application/ld+json">{ not json </script>
      </head><body>
      <!-- <p>commented out</p> -->
      <h1>Example&nbsp;Studio</h1>
      <ul><li>Haircut   <b>$80</b></li><li>Colour &ndash; from &#36;120 &amp;lt;ask&gt;</li></ul>
      <svg><title>icon</title><path d="M0 0"/></svg><noscript>enable scripts</noscript><template><p>tpl</p></template>
      <p>Kids &lt; 12 &#x1b;[31mfree</p>
      </body></html>`;

    const r = await crawlOne(html);

    expect(r.pages).toEqual([
      { url: "https://example.com/", title: "Example Studio & Spa", text: "Example Studio\nHaircut $80\nColour \u2013 from $120 &lt;ask>\nKids < 12 [31mfree" },
    ]);
    expect(r.jsonLd).toEqual(['{"@context":"https://schema.org","@type":"HairSalon","name":"Example Studio","telephone":"+1 202 555 0199"}']);
  });
});

describe("crawlSite vendor fingerprint", () => {
  const vendorOf = async (html: string) => (await crawlOne(page(html))).vendor;

  // protects: the booking system is recognised from a URL that appears only inside an inline script,
  //   with JSON-escaped slashes, and a GlossGenius booking page comes back as a clean https URL.
  // fails_when: the fingerprint runs over the visible text or the links only, or stops unescaping "\/".
  // seam: deps.httpGet.
  it("finds a vendor that appears only inside an inline script", async () => {
    expect(await vendorOf(String.raw`<p>Welcome</p><script>window.settings = {"bookingUrl":"https:\/\/go.booker.com\/location\/EXAMPLE"};</script>`)).toEqual({
      kind: "booker",
      label: "Booker",
    });
    expect(await vendorOf(String.raw`<script>var widget = {"src":"https:\/\/squareup.com\/appointments\/buyer\/widget\/abc123\/L1.js"};</script>`)).toEqual({
      kind: "square",
      label: "Square Appointments",
    });
    expect(await vendorOf('<a href="https://www.glossgenius.com">Powered by</a><a href="HTTPS://Example-Studio.glossgenius.com/services?x=1">Book</a>')).toEqual({
      kind: "glossgenius",
      label: "GlossGenius",
      url: "https://example-studio.glossgenius.com",
    });
  });

  // protects: Square is reported only for an Appointments booking URL. A site that merely takes card
  //   payments through Square, or links to Facebook, has no booking vendor.
  // fails_when: the Square row matches any squareup.com / squarecdn.com URL, or a vendor pattern loses
  //   its host boundary ("facebooker.com" read as Booker).
  // seam: deps.httpGet.
  it("does not count a Square payment script as a booking vendor", async () => {
    const payments =
      '<script src="https://js.squareup.com/v2/paymentform"></script><script src="https://web.squarecdn.com/v1/square.js"></script>' +
      '<a href="https://connect.squareup.com/v2/payments">Pay</a><a href="https://example.square.site/facebook">Shop</a><a href="https://facebooker.com/example">Facebook</a>';
    expect(await vendorOf(payments)).toBeUndefined();

    for (const url of [
      "https://book.squareup.com/appointments/abc123/location/L1/services",
      "https://squareup.com/appointments/book/abc123/L1/start",
      "https://app.squareup.com/appointments/book/abc123",
      "https://square.site/book/L1/example-studio",
      "https://example.square.site/s/appointments",
    ]) {
      expect(await vendorOf(`${payments}<a href="${url}">Book</a>`), url).toEqual({ kind: "square", label: "Square Appointments" });
    }
  });
});

describe("crawlSite redirects", () => {
  // protects: a redirect is followed by the crawl itself and every hop is vetted, so a public page
  //   cannot bounce the wizard to the cloud metadata address, loopback or a non-http scheme; the
  //   error names no redirect target.
  // fails_when: the rules are applied to the start URL only, or the Location value reaches the message.
  // seam: deps.httpGet (which, like the real transport, never follows a redirect).
  it("refuses a redirect to a blocked address without requesting it", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://localhost:8080/admin", "http://[::1]/", "//printer.local/", "file:///etc/hosts", "https://user:pw@example.org/"]) {
      const t = scripted({ "https://example.com/": { status: 302, location } });
      const err = await crawlSite(new URL("https://example.com/"), { httpGet: t.get }).catch((e: unknown) => e);
      expect(err, location).toBeInstanceOf(Error);
      expect((err as Error).message, location).toBe(CRAWL_ERRORS.blocked);
      expect(t.calls, location).toEqual(["https://example.com/"]);
    }

    // On a later page the same redirect only costs that page.
    const t = scripted({
      "https://example.com/": page('<a href="/services">Services</a><a href="/contact">Contact</a>'),
      "https://example.com/services": { status: 301, location: "http://10.0.0.1/" },
      "https://example.com/contact": page("<p>Contact</p>"),
    });
    const r = await crawlSite(new URL("https://example.com/"), { httpGet: t.get });
    expect(r.pages.map((p) => p.url)).toEqual(["https://example.com/", "https://example.com/contact"]);
    expect(t.calls.some((u) => u.includes("10.0.0.1"))).toBe(false);
  });

  // protects: the start URL's redirects are followed (relative Location resolved against the current
  //   hop) and the final host becomes the crawl host; a redirect loop ends after five hops; a "Book"
  //   link that redirects off-site names the vendor but the other site is never read.
  // fails_when: links are matched against the typed host instead of the final one, the hop limit is
  //   missing, or an off-site redirect from a sub-page is followed.
  // seam: deps.httpGet.
  it("follows the start URL to its final host, caps the hops, and does not leave the site from a sub-page", async () => {
    const t = scripted({
      "https://example.com/": { status: 301, location: "https://www.example.org/home" },
      "https://www.example.org/home": { status: 302, location: "/welcome" },
      "https://www.example.org/welcome": page('<a href="/book">Book</a><a href="https://example.com/services">Old site services</a>'),
      "https://www.example.org/book": { status: 302, location: "https://example-studio.glossgenius.com/services" },
    });
    const r = await crawlSite(new URL("https://example.com/"), { httpGet: t.get });
    expect(r.url).toBe("https://www.example.org/welcome");
    expect(r.pages.map((p) => p.url)).toEqual(["https://www.example.org/welcome"]);
    expect(r.vendor).toEqual({ kind: "glossgenius", label: "GlossGenius", url: "https://example-studio.glossgenius.com" });
    expect(t.calls).toEqual(["https://example.com/", "https://www.example.org/home", "https://www.example.org/welcome", "https://www.example.org/book"]);

    const loop = scripted({ "https://example.com/": { status: 302, location: "/" } });
    await expect(crawlSite(new URL("https://example.com/"), { httpGet: loop.get })).rejects.toThrow(CRAWL_ERRORS.redirects);
    expect(loop.calls).toHaveLength(6);
  });

  // protects: whatever the transport throws, the start page's failure surfaces as one of the fixed
  //   messages, never the underlying error text.
  // fails_when: a transport error is rethrown as is (its message can hold a host, a path or a body).
  // seam: deps.httpGet.
  it("rejects with a fixed message when the start page cannot be read", async () => {
    const boom: HttpGet = async () => {
      throw new Error("getaddrinfo ENOTFOUND secret-host.example.com <html>body</html>");
    };
    await expect(crawlSite(new URL("https://example.com/"), { httpGet: boom })).rejects.toThrow(new Error(CRAWL_ERRORS.unreachable));
    await expect(crawlSite(new URL("https://example.com/"), { httpGet: scripted({}).get })).rejects.toThrow(new Error(CRAWL_ERRORS.status));
    await expect(crawlSite(new URL("https://example.com/"), { httpGet: scripted({ "https://example.com/": { status: 200, type: "image/png" } }).get })).rejects.toThrow(
      new Error(CRAWL_ERRORS.notHtml),
    );
  });
});

describe("address rules", () => {
  // protects: the one rule that decides which addresses the wizard may connect to.
  // fails_when: a private, loopback, link-local, CGNAT, unique-local, NAT64, 6to4, multicast or
  //   IPv4-mapped range is dropped from the block list, or a public address is refused.
  // seam: none.
  it("isPublicAddress separates public addresses from everything else", () => {
    const blocked = [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:8.8.8.8",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%lo0",
      "64:ff9b::7f00:1",
      "2002:7f00:1::1",
      "ff02::1",
      "2001:db8::1",
      "example.com",
      "",
    ];
    for (const ip of blocked) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  // protects: the lookup handed to http.request returns only vetted addresses, in both callback forms
  //   (Node asks for all addresses when autoSelectFamily is on, for one otherwise), and fails when a
  //   name resolves to private addresses only.
  // fails_when: the array form passes a private address through, the single form returns the first
  //   address unfiltered, or an all-private answer connects anyway.
  // seam: the resolver argument of guardedLookup (dns.lookup in production).
  it("guardedLookup filters resolved addresses in both callback forms", () => {
    const answers: Record<string, LookupAddress[]> = {
      "mixed.example.com": [
        { address: "10.0.0.5", family: 4 },
        { address: "8.8.8.8", family: 4 },
        { address: "::1", family: 6 },
      ],
      "inside.example.com": [
        { address: "192.168.1.10", family: 4 },
        { address: "fd00::1", family: 6 },
      ],
    };
    const lookup = guardedLookup((host, _o, cb) => cb(null, answers[host] ?? []));
    const run = (host: string, all: boolean) => {
      let got: unknown[] = [];
      lookup(host, { all }, (...args) => (got = args));
      return got;
    };

    expect(run("mixed.example.com", true)).toEqual([null, [{ address: "8.8.8.8", family: 4 }]]);
    expect(run("mixed.example.com", false)).toEqual([null, "8.8.8.8", 4]);
    for (const all of [true, false]) {
      const [err] = run("inside.example.com", all);
      expect((err as Error).message).toBe(CRAWL_ERRORS.blocked);
    }
  });

  // protects: the real transport refuses loopback, an IPv6 literal (which never reaches the lookup),
  //   local names, userinfo and other schemes before any request object exists.
  // fails_when: the literal-host check is removed and only the DNS lookup is guarded, or the check
  //   runs after http.request.
  // seam: http.request / https.request are replaced so that reaching them fails the test; nothing
  //   is listening and no socket is opened.
  it("the default transport rejects a blocked host before connecting", async () => {
    const reached = () => {
      throw new Error("a request was started");
    };
    const plain = vi.spyOn(http, "request").mockImplementation(reached);
    const tls = vi.spyOn(https, "request").mockImplementation(reached);

    for (const url of ["http://127.0.0.1:8080/", "http://[::1]/", "http://2130706433/", "https://localhost/", "https://printer.local./", "https://[::ffff:10.0.0.1]/", "https://user:pw@example.com/", "ftp://example.com/"]) {
      await expect(defaultHttpGet(new URL(url), { timeoutMs: 1000, maxBytes: 1000 }), url).rejects.toThrow(new Error(CRAWL_ERRORS.blocked));
    }
    expect(plain).not.toHaveBeenCalled();
    expect(tls).not.toHaveBeenCalled();
  });
});

describe("normalizeWebsiteUrl", () => {
  // protects: what a merchant types becomes a crawlable URL (https assumed), and anything that is not
  //   a plain public web address is turned away with a short message.
  // fails_when: the scheme default is lost, userinfo or a non-http scheme gets through, or a bare
  //   word like "localhost" is accepted.
  // seam: none.
  it("adds https://, keeps http, and rejects what is not a website address", () => {
    expect(normalizeWebsiteUrl("  example.com ").href).toBe("https://example.com/");
    expect(normalizeWebsiteUrl("www.Example.com/salon#hours").href).toBe("https://www.example.com/salon");
    expect(normalizeWebsiteUrl("http://example.com:8080/a?b=1").href).toBe("http://example.com:8080/a?b=1");

    for (const bad of ["", "   ", "localhost", "salon", "ftp://example.com", "file:///etc/hosts", "javascript:alert(1)", "mailto:hello@example.com", "https://user:pw@example.com", "user@example.com", "my salon.com", "http://[::1]/"]) {
      let message = "";
      try {
        normalizeWebsiteUrl(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/^[\x20-\x7e]{10,90}$/);
    }
  });
});
