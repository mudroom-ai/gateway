// Browser setup for `npm run init`. A page on 127.0.0.1 implements Prompter, so
// runInit still decides every question, validates it, and writes the files.
// The token in the URL is the only way to reach the page; nothing else on the
// machine should be able to answer the wizard by guessing a port.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./guide.js";
import type { Prompter } from "./init.js";
import type { PickItem } from "./picker.js";

export interface SetupStep {
  id: string;
  kind: "ask" | "confirm" | "choose" | "done";
  question?: string;
  /** Ask: the value an empty answer keeps. Omitted when it must not be shown. */
  def?: string;
  /** Ask: text to show in place of `def` (a secret stays out of the page). */
  shown?: string;
  secret?: boolean;
  items?: PickItem[];
  description?: string[];
  /** Choose: the pre-selected row. */
  index?: number;
  /** Choose: the row Esc answers with. */
  cancel?: number;
  /** Done: false when the wizard stopped with an error. */
  ok?: boolean;
}

export interface WebSetup {
  url: string;
  prompter: Prompter;
  pushLog(text: string): void;
  markDone(ok: boolean): void;
  waitForExit(): Promise<void>;
  close(): Promise<void>;
}

export interface SetupServerOptions {
  /** Called with the page URL when `open` is not false. Default: the system browser. */
  openUrl?: (url: string) => void;
  /** Open the page. Default true. Tests pass false. */
  open?: boolean;
  /** Resolve `waitForExit` when the terminal reads a line. Default: stdin is a TTY. */
  exitOnEnter?: boolean;
  /** Directory of index.html, app.css and app.js. Default: beside this module. */
  uiDir?: string;
}

const FILES: Record<string, { name: string; type: string }> = {
  "": { name: "index.html", type: "text/html; charset=utf-8" },
  "index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "app.css": { name: "app.css", type: "text/css; charset=utf-8" },
  "app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
};

const MAX_BODY = 64 * 1024;
const MAX_LOGS = 500;

/** Drop ANSI colour codes so the page shows the same sentences as the terminal. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function abortError(): Error {
  const e = new Error("Aborted.");
  (e as { code?: string }).code = "ABORT_ERR";
  return e;
}

function sameToken(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    n += buf.length;
    if (n > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function end(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/** Bind a setup page on 127.0.0.1 and return the prompter the wizard should use. */
export function startSetupServer(opts: SetupServerOptions = {}): Promise<WebSetup> {
  const token = randomBytes(32).toString("base64url");
  const uiDir = opts.uiDir ?? fileURLToPath(new URL("./setup-ui/", import.meta.url));
  const logs: string[] = [];
  const clients = new Set<ServerResponse>();
  let current: SetupStep | undefined;
  let seq = 0;
  let pending: { id: string; resolve: (value: string) => void; reject: (err: Error) => void } | undefined;
  let exitResolve: (() => void) | undefined;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  const exitNow = () => {
    if (exited) return;
    exited = true;
    exitResolve?.();
  };

  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) sendEvent(res, event, data);
  };

  const failPending = (err: Error) => {
    const waiting = pending;
    pending = undefined;
    current = undefined;
    waiting?.reject(err);
  };

  const request = (step: Omit<SetupStep, "id">): Promise<string> => {
    if (pending) return Promise.reject(new Error("setup page already has a question open"));
    const id = String(++seq);
    const full: SetupStep = { ...step, id };
    current = full;
    return new Promise<string>((resolve, reject) => {
      pending = { id, resolve, reject };
      broadcast("step", full);
    });
  };

  const prompter: Prompter = {
    async ask(q, def, shown) {
      const masked = shown === "from .env";
      const value = (await request({
        kind: "ask",
        question: q,
        secret: masked,
        ...(masked ? { shown } : { ...(def !== undefined && def !== "" ? { def } : {}), ...(shown ? { shown } : {}) }),
      })).trim();
      return value || def || "";
    },
    async confirm(q) {
      return (await request({ kind: "confirm", question: q })) === "yes";
    },
    async choose(q, items, def = 0, description, cancel) {
      const value = await request({
        kind: "choose",
        question: q,
        items,
        index: def,
        ...(description?.length ? { description } : {}),
        ...(cancel !== undefined ? { cancel } : {}),
      });
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n >= items.length) throw new Error(`invalid choice "${value}"`);
      return n;
    },
    async secret(q) {
      return (await request({ kind: "ask", question: q, secret: true })).trim();
    },
    close() {},
  };

  const pushLog = (text: string) => {
    const clean = stripAnsi(text);
    logs.push(clean);
    if (logs.length > MAX_LOGS) logs.shift();
    broadcast("log", { text: clean });
  };

  const markDone = (ok: boolean) => {
    current = { id: "done", kind: "done", ok };
    broadcast("step", current);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) end(res, 400, "bad request");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      end(res, 404);
      return;
    }
    if (!url.pathname.startsWith("/s/")) {
      end(res, 404);
      return;
    }
    const rest = url.pathname.slice("/s/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      if (!sameToken(rest, token)) {
        end(res, 404);
        return;
      }
      res.writeHead(302, { Location: `/s/${token}/`, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const got = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (!sameToken(got, token)) {
      end(res, 404);
      return;
    }
    if (req.method === "GET" && path === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      sendEvent(res, "hello", {});
      for (const text of logs) sendEvent(res, "log", { text });
      if (current) sendEvent(res, "step", current);
      clients.add(res);
      res.on("error", () => clients.delete(res));
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && path === "answer") {
      const body = JSON.parse(await readBody(req)) as { id?: unknown; value?: unknown };
      if (!pending || typeof body.id !== "string" || body.id !== pending.id || typeof body.value !== "string") {
        end(res, 409, "that question is no longer waiting");
        return;
      }
      const waiting = pending;
      pending = undefined;
      current = undefined;
      waiting.resolve(body.value);
      end(res, 204);
      return;
    }
    if (req.method === "POST" && path === "done") {
      exitNow();
      end(res, 204);
      return;
    }
    if (req.method === "GET" && FILES[path]) {
      const file = FILES[path];
      const filePath = join(uiDir, file.name);
      if (!existsSync(filePath)) {
        end(res, 404);
        return;
      }
      res.writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        "Referrer-Policy": "no-referrer",
      });
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) end(res, 404);
        else res.destroy();
      });
      stream.pipe(res);
      return;
    }
    end(res, 404);
  }

  const beat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(": ping\n\n");
      } catch {
        clients.delete(res);
      }
    }
  }, 15_000);
  beat.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("setup server did not bind"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}/s/${token}/`;
      if (opts.open !== false) (opts.openUrl ?? openBrowser)(url);
      resolve({
        url,
        prompter,
        pushLog,
        markDone,
        async waitForExit() {
          const listen = opts.exitOnEnter ?? !!process.stdin.isTTY;
          if (!listen) {
            await exitPromise;
            return;
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const onLine = () => exitNow();
          rl.once("line", onLine);
          try {
            await exitPromise;
          } finally {
            rl.close();
          }
        },
        async close() {
          clearInterval(beat);
          exitNow();
          failPending(abortError());
          if (!server.listening) return;
          await new Promise<void>((done, rejectClose) => server.close((err) => (err ? rejectClose(err) : done())));
        },
      });
    });
  });
}
