import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.js";
import { askSetupMode } from "../src/cli/setup-mode.js";
import { startSetupServer, type SetupStep } from "../src/cli/setup-server.js";
import { ScriptedPrompter } from "./helpers/scripted-prompter.js";

const ANSWERS = ["", "", "", "Not yet, finish later", "Ace", "Not/AZone", "America/Los_Angeles", ""];

/** The same answer list ScriptedPrompter accepts, posted to the setup page as each question appears. */
async function driveSetup(url: string, answers: (string | boolean)[]): Promise<string[]> {
  const queue = [...answers];
  const seen: string[] = [];
  const res = await fetch(new URL("events", url));
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const take = async (): Promise<{ event: string; data: string } | null> => {
    for (;;) {
      const split = buf.indexOf("\n\n");
      if (split >= 0) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        if (raw.startsWith(":")) continue;
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        return { event, data };
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buf += dec.decode(chunk.value, { stream: true });
    }
  };
  try {
    for (;;) {
      const msg = await take();
      if (!msg) throw new Error("setup event stream closed");
      if (msg.event === "log") {
        seen.push(JSON.parse(msg.data).text as string);
        continue;
      }
      if (msg.event !== "step") continue;
      const step = JSON.parse(msg.data) as SetupStep;
      if (step.kind === "done") {
        await fetch(new URL("done", url), { method: "POST" }).catch(() => {});
        return seen;
      }
      if (!queue.length) throw new Error(`ran out of answers at "${step.question}"`);
      const raw = queue.shift()!;
      const posted = await fetch(new URL("answer", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: step.id, value: valueFor(step, raw) }),
      });
      if (!posted.ok) throw new Error(`answer ${posted.status} for "${step.question}"`);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function valueFor(step: SetupStep, raw: string | boolean): string {
  if (step.kind === "confirm") {
    if (typeof raw !== "boolean") throw new Error(`"${step.question}" wants a boolean`);
    return raw ? "yes" : "no";
  }
  if (typeof raw !== "string") throw new Error(`"${step.question}" wants a string`);
  if (step.kind !== "choose") return raw;
  const items = step.items ?? [];
  const def = step.index ?? 0;
  const a = raw.trim();
  if (!a) return String(def);
  if (a === "<esc>") return String(step.cancel ?? def);
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return String(n - 1);
  const i = items.findIndex((it) => it.label === a);
  if (i < 0) throw new Error(`"${step.question}" has no item ${JSON.stringify(a)}`);
  return String(i);
}

async function readStep(url: string): Promise<SetupStep> {
  const res = await fetch(new URL("events", url));
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const split = buf.indexOf("\n\n");
      if (split >= 0) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        if (!raw.startsWith(":") && raw.includes("event: step")) {
          const data = raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!data) throw new Error("step without data");
          return JSON.parse(data) as SetupStep;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream closed before a step");
      buf += dec.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("browser setup", () => {
  it("defaults to the terminal and can choose the browser", async () => {
    expect(await askSetupMode(new ScriptedPrompter([""]))).toBe("terminal");
    expect(await askSetupMode(new ScriptedPrompter(["Complete setup in the browser"]))).toBe("web");
  });

  it("writes the same files as the terminal wizard, and a bad answer can be corrected", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "gw-web-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "gw-web-b-"));
    const codeA = await runInit(["--dir", dirA], { env: {}, prompter: new ScriptedPrompter(ANSWERS), log: () => {} });
    const logs: string[] = [];
    let driveError: unknown;
    const codeB = await runInit(["--web", "--dir", dirB], {
      env: {},
      log: (m) => logs.push(m),
      startWebSetup: async (opts) => {
        const session = await startSetupServer({ openUrl: opts.openUrl, open: false, exitOnEnter: false });
        void driveSetup(session.url, [...ANSWERS.map((value) => value === "Not yet, finish later" ? "Finish later" : value), ""]).catch((err) => {
          driveError = err;
          return session.close();
        });
        return session;
      },
    });
    if (driveError) throw driveError;
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(readFileSync(join(dirB, "config.json"), "utf8")).toBe(readFileSync(join(dirA, "config.json"), "utf8"));
    expect(readFileSync(join(dirB, ".env"), "utf8")).toBe(readFileSync(join(dirA, ".env"), "utf8"));
    expect(logs.join("\n")).toContain("is not an IANA time zone");
    expect(logs.join("\n")).toContain("Opening the setup page");
    expect(logs.join("\n")).toContain("Setup finished");
  });

  it("replays the open question, hides a saved secret, and refuses a bad token", async () => {
    const session = await startSetupServer({ open: false, exitOnEnter: false });
    try {
      const pending = session.prompter.ask("Application secret", "super-secret", "from .env");
      const first = await readStep(session.url);
      const again = await readStep(session.url);
      expect(again).toEqual(first);
      expect(first.kind).toBe("ask");
      expect(first.secret).toBe(true);
      expect(JSON.stringify(first)).not.toContain("super-secret");
      const stale = await fetch(new URL("answer", session.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "nope", value: "" }),
      });
      expect(stale.status).toBe(409);
      const ok = await fetch(new URL("answer", session.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: first.id, value: "" }),
      });
      expect(ok.status).toBe(204);
      expect(await pending).toBe("super-secret");

      const page = await fetch(session.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Mudroom setup");
      const css = await fetch(new URL("app.css", session.url));
      expect(await css.text()).toContain("--background: #ffffff");
      const origin = `http://127.0.0.1:${new URL(session.url).port}`;
      expect((await fetch(`${origin}/s/not-the-token/`)).status).toBe(404);
      expect((await fetch(`${origin}/nope`)).status).toBe(404);

      session.pushLog("\x1b[2mdim line\x1b[0m");
      const logged = await readLog(session.url);
      expect(logged).toBe("dim line");
      expect(logged).not.toContain("\x1b");

      const confirm = session.prompter.confirm("Run the write test?");
      const confirmStep = await readStep(session.url);
      expect(confirmStep.kind).toBe("confirm");
      expect((await fetch(new URL("answer", session.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: confirmStep.id, value: "no" }),
      })).status).toBe(204);
      expect(await confirm).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("ignores --web when answers come from flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-web-skip-"));
    const logs: string[] = [];
    const code = await runInit(["--non-interactive", "--web", "--no-backend", "--dir", dir, "--name", "Ace", "--service", "Cut:30:0:10"], {
      env: {},
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("--web is ignored with --non-interactive");
  });
});

async function readLog(url: string): Promise<string> {
  const res = await fetch(new URL("events", url));
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const split = buf.indexOf("\n\n");
      if (split >= 0) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        if (raw.includes("event: log")) {
          const data = raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!data) throw new Error("log without data");
          return JSON.parse(data).text as string;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream closed before a log");
      buf += dec.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
