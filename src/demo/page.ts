// The playground page served at / in demo mode: the demo business as a small
// storefront in the mudroom.dev design language (Geist, monochrome, bordered
// cards), a modal on load with the prompt to paste into an agent, and a live
// activity panel polled from /demo/feed. Plain HTML, CSS and a little inline
// script; nothing to build. The feed is rendered with textContent only, and
// holds no free text anyway.

import { DateTime } from "luxon";
import type { Config } from "../config.js";

export const REPO_URL = "https://github.com/mudroom-ai/gateway";
/** How long a demo booking lives before it cancels itself. */
export const DEMO_BOOKING_TTL_MIN = 60;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function playgroundPrompt(config: Config, base: string): string {
  return `Book me a dog bath Thursday afternoon at ${config.name} (${base}) and ask if they take large dogs.`;
}

/** The same kind of prompt for one service, for its card. */
function servicePrompt(config: Config, base: string, serviceName: string): string {
  return `Book me a ${serviceName.toLowerCase()} tomorrow afternoon at ${config.name} (${base}).`;
}

/** For the ask-the-owner card: a question only a person can answer, so the agent leaves a message instead of booking. */
export function askOwnerPrompt(config: Config, base: string): string {
  return `Ask the owner of ${config.name} (${base}) whether they can groom a nervous 60 lb doodle, and tell me what they say.`;
}

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

/** "9 am", "5:30 pm" from "09:00", "17:30". */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

const spans = (s: { start: string; end: string }[]) => (s.length ? s.map((h) => `${clock(h.start)}–${clock(h.end)}`).join(", ") : "Closed");

/** "Pacific Time" style generic zone name (no daylight/standard), else the IANA id. */
function zoneLabel(config: Config, now: DateTime): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, timeZoneName: "longGeneric" })
      .formatToParts(now.toJSDate())
      .find((p) => p.type === "timeZoneName")?.value;
    return name && !/^GMT/.test(name) ? name : config.timezone;
  } catch {
    return config.timezone;
  }
}

const price = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

/** `askOwner`: messages reach a person who replies in-band (two-way channel), so the page offers the ask-the-owner card. */
export function playgroundPage(config: Config, base: string, opts: { askOwner?: boolean; now?: DateTime } = {}): string {
  const now = opts.now ?? DateTime.now();
  const prompt = playgroundPrompt(config, base);
  const local = now.setZone(config.timezone);
  const today = DAYS[local.weekday - 1]![0];
  const zone = zoneLabel(config, now);
  const services = config.services
    .map(
      (s) => `<article class="card service">
  <div class="service-head"><h3>${esc(s.name)}</h3><span class="price">${esc(price(s.price_cents, config.currency))}</span></div>
  ${s.description ? `<p>${esc(s.description)}</p>` : ""}
  <div class="service-foot"><span class="meta">${s.duration_min} min</span><button type="button" class="button ghost small" data-copy="${esc(servicePrompt(config, base, s.name))}">Copy agent prompt</button></div>
</article>`,
    )
    .join("\n");
  const ask = opts.askOwner
    ? `<article class="card service ask">
  <div class="service-head"><h3>Ask the owner</h3><span class="meta">Free</span></div>
  <p>A question your agent can't answer from the menu? It leaves a message, a human owner types a reply, and your agent reads the answer back to you.</p>
  <div class="service-foot"><span class="meta">Human reply · templated note if away 10 min</span><button type="button" class="button ghost small" data-copy="${esc(askOwnerPrompt(config, base))}">Copy agent prompt</button></div>
</article>`
    : "";
  const hours = DAYS.map(
    ([d, label]) => `<li${d === today ? ' class="today"' : ""}><span>${label}</span><span>${esc(spans(config.hours[d]))}</span></li>`,
  ).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.name)} · Agent playground</title>
