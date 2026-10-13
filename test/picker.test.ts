import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  charWidth,
  clipToWidth,
  decodeKey,
  itemText,
  pick,
  renderPicker,
  shouldUseColor,
  splitKeys,
  type PickItem,
} from "../src/cli/picker.js";

const ITEMS = [
  { emoji: "📅", label: "Google Calendar", status: "not configured" },
  { emoji: "⬛", label: "Square Appointments", status: "configured" },
];

describe("picker", () => {
  it("renders Hermes-style rows: arrow on the cursor, radio on the default, status in parens", () => {
    const lines = renderPicker("Booking system", ITEMS, 1, 0, { color: false });
    expect(lines[0]).toBe("Booking system");
    expect(lines[1]).toContain("↑↓ navigate");
    expect(lines.slice(3)).toEqual([
      "   (●) 📅 Google Calendar  (not configured)",
      " → (○) ⬛ Square Appointments  (configured)",
    ]);
  });

  it("colours only the title, hint and cursor row", () => {
    const lines = renderPicker("Q", ITEMS, 0, 0, { color: true, description: ["why"] });
    expect(lines[0]).toBe("\x1b[1m\x1b[33mQ\x1b[0m");
    expect(lines[1]).toBe("\x1b[2mwhy\x1b[0m");
    expect(lines[4]).toMatch(/^\x1b\[1m\x1b\[32m → \(●\)/);
    expect(lines[5]).not.toContain("\x1b[");
  });

  it("keeps status uncoloured and omits the parens when there is none", () => {
    expect(itemText({ label: "Plain" })).toBe("Plain");
  });

  it("decodes arrows, vi keys, enter/space, esc, digits and ctrl-c", () => {
    expect(decodeKey("\x1b[A")).toBe("up");
    expect(decodeKey("j")).toBe("down");
    expect(decodeKey("\r")).toBe("select");
    expect(decodeKey(" ")).toBe("select");
    expect(decodeKey("\x1b")).toBe("cancel");
    expect(decodeKey("3")).toEqual({ jump: 2 });
    expect(decodeKey("\x03")).toBe("interrupt");
    expect(decodeKey("x")).toBeNull();
  });

  it("honours NO_COLOR, TERM=dumb and non-TTY output", () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
  });

  it("clips rows to the terminal width so they never wrap, counting emoji as two cells", () => {
    expect(clipToWidth("abcdef", 4)).toBe("abcd\x1b[0m");
    expect(clipToWidth("📅 Google", 4)).toBe("📅 G\x1b[0m");
    expect(clipToWidth("\x1b[32mabcdef\x1b[0m", 3)).toBe("\x1b[32mabc\x1b[0m");
    expect(clipToWidth("short", 10)).toBe("short");
    expect(charWidth("→".codePointAt(0)!)).toBe(1);
    expect(charWidth("⬛".codePointAt(0)!)).toBe(2);
  });
});

// ---------- pick(): the raw-mode loop and the non-TTY fallback, through the `io` test hook ----------

/** A stdin that claims to be a raw-mode-capable TTY and records what the picker does to it. */
function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    rawCalls: [] as boolean[],
    setRawMode(on: boolean) {
      this.isRaw = on;
      this.rawCalls.push(on);
      return this;
    },
    resume() {},
    pause() {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    out: "",
    write(s: string) {
      this.out += s;
      return true;
    },
  });
  const io = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream };
  /** Feed keystrokes one raw read at a time, after the picker has subscribed. */
  const type = (...keys: string[]) => queueMicrotask(() => keys.forEach((k) => stdin.emit("data", Buffer.from(k))));
  return { stdin, stdout, io, type };
}

