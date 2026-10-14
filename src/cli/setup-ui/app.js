const title = document.querySelector("#title");
const description = document.querySelector("#description");
const logEl = document.querySelector("#log");
const hint = document.querySelector("#hint");
const form = document.querySelector("#form");
const status = document.querySelector("#status");
const notes = document.querySelector("#notes");
const history = document.querySelector("#history");
const historyLog = document.querySelector("#history-log");

let step = null;
let sending = false;
let cursor = 0;
let timeZoneTimer;
let timeZoneCatalog;
let timeZoneRequest;
const backButton = document.createElement("button");
backButton.type = "button";
backButton.className = "button ghost back-button";
backButton.textContent = "← Back";
backButton.hidden = true;
document.querySelector(".eyebrow").before(backButton);
backButton.addEventListener("click", goBack);

function clear(node) {
  node.replaceChildren();
}

function stopTimeZoneClock() {
  clearInterval(timeZoneTimer);
  timeZoneTimer = undefined;
}

function showWorking(label) {
  stopTimeZoneClock();
  backButton.hidden = true;
  title.textContent = label || "Working…";
  clear(description);
  hint.hidden = true;
  form.hidden = true;
  form.replaceChildren();
  form.onsubmit = null;
  status.hidden = false;
  status.textContent = "Working…";
}