<meta name="description" content="A live demo shop that AI agents can book and message. Tell your agent to start at ${esc(base)}/llms.txt">
<link rel="alternate" type="text/markdown" title="Booking instructions for AI agents" href="${esc(base)}/llms.txt">
<link rel="service-desc" type="application/json" href="${esc(base)}/openapi.json">
<link rel="preload" href="/demo/geist.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:"Geist Variable";src:url("/demo/geist.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root,:root[data-theme="light"]{--background:#fff;--surface:#fafafa;--text:#171717;--body-text:#404040;--muted:#666;--border:#e8e8e8;--border-strong:#d4d4d4;--hover:#f2f2f2;--primary:#171717;--primary-text:#fff;--primary-hover:#333;--header-background:rgba(255,255,255,.94);--shadow:rgba(0,0,0,.12);--ok:#26734d;--bad:#b4442a;--live:#22a06b;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--background:#0a0a0a;--surface:#141414;--text:#ededed;--body-text:#c5c5c5;--muted:#a1a1a1;--border:#272727;--border-strong:#3c3c3c;--hover:#202020;--primary:#ededed;--primary-text:#0a0a0a;--primary-hover:#fff;--header-background:rgba(10,10,10,.94);--shadow:rgba(0,0,0,.5);--ok:#8dccab;--bad:#f09a85;--live:#4cc38a;color-scheme:dark}}
:root[data-theme="dark"]{--background:#0a0a0a;--surface:#141414;--text:#ededed;--body-text:#c5c5c5;--muted:#a1a1a1;--border:#272727;--border-strong:#3c3c3c;--hover:#202020;--primary:#ededed;--primary-text:#0a0a0a;--primary-hover:#fff;--header-background:rgba(10,10,10,.94);--shadow:rgba(0,0,0,.5);--ok:#8dccab;--bad:#f09a85;--live:#4cc38a;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;color:var(--text);background:radial-gradient(ellipse 80% 40% at 50% -10%,var(--hover),transparent 60%),var(--background);font-family:"Geist Variable",ui-sans-serif,system-ui,sans-serif;font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
body{min-height:100dvh}
a{color:inherit}
.nav{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:.75rem;height:56px;padding:0 clamp(1rem,3vw,1.5rem);border-bottom:1px solid var(--border);background:var(--header-background);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.mark{display:flex;align-items:center;gap:.6rem;min-width:0;font-size:.95rem;font-weight:560;letter-spacing:-.03em;text-decoration:none;white-space:nowrap}
.mark .name{overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-flex;align-items:center;gap:.4rem;height:1.4rem;padding:0 .55rem;border:1px solid var(--border-strong);border-radius:999px;font-size:.7rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.nav-actions{display:flex;align-items:center;gap:.5rem}
.button{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;height:2.25rem;padding:0 .9rem;border-radius:8px;border:1px solid transparent;font:inherit;font-size:.875rem;font-weight:500;letter-spacing:-.01em;text-decoration:none;cursor:pointer;white-space:nowrap;transition:background 160ms ease,border-color 160ms ease,color 160ms ease}
.button.primary{background:var(--primary);color:var(--primary-text)}
.button.primary:hover{background:var(--primary-hover)}
.button.ghost{color:var(--text);border-color:var(--border-strong);background:transparent}
.button.ghost:hover{background:var(--hover)}
.button.small{height:2rem;padding:0 .7rem;font-size:.8125rem}
.button.lg{height:2.5rem;padding:0 1rem}
.button:focus{outline:none}
.button:focus-visible,a:focus-visible{outline:1px solid var(--text);outline-offset:3px}
.only-wide{display:inline-flex}
.short{display:none}
main{width:min(100% - 2rem,68rem);margin:0 auto}
.hero{display:flex;flex-direction:column;align-items:center;gap:1.1rem;padding:clamp(3rem,8vh,5.5rem) 0 clamp(2.5rem,6vh,4rem);text-align:center}
.eyebrow{margin:0;font-size:.75rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:.45rem;text-transform:none;letter-spacing:0;font-size:.8125rem}
.dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--muted)}
.dot.on{background:var(--live);box-shadow:0 0 0 0 var(--live);animation:pulse 2s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--live) 60%,transparent)}100%{box-shadow:0 0 0 .5rem transparent}}
h1{margin:0;max-width:13em;font-size:clamp(2.4rem,5.4vw,4.1rem);font-weight:500;line-height:1.03;letter-spacing:-.045em;text-wrap:balance}
.dek{margin:0;max-width:35rem;font-size:1.05rem;line-height:1.55;color:var(--muted);text-wrap:balance}
.actions{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem;margin-top:.25rem}
section{padding:0 0 clamp(3rem,8vh,4.5rem)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin:0 0 1.1rem}
h2{margin:0;font-size:clamp(1.3rem,2vw,1.65rem);font-weight:500;letter-spacing:-.03em;line-height:1.2}
.section-head p{margin:0;font-size:.875rem;color:var(--muted)}
.card{border:1px solid var(--border);border-radius:12px;background:var(--background)}
.shop{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1rem}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
.service{display:flex;flex-direction:column;gap:.75rem;padding:1.35rem 1.35rem 1.2rem;transition:border-color 160ms ease,transform 160ms ease}
.service:hover{border-color:var(--border-strong)}
.service-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
h3{margin:0;font-size:1.05rem;font-weight:550;letter-spacing:-.02em}
.price{font-size:1.05rem;font-weight:500;font-variant-numeric:tabular-nums}
.service p{margin:0;flex:1;font-size:.925rem;line-height:1.55;color:var(--body-text)}
.service.ask{grid-column:1/-1;background:var(--surface)}
.service-foot{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding-top:.75rem;border-top:1px solid var(--border)}
.meta{font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
.hours{padding:1.25rem 1.35rem}
.hours h3{display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem}
.hours ul{list-style:none;margin:0;padding:0;display:grid;gap:.45rem}
.hours li{display:flex;justify-content:space-between;gap:1rem;font-size:.875rem;color:var(--muted);font-variant-numeric:tabular-nums}
.hours li span:last-child{text-align:right}
.hours li.today{color:var(--text);font-weight:500}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--border);border-radius:12px;overflow:hidden}
.steps li{padding:1.5rem 1.35rem 1.65rem;font-size:.95rem;line-height:1.55;color:var(--body-text)}
.steps li+li{border-left:1px solid var(--border)}
.steps li span{display:block;margin-bottom:.55rem;font-size:.75rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.live{display:inline-flex;align-items:center;gap:.45rem;font-size:.8125rem;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:1rem}
.stat{padding:1.15rem 1.35rem}
.stat+.stat{border-left:1px solid var(--border)}
.stat b{display:block;font-size:clamp(1.8rem,3.4vw,2.4rem);font-weight:500;letter-spacing:-.04em;line-height:1.1;font-variant-numeric:tabular-nums}
.stat span{font-size:.8125rem;color:var(--muted)}
.activity{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:1rem;align-items:start}
.panel{padding:1.1rem 1.25rem}
.panel h3{font-size:.75rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:.9rem}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:.8rem}
.bar-row{display:grid;grid-template-columns:5.5rem minmax(0,1fr) 7rem;align-items:center;gap:.75rem;font-size:.875rem}
.bar{height:.4rem;border-radius:999px;background:var(--hover);overflow:hidden}
.bar i{display:block;height:100%;border-radius:inherit;background:var(--text);transition:width 400ms ease}
.bar-row .n{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.8125rem;min-width:4.5rem;text-align:right}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-top:1px solid var(--border);font-size:.9rem}
.feed li:first-child{border-top:0;padding-top:0}
.feed li.fresh{animation:fresh 900ms ease}
@keyframes fresh{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.avatar{flex:none;display:grid;place-items:center;width:1.75rem;height:1.75rem;border-radius:50%;border:1px solid var(--border-strong);font-size:.7rem;font-weight:600;color:var(--muted)}
.feed .what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--body-text)}
.feed .what b{font-weight:550;color:var(--text)}
.tag{flex:none;font-size:.75rem;padding:.1rem .45rem;border-radius:999px;border:1px solid var(--border)}
.tag.ok{color:var(--ok)}
.tag.err{color:var(--bad)}
.feed time{flex:none;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums;min-width:3.5rem;text-align:right}
.empty{color:var(--muted);font-size:.875rem}
.fine{margin:.9rem 0 0;font-size:.8125rem;color:var(--muted)}
footer{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;width:min(100% - 2rem,68rem);margin:0 auto;padding:1.25rem 0 1.75rem;border-top:1px solid var(--border);font-size:.875rem;color:var(--muted)}
footer nav{display:flex;gap:1rem}
footer a{text-decoration:none}
footer a:hover{color:var(--text)}
dialog{width:min(100% - 2rem,34rem);max-height:calc(100dvh - 2rem);padding:0;border:1px solid var(--border);border-radius:16px;background:var(--background);color:var(--text);box-shadow:0 24px 80px var(--shadow)}
dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
dialog[open]{animation:pop 260ms cubic-bezier(.2,.9,.3,1.2)}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.modal{padding:1.6rem 1.6rem 1.4rem}
.modal-top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
.close{display:grid;place-items:center;width:2rem;height:2rem;margin:-.35rem -.5rem 0 0;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:1.25rem;cursor:pointer}
.close:hover{background:var(--hover);color:var(--text)}
.close:focus{outline:none}.close:focus-visible{outline:1px solid var(--text);outline-offset:2px}
.modal h2{margin:.55rem 0 .5rem;font-size:1.6rem;letter-spacing:-.04em}
.modal .lede{margin:0 0 1.2rem;color:var(--muted);line-height:1.55;font-size:.95rem}
.modal ol{list-style:none;counter-reset:s;margin:0;padding:0;display:grid;gap:1rem}
.modal ol>li{counter-increment:s;display:grid;grid-template-columns:1.6rem 1fr;gap:.75rem;font-size:.925rem;line-height:1.5;color:var(--body-text)}
.modal ol>li::before{content:counter(s);display:grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;border:1px solid var(--border-strong);font-size:.75rem;font-weight:500;color:var(--text)}
.modal ol>li b{color:var(--text);font-weight:550}
.prompt{position:relative;margin-top:.6rem;padding:.9rem 1rem;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:.9rem;line-height:1.55;color:var(--text);overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.55rem}
.chip{font-size:.8125rem;padding:.2rem .6rem;border:1px solid var(--border);border-radius:999px;color:var(--text)}
.note{margin:1.2rem 0 0;padding:.8rem 1rem;border-radius:10px;background:var(--surface);font-size:.8125rem;line-height:1.5;color:var(--muted)}
.modal-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.3rem}
.modal-actions .button{flex:1}
.toast{position:fixed;left:50%;bottom:1.5rem;z-index:20;transform:translate(-50%,1rem);opacity:0;pointer-events:none;padding:.6rem 1rem;border-radius:8px;background:var(--primary);color:var(--primary-text);font-size:.875rem;font-weight:500;transition:opacity 180ms ease,transform 180ms ease}
.toast.show{opacity:1;transform:translate(-50%,0)}
.rise{animation:rise 600ms cubic-bezier(.2,.8,.2,1) both}
.rise.d1{animation-delay:60ms}.rise.d2{animation-delay:120ms}.rise.d3{animation-delay:180ms}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media (max-width:760px){.shop,.activity{grid-template-columns:minmax(0,1fr)}.steps{grid-template-columns:1fr}.steps li+li{border-left:0;border-top:1px solid var(--border)}.only-wide{display:none}.section-head{flex-direction:column;gap:.35rem}}
@media (max-width:480px){.long{display:none}.short{display:inline}.stat{padding:.9rem 1rem}.stat span{font-size:.75rem}.modal{padding:1.3rem 1.2rem 1.2rem}.modal-actions{flex-direction:column}.modal-actions .button{flex:none;width:100%}.bar-row{grid-template-columns:4.5rem minmax(0,1fr) 6.5rem}}
</style>
</head><body>
<nav class="nav" aria-label="Main navigation">
  <a class="mark" href="/"><span class="name">${esc(config.name)}</span><span class="pill">Playground</span></a>
  <div class="nav-actions">
    <a class="button ghost only-wide" href="${REPO_URL}">GitHub</a>
    <button type="button" class="button primary" data-open><span class="long">Try with your agent</span><span class="short">Try it</span></button>
  </div>
