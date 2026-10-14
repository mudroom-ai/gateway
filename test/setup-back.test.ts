import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runInit, type InitDeps, type Prompter } from "../src/cli/init.js";
import { FakeCalendarConnector } from "./helpers/fake-calendar.js";
import { startSetupServer, type SetupStep } from "../src/cli/setup-server.js";

type Answer = string | { back: true };
async function drive(url: string, answer: (step: SetupStep) => Answer | Promise<Answer>) {
  const response = await fetch(new URL("events", url));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split < 0) {
        const chunk = await reader.read();
        if (chunk.done) throw Error("Setup closed before completion");
        buffer += decoder.decode(chunk.value, { stream: true });
        continue;
      }
      const message = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (!message.includes("event: step")) continue;
      const step = JSON.parse(message.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as SetupStep;
      if (step.kind === "done") {
        expect(step.ok).toBe(true);
        expect(step.canBack).not.toBe(true);
        await fetch(new URL("done", url), { method: "POST" });
        return;
      }
      const value = await answer(step);
      const back = typeof value !== "string";
      const result = await fetch(new URL(back ? "back" : "answer", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(back ? { id: step.id } : { id: step.id, value }),
      });
      expect(result.status).toBe(204);
    }
  } finally {
    await reader.cancel();
  }
}

async function wizard(args: string[], answer: (step: SetupStep, dir: string, url: string) => Answer | Promise<Answer>, extra: InitDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-back-"));
  let driver: Promise<void> | undefined;
  let failure: unknown;
  const code = await runInit(["--web", "--dir", dir, ...args], {
    env: {}, log: () => {}, ...extra,
    startWebSetup: async (opts) => {
      const session = await startSetupServer({ ...opts, open: false, exitOnEnter: false });
      driver = drive(session.url, (step) => answer(step, dir, session.url)).catch(async (error) => {
        failure = error;
        await session.close();
      });
      return session;
    },
  });
  await driver;
  if (failure) throw failure;
  expect(code).toBe(0);
  return { dir, config: JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) };
}

const defaults = (step: SetupStep): string => step.kind === "choose" ? String(step.index ?? 0) : step.def ?? "";

