// Arrow-key single-select for the setup wizard, in the style of the Hermes
// `hermes setup gateway` platform picker: bold title, dim key hint, one row per
// item with an emoji, a label and a plain status in parentheses, the cursor row
// in green with a "→" and a "(●)" radio glyph. Built-ins only: raw-mode stdin
// and ANSI escapes, no curses, no dependency.
//
// Rendering is a pure function (`renderPicker`) so it is testable; `pick` owns
// the terminal. When stdin cannot enter raw mode, stdout is not a terminal or
// TERM=dumb, `pick` falls back to a numbered list read through readline, the
// same way Hermes falls back when curses is unavailable.

import { createInterface } from "node:readline/promises";

export interface PickItem {
  label: string;
  /** Shown before the label. Emoji are fine: rows are not column-aligned, so width does not matter. */
  emoji?: string;
  /** Plain text, shown as `(status)` after the label. Keep it uncolored. */
  status?: string;
}

export interface PickOptions {
  /** Lines shown between the title and the key hint. */
  description?: string[];
  /** The row ESC answers with, when backing out must not mean the pre-selected row. Default: `def`. */
  cancel?: number;
  /** Force colour on or off; default: follow the terminal (NO_COLOR, TERM=dumb, isTTY). */
  color?: boolean;
  /** Test hook: the raw-mode stream to read keys from and the stream to draw on. */
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
  /** Test hook: environment to read TERM from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;

export const PICK_HINT = "  ↑↓ navigate  ENTER/SPACE select  ESC keep default";
/** The key hint when ESC answers with a row of its own (`cancel`), named by that row's label: "ESC skip". */
const cancelHint = (label: string): string => PICK_HINT.replace("keep default", label.toLowerCase());

export function shouldUseColor(stdout: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  return !!stdout.isTTY;
}

function paint(text: string, codes: string, on: boolean): string {
  return on ? `${codes}${text}${RESET}` : text;
}

/** The picker's palette for plain text prompts, so every question in the wizard reads the same way. */
export const style = {
  /** A question: bold yellow, like the picker title. */
  question: (s: string, on = shouldUseColor()) => paint(s, BOLD + YELLOW, on),
  /** A default value, a key hint or a section note: dim. */
  dim: (s: string, on = shouldUseColor()) => paint(s, DIM, on),
  /** The chosen answer echoed back: green. */
  answer: (s: string, on = shouldUseColor()) => paint(s, GREEN, on),
};

export function itemText(item: PickItem): string {
  const parts = [item.emoji, item.label].filter((s): s is string => !!s);
  let s = parts.join(" ");
  if (item.status) s += `  (${item.status})`;
  return s;
}

/** The lines a picker frame is made of. `selected` is the pre-selected (default) row, `cursor` the highlighted one. */
export function renderPicker(title: string, items: PickItem[], cursor: number, selected: number, opts: { color: boolean; description?: string[]; cancel?: number }): string[] {
  const lines: string[] = [paint(title, BOLD + YELLOW, opts.color)];
  for (const d of opts.description ?? []) lines.push(paint(d, DIM, opts.color));
  const cancelItem = opts.cancel !== undefined && opts.cancel !== selected ? items[opts.cancel] : undefined;
  lines.push(paint(cancelItem ? cancelHint(cancelItem.label) : PICK_HINT, DIM, opts.color));
  lines.push("");
  items.forEach((item, i) => {
    const isCursor = i === cursor;
    const row = ` ${isCursor ? "→" : " "} (${i === selected ? "●" : "○"}) ${itemText(item)}`;
    lines.push(isCursor ? paint(row, BOLD + GREEN, opts.color) : row);
  });
  return lines;
}

/** Terminal cell width of one code point: 0 for combining marks and variation selectors, 2 for East Asian wide and emoji, else 1. */
export function charWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/**
 * Clip a line to `cols` terminal cells so it never wraps (what curses' addnstr
 * does for Hermes). ANSI escapes are kept and take no width; a reset is
 * appended if anything was cut so colour does not leak onto the next row.
 */
export function clipToWidth(line: string, cols: number): string {
  let out = "";
  let width = 0;
  let i = 0;
  while (i < line.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(line);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (width + w > cols) return out + RESET;
    out += ch;
    width += w;
    i += ch.length;
  }
  return out;
}

export type PickKey = "up" | "down" | "select" | "cancel" | "interrupt" | { jump: number } | null;

/** A lone ESC byte waits this long for the rest of an arrow sequence (SSH and tmux can split one keypress across reads). */
export const ESC_WAIT_MS = 50;

// A whole CSI (`ESC [ params final`) or SS3 (`ESC O x`) sequence, else a lone ESC, else one character. Delete,
// Home, PageUp and modified arrows (`ESC [ 3 ~`, `ESC [ 1 ; 5 A`) must stay whole: split, their ESC would read as cancel.
const KEY_SEQ_RE = /\x1b\[[0-9;?<>=:]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b(?:\[[0-9;?<>=:]*|O)?$|\x1b|[\s\S]/g;
/** An escape prefix with no final byte yet: "ESC", "ESC [", "ESC [ 1 ;", "ESC O". Only ever the last piece of a read. */
const INCOMPLETE_SEQ_RE = /^\x1b(?:\[[0-9;?<>=:]*|O)?$/;
/** Longest escape prefix worth waiting for; anything longer is not a key and is flushed byte by byte. */
const MAX_HELD = 16;

/** Split one raw read into key sequences: a paste of several keys, or an arrow sequence glued to a following key. */
export function splitKeys(buf: string): string[] {
  return buf.match(KEY_SEQ_RE) ?? [];
}

/** Decode one raw-mode read into a picker action. */
export function decodeKey(buf: string): PickKey {
  switch (buf) {
    case "\x1b[A":
    case "\x1bOA":
    case "k":
      return "up";
    case "\x1b[B":
    case "\x1bOB":
    case "j":
      return "down";
    case "\r":
    case "\n":
    case " ":
      return "select";
    case "\x1b":
    case "q":
      return "cancel";
    case "\x03":
      return "interrupt";
    default:
      if (/^[1-9]$/.test(buf)) return { jump: Number(buf) - 1 };
      return null;
  }
}

/**
 * Show the picker and resolve with the chosen index. ESC resolves with `def`
 * (the question is skipped, keeping the default) unless `opts.cancel` names
 * another row, Ctrl+C exits the process like it does on a readline prompt. On
 * return the frame is erased and one summary line is left in the transcript.
 */
export async function pick(title: string, items: PickItem[], def = 0, opts: PickOptions = {}): Promise<number> {
  const cancel = opts.cancel !== undefined && opts.cancel >= 0 && opts.cancel < items.length ? opts.cancel : def;
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const color = opts.color ?? shouldUseColor(stdout, env);
  // Cursor addressing needs a terminal on both ends: with stdout piped (`npm run init | tee log`) or a dumb
  // terminal the erase/redraw escapes would pile up as stacked frames, so use the numbered list instead.
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function" || !stdout.isTTY || env.TERM === "dumb") {
    return pickNumbered(title, items, def, { stdin, stdout, color, description: opts.description });
  }

  let cursor = Math.min(Math.max(def, 0), items.length - 1);
  let drawn = 0;
  const draw = () => {
    // Clip to the terminal width: a wrapped line takes two rows, which would
    // throw off the cursor-up count on the next redraw and leave old frames behind.
    const cols = Math.max(20, stdout.columns || 80);
    const lines = renderPicker(title, items, cursor, def, { color, description: opts.description, cancel }).map((l) => clipToWidth(l, cols - 1));
    stdout.write((drawn ? `${ESC}${drawn}A${ESC}0J` : "") + lines.join("\n") + "\n");
    drawn = lines.length;
  };
  // A resize rewraps what is on screen; our row count no longer matches, so clear it all and redraw from scratch.
  const onResize = () => {
    stdout.write(`${ESC}${drawn}A${ESC}0J`);
    drawn = 0;
    draw();
  };

  const wasRaw = stdin.isRaw;
  // If the process dies while the frame is up (uncaught error elsewhere, EPIPE), bring the cursor back.
  const showCursorOnExit = () => stdout.write(`${ESC}?25h`);
  try {
    process.once("exit", showCursorOnExit);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(`${ESC}?25l`);
    draw();
    return await new Promise<number>((resolve) => {
      let done = false;
      let pendingEsc: NodeJS.Timeout | undefined;
      const handle = (seq: string) => {
        if (done) return;
        const key = decodeKey(seq);
        if (key === null) return;
        if (key === "interrupt") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (key === "up") cursor = (cursor - 1 + items.length) % items.length;
        else if (key === "down") cursor = (cursor + 1) % items.length;
        else if (typeof key === "object") {
          if (key.jump < items.length) cursor = key.jump;
        } else {
          cleanup();
          resolve(key === "select" ? cursor : cancel);
          return;
        }
        draw();
      };
      let held = ""; // an unfinished escape sequence waiting for the rest of its bytes
      const onData = (chunk: Buffer | string) => {
        if (pendingEsc) {
          clearTimeout(pendingEsc);
          pendingEsc = undefined;
        }
        const seqs = splitKeys(held + chunk.toString());
        held = "";
        // Ctrl+C wins over anything buffered around it, including a held ESC that would otherwise resolve first.
        if (seqs.includes("\x03")) return handle("\x03");
        const last = seqs.at(-1);
        if (last !== undefined && last.length <= MAX_HELD && INCOMPLETE_SEQ_RE.test(last)) {
          // A lone ESC is cancel, but over SSH or tmux an arrow key can arrive as "\x1b", "[", "B". Hold the
          // prefix for ESC_WAIT_MS; if nothing follows it was separate keys: ESC cancels, the rest is ignored.
          held = last;
          seqs.pop();
          pendingEsc = setTimeout(() => {
            pendingEsc = undefined;
            const flushed = held;
            held = "";
            for (const ch of flushed) handle(ch);
          }, ESC_WAIT_MS);
        }
        for (const seq of seqs) handle(seq);
      };
      const cleanup = () => {
        done = true;
        if (pendingEsc) clearTimeout(pendingEsc);
        stdin.off("data", onData);
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      };
      stdin.on("data", onData);
      stdout.on("resize", onResize);
    });
  } finally {
    stdout.off("resize", onResize);
    process.off("exit", showCursorOnExit);
    stdout.write(`${ESC}?25h`);
  }
}

async function pickNumbered(
  title: string,
  items: PickItem[],
  def: number,
  o: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; color: boolean; description?: string[] },
): Promise<number> {
  o.stdout.write(paint(title, YELLOW, o.color) + "\n");
  for (const d of o.description ?? []) o.stdout.write(paint(d, DIM, o.color) + "\n");
  items.forEach((item, i) => {
    const row = `  ${i === def ? "●" : "○"} ${i + 1}. ${itemText(item)}`;
    o.stdout.write((i === def ? paint(row, GREEN, o.color) : row) + "\n");
  });
  // terminal:false keeps readline from drawing its own line-editing escapes: this path exists for pipes and
  // dumb terminals, which is exactly where those escapes would land as junk. Cooked-mode TTYs echo input themselves.
  const rl = createInterface({ input: o.stdin, output: o.stdout, terminal: false });
  try {
    for (;;) {
      const a = (await rl.question(paint(`  Select [1-${items.length}] (${def + 1}): `, DIM, o.color))).trim();
      if (!a) return def;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
      o.stdout.write(`  Please enter a number between 1 and ${items.length}\n`);
    }
  } finally {
    rl.close();
  }
}