</nav>

<main id="main-content">
  <header class="hero">
    <h1 class="rise d1">${esc(config.name)}</h1>
    <p class="dek rise d2">A pretend shop with a real calendar, open to AI agents. Your agent is the customer: it checks times, gets a quote and books. Questions go to a human owner.</p>
    <div class="actions rise d3">
      <button type="button" class="button primary lg" data-open>Get the prompt</button>
      <a class="button ghost lg" href="#activity">See live activity</a>
    </div>
  </header>

  <section id="services" aria-labelledby="services-title">
    <div class="section-head"><h2 id="services-title">Services</h2><p>Prices and times your agent sees, straight from the shop.</p></div>
    <div class="shop">
      <div class="services">
${services}
${ask}
      </div>
      <aside class="card hours" aria-label="Opening hours">
        <h3>Hours <span class="meta">${esc(zone)}</span></h3>
        <ul>${hours}</ul>
      </aside>
    </div>
  </section>

  <section aria-labelledby="how-title">
    <div class="section-head"><h2 id="how-title">How it works</h2><p>No app, no account. The shop speaks HTTP.</p></div>
    <ol class="steps">
      <li><span>Find</span>Your agent reads <a href="${esc(base)}/llms.txt">llms.txt</a>, then the services, open times and prices.</li>
      <li><span>Ask</span>A question only a person can answer goes to the owner. If nobody's at the desk in 10 minutes, a templated reply says so.</li>
      <li><span>Book</span>It books, cancels or moves the appointment in the shop's Google Calendar. Demo bookings cancel themselves after ${DEMO_BOOKING_TTL_MIN} minutes.</li>
    </ol>
  </section>

  <section id="activity" aria-labelledby="activity-title">
    <div class="section-head"><h2 id="activity-title">Live activity</h2><span class="live"><span class="dot on"></span>Updates every 10 seconds</span></div>
    <div class="stats">
      <div class="stat"><b id="s-today">0</b><span>agents today</span></div>
      <div class="stat"><b id="s-week">0</b><span>agents this week</span></div>
      <div class="stat"><b id="s-booked">0</b><span>bookings made</span></div>
    </div>
    <div class="activity">
      <div class="card panel"><h3>By agent, this week</h3><ul class="bars" id="vendors"><li class="empty">No agents yet this week.</li></ul></div>
      <div class="card panel"><h3>Recent requests</h3><ul class="feed" id="feed"><li class="empty">Waiting for the first agent…</li></ul></div>
    </div>
    <p class="fine">No names, phone numbers or messages are shown here.</p>
  </section>