// Render only text nodes and known elements; setup output is never HTML.
function appendText(node, text, links = true) {
  const re = /`([^`]+)`|(https?:\/\/[^\s<>"']+)|(?<=^|\s)(\/(?:[^\s<>"']+\/)*[^\s<>"']+\.(?:json|env|md|pem))/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    node.append(text.slice(last, match.index));
    const el = document.createElement(match[2] && links ? "a" : "code");
    const value = match[1] || match[2] || match[3];
    const filePath = match[3] || (/^\/.*\.(?:json|env|md|pem)$/.test(match[1] ?? "") ? match[1] : undefined);
    if (filePath) {
      el.className = "file-name";
      el.textContent = filePath.slice(filePath.lastIndexOf("/") + 1);
      el.title = filePath;
      el.setAttribute("aria-label", filePath);
    } else el.textContent = value;
    if (match[2] && links) {
      const url = new URL(match[2]);
      el.textContent = url.hostname === "github.com" && url.pathname.includes("/docs/") ? "View setup guide ↗" : `${url.hostname} ↗`;
      el.title = match[2];
      el.href = match[2];
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    }
    node.append(el);
    last = match.index + match[0].length;
  }
  node.append(text.slice(last));
}

function appendLines(text) {
  const card = document.createElement("div");
  card.className = "note-card";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const p = document.createElement("p");
    appendText(p, line.trimEnd());
    card.append(p);
  }
  if (!card.childElementCount) return;
  // A one-line status reads as text; cards are for notes with structure.
  if (card.childElementCount === 1) card.className = "note-line";
  logEl.append(card);
}

// The terminal prints next steps as one indented transcript. On the page, titles
// wrap as a list and command lines sit in their own blocks.
function isCommandLine(raw) {
  const indent = raw.match(/^ */)?.[0].length ?? 0;
  const body = raw.trim();
  if (indent < 7 || !body) return false;
  if (/^[a-z]\. /.test(body) || body.startsWith("(")) return false;
  return true;
}

function appendCopy(parent, text) {
  const p = document.createElement("p");
  p.className = "step-copy";
  const install = text.match(/^install: (.+?), or (https?:\/\/\S+)$/);
  if (install) {
    p.append("install: ");
    const code = document.createElement("code");
    code.textContent = install[1];
    p.append(code, ", or ");
    appendText(p, install[2]);
  } else appendText(p, text);
  parent.append(p);
}

function appendCommand(parent, text) {
  const pre = document.createElement("pre");
  pre.className = "command";
  const code = document.createElement("code");
  code.textContent = text;
  pre.append(code);
  parent.append(pre);
}

function appendNextSteps(text) {
  const block = document.createElement("div");
  block.className = "instruction note-card";
  const heading = document.createElement("h2");
  heading.textContent = "Next steps";
  const list = document.createElement("ol");
  list.className = "instruction-list instruction-steps";
  let item = null;
  const footers = [];
  for (const raw of text.split("\n")) {
    const body = raw.trim();
    if (!body || body === "Next steps:") continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const step = indent < 7 ? body.match(/^(\d+)\. (.+)$/) : null;
    if (step) {
      item = document.createElement("li");
      const label = document.createElement("strong");
      appendText(label, step[2]);
      item.append(label);
      list.append(item);
      continue;
    }
    if (body.startsWith("Details:")) { footers.push(body); continue; }
    if (!item) continue;
    if (isCommandLine(raw)) appendCommand(item, body);
    else appendCopy(item, body);
  }
  block.append(heading, list);
  for (const footer of footers) appendCopy(block, footer);
  logEl.append(block);
}

function appendLog(text) {
  const marker = text.search(/(?:^|\n)Next steps:\n/);
  if (marker === -1) appendLines(text);
  else {
    appendLines(text.slice(0, marker));
    appendNextSteps(text.slice(marker));
  }
  notes.hidden = !logEl.childElementCount;
}

// Structured guidance gives every page the same heading, checklist and link pattern.
function appendNote(note) {
  if (typeof note === "string") { appendLog(note); return; }
  const block = document.createElement("div");
  block.className = "instruction note-card";
  if (note.title) {
    const heading = document.createElement("h2");
    heading.textContent = note.title;
    block.append(heading);
  }
  if (note.text) {
    const p = document.createElement("p");
    appendText(p, note.text);
    block.append(p);
  }
  if (note.items?.length) {
    const list = document.createElement("ol");
    list.className = "instruction-list";
    for (const item of note.items) {
      const li = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = item.label;
      li.append(label);
      if (item.detail) {
        const detail = document.createElement("p");
        appendText(detail, item.detail);
        li.append(detail);
      }
      list.append(li);
    }
    block.append(list);
  }
  if (note.fields?.length) {
    const list = document.createElement("dl");
    list.className = "instruction-fields";
    for (const field of note.fields) {
      const term = document.createElement("dt");
      term.textContent = field.label;
      const value = document.createElement("dd");
      appendText(value, field.value);
      list.append(term, value);
    }
    block.append(list);
  }
  if (note.links?.length) {
    const links = document.createElement("div");
    links.className = "instruction-links";
    for (const link of note.links) {
      if (!/^https?:\/\//.test(link.href)) continue;
      const a = document.createElement("a");
      a.textContent = `${link.label} ↗`;
      a.href = link.href;
      a.title = link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.append(a);
    }
    block.append(links);
  }
  logEl.append(block);
  notes.hidden = false;
}

function archiveNotes() {
  historyLog.append(...logEl.childNodes);
  history.hidden = !historyLog.childElementCount;
  notes.hidden = true;
}

function action(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `button ${className}`;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

async function submit(value) {
  if (!step || sending || step.kind === "done") return;
  sending = true;
  const id = step.id;
  step = null;
  archiveNotes();
  showWorking();
  try {
    const res = await fetch("answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, value }),
    });
    if (!res.ok) showWorking("That answer was not accepted.");
  } catch {
    showWorking("Could not reach the setup process.");
  } finally {
    sending = false;
  }
}

async function goBack() {
  if (!step?.canBack || sending) return;
  sending = true;
  const previous = step;
  showWorking("Returning to the previous question…");
  try {
    const res = await fetch("back", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: previous.id }),
    });
    if (!res.ok) showStep(previous);
  } catch {
    showStep(previous);
    status.hidden = false;
    status.textContent = "Could not go back. Try again.";
  } finally {
    sending = false;
  }
}

function setDescription(lines) {
  clear(description);
  for (const line of lines ?? []) {
    const text = String(line).trim();
    if (!text) continue;
    const p = document.createElement("p");
    const colon = text.indexOf(": ");
    if (colon > 0 && colon < 60) {
      const strong = document.createElement("strong");
      strong.textContent = text.slice(0, colon + 1);
      p.append(strong, " ");
      appendText(p, text.slice(colon + 2));
    } else appendText(p, text);
    description.append(p);
  }
}

function showAsk(current) {
  title.textContent = current.question;
  setDescription([]);
  if (current.shown) {
    hint.hidden = false;
    hint.textContent = current.shown;
  } else {
    hint.hidden = true;
  }
  form.hidden = false;
  status.hidden = true;
  form.replaceChildren();
  const input = document.createElement("input");
  input.type = current.secret ? "password" : "text";
  input.id = "answer-input";
  input.setAttribute("aria-labelledby", "title");
  if (current.shown) input.setAttribute("aria-describedby", "hint");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", current.question);
  if (!current.secret && current.def) input.value = current.def;
  if (current.secret && current.shown) input.placeholder = current.shown;
  form.append(input);
  const actions = document.createElement("div");
  actions.className = "actions";
  const continueButton = action("Continue", "primary", () => submit(input.value));
  continueButton.type = "submit";
  actions.append(continueButton);
  form.append(actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    submit(input.value);
  };
  input.focus();
}

function showConfirm(current) {
  title.textContent = current.question;
  setDescription(current.description);
  const defaultYes = current.def === "yes";
  hint.hidden = false;
  hint.textContent = defaultYes ? "Yes is the default." : "No is the default.";
  form.hidden = false;
  status.hidden = true;
  form.replaceChildren();
  const actions = document.createElement("div");
  actions.className = "actions";
  const no = action("No", "ghost", () => submit("no"));
  no.type = defaultYes ? "button" : "submit";
  const yes = action("Yes", "primary", () => submit("yes"));
  yes.type = defaultYes ? "submit" : "button";
  actions.append(no, yes);
  form.append(actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    submit(defaultYes ? "yes" : "no");
  };
  (defaultYes ? yes : no).focus();
}

function paintChoices() {
  for (const [i, el] of form.querySelectorAll(".choice").entries()) {
    el.setAttribute("aria-checked", i === cursor ? "true" : "false");
    el.tabIndex = i === cursor ? 0 : -1;
  }
}

function showChoose(current) {
  title.textContent = current.question;
  // Match labeled terminal explanations to their options without changing the flow.
  const remaining = [...(current.description ?? [])];
  const explanations = (current.items ?? []).map((item, i) => {
    const index = remaining.findIndex((line) => {
      const prefix = line.trim().split(": ")[0];
      return prefix === item.label || item.label.startsWith(prefix + " (") ||
        (i > 0 && prefix.startsWith("...and ") && item.label.endsWith(prefix.slice(3)));
    });
    if (index < 0) return "";
    return remaining.splice(index, 1)[0].trim().split(": ").slice(1).join(": ");
  });
  setDescription(remaining);
  const cancel = current.cancel !== undefined ? current.items?.[current.cancel] : undefined;
  hint.hidden = true;
  form.hidden = false;
  status.hidden = true;
  form.replaceChildren();
  const group = document.createElement("div");
  group.className = "choices";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", current.question);
  cursor = current.index ?? 0;
  for (const [i, item] of (current.items ?? []).entries()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "choice";
    row.setAttribute("role", "radio");
    row.tabIndex = i === cursor ? 0 : -1;
    const indicator = document.createElement("span");
    indicator.className = "choice-indicator";
    indicator.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "choice-content";
    const label = document.createElement("span");
    label.className = "choice-label";
    label.textContent = item.label;
    content.append(label);
    if (explanations[i]) {
      const detail = document.createElement("span");
      detail.className = "choice-description";
      appendText(detail, explanations[i], false);
      content.append(detail);
    }
    row.append(indicator, content);
    if (item.status) {
      const mark = document.createElement("span");
      mark.className = "status-text";
      mark.textContent = item.status;
      row.append(mark);
    }
    row.addEventListener("click", () => {
      cursor = i;
      paintChoices();
      submit(String(i));
    });
    group.append(row);
  }
  form.append(group);
  const keys = document.createElement("p");
  keys.className = "keys";
  for (const [key, label] of [["↑ ↓", "Move"], ["Enter", "Select"], ...(cancel ? [["Esc", cancel.label]] : [])]) {
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    const text = document.createElement("span");
    text.textContent = label;
    keys.append(kbd, text);
  }
  form.append(keys);
  form.onsubmit = (e) => e.preventDefault();
  paintChoices();
  group.querySelectorAll(".choice")[cursor]?.focus();
}

function loadTimeZones() {
  if (timeZoneCatalog) return Promise.resolve(timeZoneCatalog);
  if (!timeZoneRequest) timeZoneRequest = fetch("timezones").then((response) => {
    if (!response.ok) throw new Error("Could not load time zones.");
    return response.json();
  }).then((zones) => { timeZoneCatalog = zones; return zones; }).catch((error) => { timeZoneRequest = null; throw error; });
  return timeZoneRequest;
}

function showTimeZone(current) {
  title.textContent = "Your business time zone";
  setDescription([]);
  hint.hidden = true;
  status.hidden = true;
  form.hidden = false;
  let selected = current.def;
  let selectedSource = current.zoneSource;
  if (selectedSource === "device") {
    try { selected = Intl.DateTimeFormat().resolvedOptions().timeZone || selected; } catch { /* Keep the server suggestion. */ }
  }
  let searching = false;
  let query = "";
  let active = 0;
  let matches = [];
  let loadError = false;
  const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_/]/g, " ").toLowerCase().trim();
  const option = (id) => {
    const found = timeZoneCatalog?.find((zone) => zone.id === id || zone.aliases.includes(id));
    if (found) return { ...found, id };
    const city = id.split("/").at(-1).replaceAll("_", " ");
    let name = city;
    try { name = new Intl.DateTimeFormat("en", { timeZone: id, timeZoneName: "longGeneric" }).formatToParts().find((part) => part.type === "timeZoneName")?.value || city; } catch { /* Saved zones remain usable with older browser data. */ }
    return { id, label: name === city ? city : `${name} · ${city}`, country: "" };
  };
  const clock = (id) => {
    try { return new Intl.DateTimeFormat(undefined, { timeZone: id, hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" }).format(new Date()); } catch { return "Local time unavailable"; }
  };
  const tick = () => {
    for (const el of form.querySelectorAll("[data-timezone-clock]")) el.textContent = clock(el.dataset.timezoneClock);
  };
  const clockNode = (id) => {
    const el = document.createElement("span");
    el.className = "zone-clock";
    el.dataset.timezoneClock = id;
    el.textContent = clock(id);
    return el;
  };
  const select = (id) => { selected = id; selectedSource = "selected"; searching = false; render(); };
  function render() {
    form.replaceChildren();
    form.onsubmit = (e) => { e.preventDefault(); if (!searching) submit(selected); };
    if (!searching) {
      const zone = option(selected);
      const card = document.createElement("div");
      card.className = "zone-card";
      const label = document.createElement("p");
      label.className = "zone-label";
      label.textContent = zone.label;
      const sourceLabel = document.createElement("p");
      sourceLabel.className = "zone-source";
      sourceLabel.textContent = ({ device: "Detected from your browser", saved: "Saved selection", website: "Suggested by your website", provided: "Provided in setup options", selected: "Your selection" })[selectedSource] || "Your selection";
      card.append(label, sourceLabel);
      const details = document.createElement("p");
      details.className = "zone-details";
      if (zone.country) details.append(`${zone.country} · `);
      details.append(clockNode(selected));
      card.append(details);
      const change = action("Change time zone", "ghost", () => { searching = true; render(); });
      card.append(change);
      form.append(card);
      const actions = document.createElement("div");
      actions.className = "actions";
      const next = action("Continue", "primary", () => submit(selected));
      next.type = "submit";
      actions.append(next);
      form.append(actions);
      next.focus();
      return;
    }
    const label = document.createElement("label");
    label.id = "zone-search-label";
    label.htmlFor = "zone-search";
    label.className = "zone-search-label";
    label.textContent = "Search city or time zone";
    const input = document.createElement("input");
    input.id = "zone-search";
    input.type = "text";
    input.value = query;
    input.placeholder = "Los Angeles, Pacific, London…";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "zone-results");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-labelledby", "zone-search-label");
    const list = document.createElement("div");
    list.id = "zone-results";
    list.className = "zone-results";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Time zones");
    const feedback = document.createElement("p");
    feedback.className = "zone-feedback";
    feedback.setAttribute("role", "status");
    function paint() {
      for (const [i, row] of list.querySelectorAll("[role=option]").entries()) row.setAttribute("aria-selected", String(i === active));
      if (matches.length) input.setAttribute("aria-activedescendant", `zone-result-${active}`);
      else input.removeAttribute("aria-activedescendant");
    }
    function results() {
      list.replaceChildren();
      const terms = normalize(query).split(/\s+/).filter(Boolean);
      const all = (timeZoneCatalog || []).filter((zone) => terms.every((term) => zone.search.includes(term)));
      matches = all.slice(0, 8);
      active = Math.min(active, Math.max(0, matches.length - 1));
      for (const [i, zone] of matches.entries()) {
        const row = document.createElement("button");
        row.type = "button";
        row.id = `zone-result-${i}`;
        row.className = "zone-result";
        row.tabIndex = -1;
        row.setAttribute("role", "option");
        const content = document.createElement("span");
        const name = document.createElement("span");
        name.className = "zone-result-name";
        name.textContent = zone.label;
        const country = document.createElement("span");
        country.className = "zone-country";
        country.textContent = zone.country;
        content.append(name, country);
        row.append(content, clockNode(zone.id));
        row.addEventListener("click", () => select(zone.id));
        list.append(row);
      }
      feedback.textContent = loadError ? "Could not load time zones. Try again." : !timeZoneCatalog ? "Loading time zones…" : !all.length ? "No matches. Try a nearby major city, country, or time-zone name." : all.length > 8 ? "Showing 8 matches. Type more to narrow your search." : `${all.length} ${all.length === 1 ? "match" : "matches"}`;
      paint();
    }
    input.addEventListener("input", () => { query = input.value; active = 0; results(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = e.key === "ArrowDown" ? Math.min(matches.length - 1, active + 1) : Math.max(0, active - 1);
        paint();
        list.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); if (matches[active]) select(matches[active].id); }
      else if (e.key === "Escape") { e.preventDefault(); searching = false; render(); }
    });
    form.append(label, input, list, feedback);
    if (loadError) form.append(action("Try again", "ghost", () => { loadError = false; load(); render(); }));
    form.append(action("Cancel", "ghost", () => { searching = false; render(); }));
    results();
    input.focus();
  }
  function load() {
    loadTimeZones().then(() => { if (step?.id === current.id) render(); }).catch(() => { if (step?.id === current.id) { loadError = true; if (searching) render(); } });
  }
  render();
  if (!timeZoneCatalog) load();
  timeZoneTimer = setInterval(tick, 30000);
}

function showDone(current) {
  title.textContent = current.ok === false ? "Setup stopped" : "Setup complete";
  setDescription([]);
  hint.hidden = true;
  form.hidden = false;
  status.hidden = true;
  form.replaceChildren();
  const actions = document.createElement("div");
  actions.className = "actions";
  const close = action("Close", "primary", async () => {
    close.disabled = true;
    try {
      await fetch("done", { method: "POST" });
    } catch {
      // The terminal can still press Enter to exit.
    }
    title.textContent = "You can close this tab.";
    form.hidden = true;
  });
  actions.append(close);
  form.append(actions);
  form.onsubmit = (e) => e.preventDefault();
  close.focus();
}

function showStep(next) {
  stopTimeZoneClock();
  step = next;
  sending = false;
  backButton.hidden = !next.canBack;
  if (next.kind === "timezone") showTimeZone(next);
  else if (next.kind === "ask") showAsk(next);
  else if (next.kind === "confirm") showConfirm(next);
  else if (next.kind === "choose") showChoose(next);
  else if (next.kind === "done") showDone(next);
}

document.addEventListener("keydown", (e) => {
  if (!step || step.kind !== "choose" || sending || (!form.contains(document.activeElement) || document.activeElement === backButton)) return;
  const count = step.items?.length ?? 0;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cursor = e.key === "ArrowDown" ? Math.min(count - 1, cursor + 1) : Math.max(0, cursor - 1);
    paintChoices();
    form.querySelectorAll(".choice")[cursor]?.focus();
  } else if (e.key === "Enter") {
    e.preventDefault();
    submit(String(cursor));
  } else if (e.key === "Escape" && step.cancel !== undefined) {
    e.preventDefault();
    submit(String(step.cancel));
  }
});

const source = new EventSource("events");
source.addEventListener("hello", () => {
  logEl.replaceChildren();
  historyLog.replaceChildren();
  notes.hidden = true;
  history.hidden = true;
});
source.addEventListener("context", (e) => {
  archiveNotes();
  for (const line of JSON.parse(e.data).lines) appendNote(line);
});
source.addEventListener("log", (e) => {
  appendLog(JSON.parse(e.data).text);
});
source.addEventListener("step", (e) => {
  showStep(JSON.parse(e.data));
});
source.onerror = () => {
  if (!step) status.textContent = "Reconnecting…";
};
