import { describe, expect, it } from "vitest";
import { isTimeZone, searchTimeZones, selectTerminalTimeZone, timeZoneClock, zoneOption } from "../src/cli/time-zones.js";
import { ScriptedPrompter } from "./helpers/scripted-prompter.js";

describe("shared time-zone picker", () => {
  it("finds friendly region names, major cities, countries and accented names", () => {
    expect(searchTimeZones("San Francisco").map((zone) => zone.id)).toContain("America/Los_Angeles");
    expect(searchTimeZones("London UK").map((zone) => zone.id)).toContain("Europe/London");
    expect(searchTimeZones("Pacific USA").map((zone) => zone.id)).toContain("America/Los_Angeles");
    expect(searchTimeZones("Pacific United States").map((zone) => zone.id)).toContain("America/Los_Angeles");
    expect(searchTimeZones("America/Los_Angeles").map((zone) => zone.id)).toContain("America/Los_Angeles");
    expect(searchTimeZones("sao paulo").length).toBeGreaterThan(0);
    expect(searchTimeZones("not a real city xyzzy")).toEqual([]);
  });

  it("shows friendly names while preserving an existing time-zone alias", async () => {
    expect(zoneOption("America/Los_Angeles").label).toBe("Pacific Time · Los Angeles");
    const p = new ScriptedPrompter([""]);
    expect(await selectTerminalTimeZone(p, "US/Pacific", "saved")).toBe("US/Pacific");
    expect(p.choices[0]![0]!.label).not.toContain("US/Pacific");
  });

  it("lets terminal users change zones by searching for a city", async () => {
    const p = new ScriptedPrompter(["2", "San Francisco", "1", "1"]);
    expect(await selectTerminalTimeZone(p, "Europe/London", "device")).toBe("America/Los_Angeles");
    expect(p.prompts).toContain("Search city or time zone (Enter to go back)");
    expect(p.choices[1]![0]!.label).toContain("Pacific Time");
    expect(p.remaining).toBe(0);
  });

  it("allows another search after no matches and preserves the suggestion when cancelling", async () => {
    const retry = new ScriptedPrompter(["2", "xyzzy city", "1", "London", "1", "1"]);
    expect(await selectTerminalTimeZone(retry, "America/Los_Angeles", "device")).toBe("Europe/London");
    const cancel = new ScriptedPrompter(["2", "London", "<esc>", "1"]);
    expect(await selectTerminalTimeZone(cancel, "America/Los_Angeles", "saved")).toBe("America/Los_Angeles");
    const noMatchesBack = new ScriptedPrompter(["2", "xyzzy city", "2", "1"]);
    expect(await selectTerminalTimeZone(noMatchesBack, "Europe/London", "saved")).toBe("Europe/London");
  });

  it("uses date-dependent offsets, distinguishes ambiguous abbreviations and includes UTC", () => {
    expect(timeZoneClock("America/Los_Angeles", new Date("2026-01-01T12:00:00Z"))).toContain("GMT-8");
    expect(timeZoneClock("America/Los_Angeles", new Date("2026-07-01T12:00:00Z"))).toContain("GMT-7");
    expect(searchTimeZones("CST").length).toBeGreaterThan(1);
    expect(searchTimeZones("UTC").some((zone) => zone.id === "UTC")).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });
});

// The browser gets the same catalogue as the terminal, through its private session.
it("serves the catalogue behind the token and preserves the suggestion source", async () => {
  const { startSetupServer } = await import("../src/cli/setup-server.js");
  const session = await startSetupServer({ open: false, exitOnEnter: false });
  try {
    const zones = await fetch(new URL("timezones", session.url));
    expect(zones.status).toBe(200);
    const catalogue = await zones.json() as { id: string; cities: string[] }[];
    expect(catalogue.find((zone) => zone.id === "America/Los_Angeles")?.cities).toContain("San Francisco");
    expect((await fetch(`${new URL(session.url).origin}/s/invalid/timezones`)).status).toBe(404);
    const pending = session.prompter.timeZone!("Asia/Tokyo", "saved");
    const stream = await fetch(new URL("events", session.url));
    const reader = stream.body!.getReader();
    let buffer = "";
    let step: { id: string; kind: string; def: string; zoneSource: string } | undefined;
    const decoder = new TextDecoder();
    try {
      while (!step) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: true });
        const match = /event: step\ndata: (.+)\n\n/.exec(buffer);
        if (match) step = JSON.parse(match[1]!);
      }
      expect(step.kind).toBe("timezone");
      expect(step.def).toBe("Asia/Tokyo");
      expect(step.zoneSource).toBe("saved");
      expect((await fetch(new URL("answer", session.url), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: step.id, value: "" }),
      })).status).toBe(204);
      expect(await pending).toBe("Asia/Tokyo");
    } finally { await reader.cancel(); }
  } finally { await session.close(); }
});