</main>

<footer>
  <span>Built with <a href="${REPO_URL}">Gateway</a>, open source</span>
  <nav><a href="${esc(base)}/llms.txt">llms.txt</a><a href="${esc(base)}/openapi.json">OpenAPI</a><a href="${REPO_URL}">GitHub</a></nav>
</footer>

<dialog id="welcome" aria-labelledby="welcome-title">
  <div class="modal">
    <div class="modal-top"><span class="pill">Agent playground</span><button type="button" class="close" aria-label="Close" data-close>×</button></div>
    <h2 id="welcome-title">Send your AI agent shopping</h2>
    <p class="lede">This shop takes bookings from AI agents, and a human owner answers their questions. Try it with yours.</p>
    <ol>
      <li><div><b>Copy this prompt</b><div class="prompt" id="prompt">${esc(prompt)}</div></div></li>
      <li><div><b>Paste it into your agent</b><div class="chips"><span class="chip">Muse</span><span class="chip">GrokBot</span></div></div></li>
      <li><div><b>Watch it happen</b><br>Its requests show up under Live activity as they happen.</div></li>
    </ol>
    <p class="note">This is a playground. Bookings land in a real calendar, then cancel themselves after ${DEMO_BOOKING_TTL_MIN} minutes. If the owner is away from the desk, a templated reply says so.</p>
    <div class="modal-actions">
      <button type="button" class="button primary lg" data-copy-main autofocus>Copy prompt</button>
      <button type="button" class="button ghost lg" data-close>Browse the shop</button>
    </div>
  </div>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