describe("pick() on a raw-mode terminal", () => {
  // protects: arrow keys move the cursor with wrap-around and Enter resolves with the cursor row,
  //   restoring the terminal (raw mode off, cursor shown, frame erased) on the way out.
  // fails_when: the modulo wrap is dropped (down from the last row stays or throws), Enter
  //   resolves with `def` instead of the cursor, or cleanup forgets setRawMode(false)/?25h.
  // why_new: picker.test.ts only covers the pure helpers (renderPicker, decodeKey, ...); the
  //   event loop in pick() that turns keys into a result had no test.
  // seam: none (the `io` option is the picker's own documented test hook).
  it("wraps with the arrows, Enter selects the cursor row, and the terminal is restored", async () => {
    const { stdin, stdout, io, type } = fakeTty();
    type("\x1b[B", "\x1b[B", "\x1b[B", "\r"); // down x3 from row 0 of 3 wraps back to row 0; then up-less Enter
    const first = pick("Q", [...ITEMS, { label: "Third" }] as PickItem[], 0, { io, color: false });
    const a = await first;
    expect(a).toBe(0);

    const t2 = fakeTty();
    t2.type("\x1b[A", "\r"); // up from row 0 wraps to the last row
    expect(await pick("Q", ITEMS, 0, { io: t2.io, color: false })).toBe(1);

    expect(stdin.rawCalls).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(stdout.out).toContain("\x1b[?25l"); // cursor hidden while the frame is up
    expect(stdout.out.endsWith("\x1b[?25h")).toBe(true); // and shown again
    expect(stdout.out).toContain("→ (●) 📅 Google Calendar"); // the frame was actually drawn
  });

  // protects: ESC resolves with the pre-selected default even after the cursor moved; a digit
  //   jumps to that row (and is ignored when out of range); unknown keys are ignored.
  // fails_when: cancel resolves with the cursor, `jump` is not bounds-checked (an out-of-range digit
  //   followed directly by Enter resolves with the out-of-range index instead of the cursor), or an
  //   unknown key is treated as select.
  // why_new: decodeKey is tested in isolation, but how pick() acts on "cancel", {jump} and null was not;
  //   the `9, x, 2, Enter` sequence alone passed with the bounds check removed because `2` overwrote
  //   the cursor, so `9, Enter` is now asserted on its own.
  // seam: none.
  it("ESC keeps the default, digits jump, out-of-range digits and unknown keys do nothing", async () => {
    const esc = fakeTty();
    esc.type("\x1b[B", "\x1b"); // move, then ESC
    expect(await pick("Q", ITEMS, 0, { io: esc.io, color: false })).toBe(0);
    expect(esc.stdout.out).toContain("ESC keep default");

    // With a cancel row, ESC answers with it instead of the default, and the hint names it.
    const back = fakeTty();
    back.type("\x1b");
    expect(await pick("Q", ITEMS, 0, { io: back.io, color: false, cancel: 1 })).toBe(1);
    expect(back.stdout.out).toContain(`ESC ${ITEMS[1]!.label.toLowerCase()}`);
    expect(back.stdout.out).not.toContain("ESC keep default");

    const jump = fakeTty();
    jump.type("9", "x", "2", "\r"); // 9 is out of range for 2 items, x is not a key, 2 jumps to the second row
    expect(await pick("Q", ITEMS, 0, { io: jump.io, color: false })).toBe(1);

    const outOfRange = fakeTty();
    outOfRange.type("9", "\r"); // nothing overwrites the cursor afterwards: Enter must resolve with the unchanged row
    expect(await pick("Q", ITEMS, 0, { io: outOfRange.io, color: false })).toBe(0);
  });

  // protects: an arrow key that arrives as two reads ("\x1b" then "[B", as SSH and tmux deliver it) moves
  //   the cursor instead of cancelling; a paste of several keys in one read is handled key by key; a lone
  //   ESC with nothing following still cancels.
  // fails_when: a bare "\x1b" chunk is treated as cancel immediately (the arrow silently keeps the default),
  //   or a multi-key chunk decodes to null and is dropped.
  // why_new: pick() assumed one key per read; no test covered split or glued sequences.
  // seam: none.
  it("handles arrow keys split across reads and several keys in one read; a lone ESC still cancels", async () => {
    const split = fakeTty();
    split.type("\x1b", "[B", "\r");
    expect(await pick("Q", ITEMS, 0, { io: split.io, color: false })).toBe(1);
    const split3 = fakeTty();
    split3.type("\x1b", "[", "B", "\r"); // three reads: the "ESC [" prefix is held too
    expect(await pick("Q", ITEMS, 0, { io: split3.io, color: false })).toBe(1);

    const pasted = fakeTty();
    pasted.type("\x1b[B\x1b[B\x1b[B\r"); // three downs on two items end on row 1
    expect(await pick("Q", ITEMS, 0, { io: pasted.io, color: false })).toBe(1);

    const lone = fakeTty();
    lone.type("\x1b[B", "\x1b"); // move, then ESC with nothing after it: resolves with the default after the short wait
    expect(await pick("Q", ITEMS, 0, { io: lone.io, color: false })).toBe(0);

    expect(splitKeys("\x1b[A\x1bOB9\x1b\r")).toEqual(["\x1b[A", "\x1bOB", "9", "\x1b", "\r"]);
    // Delete, Home and Ctrl+Up stay whole (and decode to nothing) instead of leaking a lone ESC that would cancel.
    expect(splitKeys("\x1b[3~\x1b[1~\x1b[1;5A")).toEqual(["\x1b[3~", "\x1b[1~", "\x1b[1;5A"]);
    expect(splitKeys("9\x1b[1;")).toEqual(["9", "\x1b[1;"]); // an unfinished prefix stays one piece
    expect(splitKeys("\x1b[<35;10;5M\x1b[>0;95;0c")).toEqual(["\x1b[<35;10;5M", "\x1b[>0;95;0c"]); // mouse / DA2 replies
    // An ESC prefix with no final byte: ESC was a real cancel, the stray "[" is ignored (not turned into a jump or a wait forever).
    const timedOut = fakeTty();
    timedOut.type("\x1b[B", "\x1b[");
    expect(await pick("Q", ITEMS, 0, { io: timedOut.io, color: false })).toBe(0);
    // Ctrl+C inside the ESC window still exits 130 instead of being swallowed by the held ESC.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const ctrlC = fakeTty();
      ctrlC.type("\x1b", "\x03");
      await pick("Q", ITEMS, 0, { io: ctrlC.io, color: false });
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
    }
    for (const seq of ["\x1b[3~", "\x1b[1~", "\x1b[1;5A"]) expect(decodeKey(seq)).toBeNull();
  });

  // protects: while the frame is up a process "exit" listener restores the cursor, and it is removed again
  //   on a normal return so listeners do not accumulate across questions.
  // fails_when: the listener is never registered (a crash mid-picker leaves the shell without a cursor) or
  //   never removed (MaxListenersExceeded after many prompts).
  // why_new: only the Ctrl+C path restored the terminal; other exits were not covered.
  // seam: none.
  it("registers a cursor-restoring exit handler only while the picker is up", async () => {
    const before = process.listenerCount("exit");
    const { io, type } = fakeTty();
    const p = pick("Q", ITEMS, 0, { io, color: false });
    await new Promise((r) => setImmediate(r));
    expect(process.listenerCount("exit")).toBe(before + 1);
    type("\r");
    await p;
    expect(process.listenerCount("exit")).toBe(before);
    // When raw mode cannot be entered after all, the listener does not leak either.
    const broken = fakeTty();
    broken.stdin.setRawMode = () => {
      throw new Error("ENOTTY");
    };
    await expect(pick("Q", ITEMS, 0, { io: broken.io, color: false })).rejects.toThrow("ENOTTY");
    expect(process.listenerCount("exit")).toBe(before);
  });

  // protects: Ctrl+C restores the terminal and exits with 130, like a readline prompt.
  // fails_when: the interrupt branch is removed so Ctrl+C is swallowed by raw mode and the wizard hangs.
  // why_new: no test exercised the interrupt path.
  // seam: none (process.exit is stubbed with vi.spyOn in the test only).
  it("Ctrl+C restores raw mode and exits 130", async () => {
    const { stdin, io, type } = fakeTty();
    let exitedWith: number | undefined;
    // The real exit never returns; the stub does, so the handler falls through and resolves. Only the first
    // exit call and the terminal state matter here.
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitedWith ??= code;
    }) as never);
    try {
      const p = pick("Q", ITEMS, 0, { io, color: false });
      type("\x03");
      await p;
    } finally {
      exit.mockRestore();
    }
    expect(exitedWith).toBe(130);
    expect(stdin.rawCalls[0]).toBe(true);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});

