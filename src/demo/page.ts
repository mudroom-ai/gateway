// The playground page served at / in demo mode: one copyable prompt for the
// visitor's own agent, plus a live feed and counters polled from /demo/feed.
// Plain HTML, CSS and a few lines of inline script; nothing to build. The
// feed is rendered with textContent only, and holds no free text anyway.

import type { Config } from "../config.js";

export const REPO_URL = "https://github.com/mudroom-ai/gateway";
/** How long a demo booking lives before it cancels itself. */
export const DEMO_BOOKING_TTL_MIN = 60;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function playgroundPrompt(config: Config, base: string): string {
  return `Book me a dog bath Thursday afternoon at ${config.name} and ask if they take large dogs. Start at ${base}/llms.txt`;
}

/** "9:00–17:00, 21:00–23:00" when every open day has the same hours, else null (the page then skips the line). */
function sameHours(config: Config): string | null {
  const open = Object.values(config.hours).filter((s) => s.length);
  if (!open.length) return null;
  const fmt = (spans: { start: string; end: string }[]) => spans.map((h) => `${h.start}–${h.end}`).join(", ");
  const first = fmt(open[0]!);
  return open.every((s) => fmt(s) === first) ? `${open.length === 7 ? "Every day" : "Open"} ${first}` : null;
}

export function playgroundPage(config: Config, base: string): string {
  const prompt = playgroundPrompt(config, base);
  const hours = sameHours(config);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent playground: ${esc(config.name)}</title>
<meta name="description" content="A live demo business that AI agents can book and message. Tell your agent to start at ${esc(base)}/llms.txt">
<link rel="alternate" type="text/markdown" title="Booking instructions for AI agents" href="${esc(base)}/llms.txt">
<link rel="service-desc" type="application/json" href="${esc(base)}/openapi.json">
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b675f;--line:#e4e0d6;--card:#fff;--accent:#2f6f4f;--bad:#a33a2b;--tag:#f1e7c8}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a29e94;--line:#34322d;--card:#1f1e1b;--accent:#7cc39c;--bad:#e58b7c;--tag:#4a3f1f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.5rem 16px 3rem}
.tag{display:inline-block;background:var(--tag);font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:.15rem .5rem;border-radius:.25rem}
h1{font-size:1.6rem;line-height:1.2;margin:.5rem 0 .25rem}
h2{font-size:1rem;margin:2rem 0 .5rem}
p{margin:.25rem 0}
.muted{color:var(--muted);font-size:.9rem}
.prompt{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:1rem;margin-top:1rem}
.prompt p{font-size:1.05rem;overflow-wrap:anywhere}
button{margin-top:.75rem;font:inherit;font-weight:600;padding:.45rem .9rem;border-radius:.4rem;border:1px solid var(--accent);background:var(--accent);color:var(--bg);cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem}
.stat{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.6rem .75rem}
.stat b{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums}
.stat span{font-size:.8rem;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
td,th{text-align:left;padding:.4rem .25rem;border-bottom:1px solid var(--line)}
th{font-size:.75rem;color:var(--muted);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:var(--accent)}.err{color:var(--bad)}
a{color:var(--accent)}
footer{margin-top:2.5rem}
</style>
</head><body><main>
<span class="tag">Playground</span>
<h1>${esc(config.name)}</h1>
<p class="muted">A pretend dog groomer that takes bookings from AI agents. Your agent is the customer; a human owner answers its questions in Slack.${hours ? ` ${esc(hours)} (${esc(config.timezone)}).` : ""}</p>

<div class="prompt">
<p id="prompt">${esc(prompt)}</p>
<button type="button" id="copy">Copy prompt</button>
</div>
<p class="muted" style="margin-top:.5rem">Paste it into Muse, Grok, ChatGPT or Claude. This is a playground: if the owner is away from the desk, a templated reply says so, and demo bookings cancel themselves after ${DEMO_BOOKING_TTL_MIN} minutes.</p>

<h2>Agents so far</h2>
<div class="stats">
<div class="stat"><b id="s-today">–</b><span>agents today</span></div>
<div class="stat"><b id="s-week">–</b><span>agents this week</span></div>
<div class="stat"><b id="s-booked">–</b><span>bookings made</span></div>
</div>
<table style="margin-top:.75rem"><thead><tr><th>Agent</th><th class="n">Requests today</th><th class="n">This week</th><th class="n">Bookings</th></tr></thead><tbody id="vendors"></tbody></table>

<h2>Live feed</h2>
<table><thead><tr><th>Agent</th><th>Did</th><th>Result</th><th class="n">When</th></tr></thead><tbody id="feed"><tr><td colspan="4" class="muted">Waiting for the first agent…</td></tr></tbody></table>
<p class="muted" style="margin-top:.5rem">Updates every 10 seconds. No names, numbers or messages are shown.</p>

<footer class="muted">Built with <a href="${REPO_URL}">gateway</a>, open source. Agents: read <a href="${esc(base)}/llms.txt">${esc(base)}/llms.txt</a>.</footer>
</main>
<script>
(function(){
var NAMES={muse:"Muse",grok:"Grok",openai:"ChatGPT",claude:"Claude",other:"Other"};
var DID={services:"listed services",slots:"checked times",quote:"got a quote",book:"booked",cancel:"cancelled",reschedule:"rescheduled",message:"messaged the owner"};
function el(tag,text,cls){var e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e}
function ago(iso){var s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));if(s<60)return s+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}
function row(cells){var tr=document.createElement("tr");cells.forEach(function(c){tr.appendChild(c)});return tr}
function render(f){
  document.getElementById("s-today").textContent=f.today.agents;
  document.getElementById("s-week").textContent=f.week.agents;
  document.getElementById("s-booked").textContent=f.bookings.total;
  var vb=document.getElementById("vendors");vb.replaceChildren();
  Object.keys(NAMES).forEach(function(v){
    if(!f.week.by_vendor[v]&&!f.bookings.by_vendor[v])return;
    vb.appendChild(row([el("td",NAMES[v]),el("td",String(f.today.by_vendor[v]||0),"n"),el("td",String(f.week.by_vendor[v]||0),"n"),el("td",String(f.bookings.by_vendor[v]||0),"n")]));
  });
  if(!vb.children.length)vb.appendChild(row([Object.assign(el("td","No agents yet this week.","muted"),{colSpan:4})]));
  var fb=document.getElementById("feed");
  if(!f.recent.length)return;
  fb.replaceChildren();
  f.recent.forEach(function(i){
    var ok=i.outcome==="ok";
    fb.appendChild(row([el("td",NAMES[i.vendor]||"Other"),el("td",DID[i.route]||i.route),el("td",ok?"ok":i.outcome.replace(/_/g," "),ok?"ok":"err"),el("td",ago(i.at),"n")]));
  });
}
function poll(){fetch("/demo/feed",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(f){if(f)render(f)}).catch(function(){})}
poll();setInterval(poll,10000);
document.getElementById("copy").addEventListener("click",function(){
  var t=document.getElementById("prompt").textContent,b=this;
  (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Copied"},function(){var r=document.createRange();r.selectNodeContents(document.getElementById("prompt"));var s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent="Press Ctrl+C"});
  setTimeout(function(){b.textContent="Copy prompt"},2000);
});
})();
</script>
</body></html>
`;
}