(function(){
var NAMES={muse:"Muse",grokbot:"GrokBot"};
var MARKS={muse:"M",grokbot:"G"};
var DID={services:"read the services",slots:"checked times",quote:"got a quote",book:"booked",cancel:"cancelled",reschedule:"rescheduled",message:"asked the owner"};
var dlg=document.getElementById("welcome"),toast=document.getElementById("toast"),seen={},first=true,tt;
function show(msg){toast.textContent=msg;toast.classList.add("show");clearTimeout(tt);tt=setTimeout(function(){toast.classList.remove("show")},1800)}
function copy(text){
  var done=function(){show("Prompt copied. Paste it into your agent.")};
  if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(text).then(done,function(){fallback(text,done)});
  fallback(text,done);
}
function fallback(text,done){var t=document.createElement("textarea");t.value=text;t.setAttribute("readonly","");t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();try{document.execCommand("copy");done()}catch(e){show("Select the prompt and copy it")}t.remove()}
function open(){if(dlg.showModal&&!dlg.open)dlg.showModal()}
document.querySelectorAll("[data-open]").forEach(function(b){b.addEventListener("click",open)});
document.querySelectorAll("[data-close]").forEach(function(b){b.addEventListener("click",function(){dlg.close()})});
dlg.addEventListener("click",function(e){if(e.target===dlg)dlg.close()});
document.querySelector("[data-copy-main]").addEventListener("click",function(){copy(document.getElementById("prompt").textContent)});
document.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){copy(b.getAttribute("data-copy"))})});
open();
function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e}
function ago(iso){var s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));if(s<60)return s<10?"now":s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}
function count(id,n){var e=document.getElementById(id);if(e.textContent!==String(n))e.textContent=n}
function render(f){
  count("s-today",f.today.agents);count("s-week",f.week.agents);count("s-booked",f.bookings.total);
  var vb=document.getElementById("vendors"),max=0,rows=[];
  Object.keys(NAMES).forEach(function(v){var n=f.week.by_vendor[v]||0;if(n){rows.push([v,n]);if(n>max)max=n}});
  vb.replaceChildren();
  if(!rows.length)vb.appendChild(el("li","No agents yet this week.","empty"));
  rows.sort(function(a,b){return b[1]-a[1]}).forEach(function(r){
    var li=el("li",null,"bar-row"),bar=el("span",null,"bar"),fill=el("i");fill.style.width=Math.max(4,Math.round(r[1]/max*100))+"%";bar.appendChild(fill);
    var b=f.bookings.by_vendor[r[0]]||0;
    li.append(el("span",NAMES[r[0]]),bar,el("span",r[1]+" req"+(b?" · "+b+" booked":""),"n"));vb.appendChild(li);
  });
  var fb=document.getElementById("feed");
  if(!f.recent.length)return;
  fb.replaceChildren();
  f.recent.forEach(function(i){
    var key=i.at+i.vendor+i.route,li=el("li",null,seen[key]||first?"":"fresh");seen[key]=1;
    var ok=i.outcome==="ok",name=NAMES[i.vendor]||"Muse",what=el("span",null,"what");
    what.append(el("b",name)," "+(DID[i.route]||i.route));
    li.append(el("span",MARKS[i.vendor]||"M","avatar"),what,el("span",ok?"ok":i.outcome.replace(/_/g," "),"tag "+(ok?"ok":"err")),el("time",ago(i.at)));
    fb.appendChild(li);
  });
  first=false;
}
function poll(){fetch("/demo/feed",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(f){if(f)render(f)}).catch(function(){})}
poll();setInterval(poll,10000);
})();
</script>
</body></html>
`;
}
