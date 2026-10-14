import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../src/cli/setup-ui/theme.js", import.meta.url), "utf8");

function boot(saved: string | null, dark = false, blocked = false) {
  const root = { dataset: {} as Record<string, string> };
  const trigger = { dataset: {} as Record<string, string>, setAttribute: () => {} };
  const label = { textContent: "" };
  const inputs = ["system", "light", "dark"].map((value) => ({ value, checked: false }));
  const events: Record<string, (event?: unknown) => void> = {};
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => { events.media = fn; } };
  let stored = saved;
  runInNewContext(script, {
    window: { matchMedia: () => media, addEventListener: (name: string, fn: () => void) => { events[name] = fn; } },
    localStorage: {
      getItem: () => { if (blocked) throw Error("unavailable"); return stored; },
      setItem: (_: string, value: string) => { if (blocked) throw Error("unavailable"); stored = value; },
    },
    document: {
      documentElement: root,
      querySelector: (selector: string) => selector === "#theme-trigger" ? trigger : selector === "#theme-label" ? label : {
        addEventListener: (name: string, fn: () => void) => { events[name] = fn; },
      },
      querySelectorAll: () => inputs,
      addEventListener: (name: string, fn: () => void) => { events[name] = fn; },
    },
  });
  events.DOMContentLoaded!();
  return { root, media, events, inputs, label, stored: () => stored, sync: (value: string | null) => { stored = value; events.storage!({ key: "gateway-theme" }); } };
}

describe("setup appearance", () => {
  it("restores an explicit theme before rendering and ignores system changes", () => {
    const ui = boot("light", true);
    expect(ui.root.dataset.theme).toBe("light");
    expect(ui.label.textContent).toBe("Light");
    ui.media.matches = false;
    ui.events.media!();
    expect(ui.root.dataset.theme).toBe("light");
  });

  it("follows system changes and falls back for an invalid preference", () => {
    const ui = boot("invalid");
    expect(ui.root.dataset.theme).toBe("light");
    expect(ui.inputs[0]!.checked).toBe(true);
    ui.media.matches = true;
    ui.events.media!();
    expect(ui.root.dataset.theme).toBe("dark");
  });

  it("persists a choice and synchronizes changes from another tab", () => {
    const ui = boot(null);
    ui.events.change!({ target: { value: "dark" } });
    expect(ui.stored()).toBe("dark");
    expect(ui.root.dataset.theme).toBe("dark");
    ui.sync("light");
    expect(ui.root.dataset.theme).toBe("light");
    expect(ui.inputs[1]!.checked).toBe(true);
    ui.media.matches = true;
    ui.sync(null);
    expect(ui.root.dataset.theme).toBe("dark");
    expect(ui.label.textContent).toBe("System");
  });

  it("works when local storage is blocked", () => {
    const ui = boot(null, true, true);
    expect(ui.root.dataset.theme).toBe("dark");
    ui.events.change!({ target: { value: "light" } });
    expect(ui.root.dataset.theme).toBe("light");
  });
});