describe("browser setup flags", () => {
  it("continues when --website is not a website address", async () => {
    const logs: string[] = [];
    await wizard(["--no-backend", "--website", "localhost"], (step) => step.question === "Business or your name" ? "Ace" : defaults(step), { log: (m) => logs.push(m) });
    const notes = logs.filter((line) => line.includes("Carrying on without it"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("That does not look like a website address");
  });
});

describe("browser Back navigation", () => {
  it("restores answers, skips validation attempts, and lets the final review return to editing", async () => {
    let names = 0;
    let zones = 0;
    let currencies = 0;
    let reviews = 0;
    const result = await wizard(["--no-backend"], (step, dir) => {
      if (step.question === "Your website (Enter to skip)") {
        expect(step.canBack).toBe(false);
        return "";
      }
      if (step.question === "Business or your name") {
        names++;
        if (names === 1) return "Ace";
        expect(step.def).toBe(names === 2 ? "Ace" : "Renamed");
        return names === 2 ? "Renamed" : "";
      }
      if (step.question === "Time zone") {
        zones++;
        if (zones === 1 || zones === 3) {
          expect(step.canBack).toBe(true);
          return { back: true };
        }
        return zones === 2 ? "Not/AZone" : "Europe/London";
      }
      if (step.question === "Currency") {
        currencies++;
        expect(step.def).toBe("USD");
        return currencies === 1 ? "USD" : "CAD";
      }
      if (step.question === "Save this setup?") {
        reviews++;
        expect(existsSync(join(dir, "config.json"))).toBe(false);
        expect(step.canBack).toBe(true);
        return reviews === 1 ? "1" : "0";
      }
      return defaults(step);
    });
    expect(result.config.name).toBe("Renamed");
    expect(result.config.timezone).toBe("Europe/London");
    expect(result.config.currency).toBe("CAD");
    expect(names).toBe(3);
    expect(reviews).toBe(2);
  });

  it("can go back repeatedly, change a branching choice, and reject a stale Back request", async () => {
    let businesses = 0;
    let systems = 0;
    let goals = 0;
    let staleId = "";
    const logs: string[] = [];
    await wizard(["--no-backend"], async (step, _dir, url) => {
      if (step.question === "What do you want agents to do?") {
        goals++;
        if (goals > 1) {
          expect(step.index).toBe(0);
          const stale = await fetch(new URL("back", url), {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: staleId }),
          });
          expect(stale.status).toBe(409);
        }
        return goals === 1 ? "0" : "1";
      }
      if (step.question === "Booking system") {
        systems++;
        if (systems === 2) return { back: true };
        return systems === 1 ? "0" : "1";
      }
      if (step.question === "Business or your name") {
        businesses++;
        if (businesses === 1) { staleId = step.id; return { back: true }; }
        return "Ace";
      }
      return defaults(step);
    }, { log: (line) => logs.push(line) });
    expect(goals).toBe(2);
    expect(systems).toBe(3);
    expect(logs.join("\n")).toContain("Square Appointments is not connected yet");
  });

  it("keeps secrets masked and reuses completed Square authorization when going back", async () => {
    const authorize = vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: "2030-01-01T00:00:00Z", merchantId: "merchant" }));
    const locations = vi.fn(async () => [
      { id: "one", name: "First", status: "ACTIVE", timezone: "Europe/London" },
      { id: "two", name: "Second", status: "ACTIVE", timezone: "Europe/London" },
    ]);
    let secrets = 0;
    let locationQuestions = 0;
    const result = await wizard(["--square", "--website", ""], (step) => {
      expect(JSON.stringify(step)).not.toContain("private-app-secret");
      if (step.question === "Business or your name") return "Ace";
      if (step.question === "Time zone") return "Europe/London";
      if (step.question === "Application ID") return "app";
      if (step.question === "Application secret") {
        secrets++;
        if (secrets > 1) {
          expect(step.def).toBeUndefined();
          expect(step.shown).toContain("Previously entered");
          return "";
        }
        return "private-app-secret";
      }
      if (step.question === "Book at location") {
        locationQuestions++;
        return locationQuestions === 1 ? { back: true } : "1";
      }
      return defaults(step);
    }, {
      oauth: { waitForCallback: async () => "code", obtainToken: authorize, listLocations: locations, open: () => {} },
      makeSquare: () => ({ checkAccess: async () => {}, listServices: async () => [] }),
    });
    expect(result.config.name).toBe("Ace");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(locations).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(result.dir, ".env"), "utf8")).toContain("SQUARE_LOCATION_ID='two'");
    expect(readFileSync(join(result.dir, ".env"), "utf8")).toContain("private-app-secret");
  });

  it("produces the same files as terminal setup for Google, services, hours and Slack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-parity-terminal-"));
    const keyFile = join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "test@example.com", private_key: "unused-by-fake" }));
    const args = ["--website", "", "--name", "Ace", "--timezone", "Europe/London", "--google-key-file", keyFile, "--calendar-id", "calendar", "--slack-bot-token", "xoxb-bot", "--slack-app-token", "xapp-app", "--slack-channel", "C123"];
    const values: Record<string, string> = {
      "Service 1 name": "Cut", "Duration (minutes)": "30", "Buffer after (minutes)": "5", "Price (USD)": "40",
    };
    const terminal: Prompter = {
      ask: async (q, def) => values[q.trim()] ?? def ?? "",
      choose: async (_q, _items, def) => def ?? 0,
      confirm: async () => false,
      secret: async () => "",
      close: () => {},
    };
    const extra: InitDeps = { makeConnector: () => new FakeCalendarConnector(), makeSlack: () => ({ checkAccess: async () => {} }) };
    expect(await runInit(["--dir", dir, ...args], { env: {}, log: () => {}, prompter: terminal, ...extra })).toBe(0);
    const web = await wizard(args, (step) => step.kind === "confirm" ? "no" : values[step.question!.trim()] ?? defaults(step), extra);
    expect(readFileSync(join(web.dir, "config.json"), "utf8")).toBe(readFileSync(join(dir, "config.json"), "utf8"));
    expect(readFileSync(join(web.dir, ".env"), "utf8")).toBe(readFileSync(join(dir, ".env"), "utf8"));
  });

  it("does not repeat the website crawl or model request when returning past them", async () => {
    const crawl = vi.fn(async () => ({ url: "https://example.com/", pages: [{ url: "https://example.com/", title: "Salon", text: "Salon" }], jsonLd: [] }));
    const extract = vi.fn(async () => ({ business: { name: "Salon" }, services: [] }));
    let goals = 0;
    let providers = 0;
    const result = await wizard(["--no-backend"], (step) => {
      if (step.question === "Your website (Enter to skip)") return "https://example.com/";
      if (step.question === "Read the pages with") { providers++; return "0"; }
      if (step.question === "What do you want agents to do?") {
        goals++;
        return goals === 1 ? { back: true } : "0";
      }
      return defaults(step);
    }, { website: { crawl, detect: () => [{ kind: "claude", label: "Claude Code", status: "found", bin: "/fake/claude" }], extract } });
    expect(providers).toBe(2);
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(result.config.name).toBe("Salon");
  });

});