describe("pick() without a raw-mode terminal", () => {
  // protects: a TTY stdin with a non-TTY stdout (`npm run init | tee log`) or TERM=dumb uses the numbered
  //   list, so no cursor-addressing escapes land in the pipe or on a dumb terminal.
  // fails_when: the fallback decision looks at stdin only and raw-mode frames are written to the pipe.
  // why_new: pick() only checked stdin.isTTY; the piped-stdout case was untested.
  // seam: none (the `env` option is the picker's test hook for TERM).
  it("uses the numbered list when stdout is not a TTY or TERM is dumb", async () => {
    const run = async (stdoutIsTTY: boolean, env: NodeJS.ProcessEnv) => {
      // readline itself toggles raw mode on a TTY stdin while reading a line; what must not happen is the picker's own frame.
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
      const stdout = Object.assign(new PassThrough(), { isTTY: stdoutIsTTY, columns: 80 });
      let out = "";
      stdout.on("data", (c) => {
        out += c.toString();
        if (c.toString().includes("Select [")) stdin.write("\n");
      });
      const io = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream };
      const i = await pick("Q", ITEMS, 1, { io, color: false, env });
      return { i, out };
    };
    const piped = await run(false, {});
    expect(piped.i).toBe(1);
    expect(piped.out).not.toContain("\x1b[?25l"); // no hidden cursor
    expect(piped.out).not.toContain("↑↓ navigate"); // no raw-mode frame
    expect(piped.out).toContain("Select [1-2] (2): ");
    const dumb = await run(true, { TERM: "dumb" });
    expect(dumb.i).toBe(1);
    // Nothing from the picker or from readline: a dumb terminal gets plain text only.
    expect(dumb.out).not.toMatch(/\x1b\[/);
    expect(piped.out).not.toMatch(/\x1b\[/);
  });

  // protects: when stdin is not a TTY the picker prints a numbered list and reads a number;
  //   Enter keeps the default, an out-of-range or non-numeric answer is rejected and asked again.
  // fails_when: the fallback is skipped (setRawMode on a pipe throws), a bad answer is accepted
  //   as index 0 / NaN, or Enter does not keep `def`.
  // why_new: pickNumbered had no test; the wizard runs on it under CI, `npm run init < file` and
  //   editors' integrated terminals that are not TTYs.
  // seam: none (PassThrough streams through the `io` hook).
  it("falls back to a numbered list: Enter keeps the default, bad answers are re-asked", async () => {
    const run = async (input: string[]) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = "";
      const answers = [...input];
      // readline only keeps a line that arrives while a question is pending, so answer each prompt as it is printed.
      stdout.on("data", (c) => {
        out += c.toString();
        if (c.toString().includes("Select [") && answers.length) stdin.write(answers.shift()!);
      });
      const io = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream };
      const i = await pick("Booking system", ITEMS, 1, { io, color: false, description: ["why"] });
      return { i, out };
    };
    const kept = await run(["\n"]);
    expect(kept.i).toBe(1);
    expect(kept.out).toContain("Booking system\nwhy\n  ○ 1. 📅 Google Calendar  (not configured)\n  ● 2. ⬛ Square Appointments  (configured)\n");
    expect(kept.out).toContain("Select [1-2] (2): ");

    const retried = await run(["3\n", "abc\n", "1\n"]);
    expect(retried.i).toBe(0);
    expect(retried.out.match(/Please enter a number between 1 and 2/g)).toHaveLength(2);
  });
});
