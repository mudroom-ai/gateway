const title = document.querySelector("#title");
const description = document.querySelector("#description");
const logEl = document.querySelector("#log");
const hint = document.querySelector("#hint");
const form = document.querySelector("#form");
const status = document.querySelector("#status");

let step = null;
let sending = false;
let cursor = 0;

function clear(node) {
  node.replaceChildren();
}

function showWorking(label) {
  title.textContent = label || "Working…";
  clear(description);
  hint.hidden = true;
  form.hidden = true;
  form.replaceChildren();
  form.onsubmit = null;
  status.hidden = false;
  status.textContent = "Working…";
}

function appendLog(text) {
  const p = document.createElement("p");
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  if (!text) {
    p.append(document.createElement("br"));
  } else {
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0;
      p.append(text.slice(last, index));
      const a = document.createElement("a");
      a.href = match[0];
      a.textContent = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      p.append(a);
      last = index + match[0].length;
    }
    p.append(text.slice(last));
  }
  logEl.append(p);
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

function setDescription(lines) {
  clear(description);
  for (const line of lines ?? []) {
    const text = String(line).trim();
    if (!text) continue;
    const p = document.createElement("p");
    p.textContent = text;
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
  setDescription([]);
  hint.hidden = false;
  hint.textContent = "No is the default.";
  form.hidden = false;
  status.hidden = true;
  form.replaceChildren();
  const actions = document.createElement("div");
  actions.className = "actions";
  const no = action("No", "ghost", () => submit("no"));
  no.type = "submit";
  const yes = action("Yes", "primary", () => submit("yes"));
  actions.append(no, yes);
  form.append(actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    submit("no");
  };
  no.focus();
}

function paintChoices() {
  for (const [i, el] of form.querySelectorAll(".choice").entries()) {
    el.setAttribute("aria-checked", i === cursor ? "true" : "false");
  }
}

function showChoose(current) {
  title.textContent = current.question;
  setDescription(current.description);
  const cancel = current.cancel !== undefined ? current.items?.[current.cancel] : undefined;
  hint.hidden = false;
  hint.textContent = cancel ? `Esc selects “${cancel.label}”.` : "Enter selects the highlighted row.";
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
    const label = document.createElement("span");
    label.textContent = item.emoji ? `${item.emoji} ${item.label}` : item.label;
    row.append(label);
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
  keys.textContent = "↑↓ move  Enter select";
  form.append(keys);
  form.onsubmit = (e) => e.preventDefault();
  paintChoices();
  group.querySelectorAll(".choice")[cursor]?.focus();
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
  step = next;
  sending = false;
  if (next.kind === "ask") showAsk(next);
  else if (next.kind === "confirm") showConfirm(next);
  else if (next.kind === "choose") showChoose(next);
  else if (next.kind === "done") showDone(next);
}

document.addEventListener("keydown", (e) => {
  if (!step || step.kind !== "choose" || sending) return;
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
