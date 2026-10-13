// Masked input for the setup wizard: a pasted API key is read in raw mode and
// echoed as one dot per character, so it never reaches the scrollback. Same
// terminal handling as picker.ts: raw-mode stdin, key sequences split with
// splitKeys, Ctrl+C exits 130 like a readline prompt. Without a raw-capable
// terminal there is no way to hide the typing, so the question is skipped with
// one note and the answer is "".

import { shouldUseColor, splitKeys, style } from "./picker.js";

export interface SecretOptions {
  /** Test hook: the raw-mode stream to read keys from and the stream to draw on. */
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } | undefined;
  /** Force colour on or off; default: follow the terminal, as the picker does. */
  color?: boolean | undefined;
}

const DOT = "•";
/** Longer than any API key; typing past it is ignored. */
const MAX_SECRET_CHARS = 4096;
/** An escape prefix with no final byte yet (an arrow key split across reads): kept until the rest arrives, never typed into the answer. */
const INCOMPLETE_SEQ_RE = /^\x1b(?:\[[0-9;?<>=:]*|O)?$/;
const MAX_HELD = 16;

/**
 * Ask `q` and read the answer without showing it. Enter ends the input, an
 * empty answer means skip, backspace removes one character and Ctrl+U all of
 * them; a paste arrives as one chunk and is taken whole up to its first line
 * break. The terminal mode is restored on every way out.
 */
export async function readSecret(q: string, opts: SecretOptions = {}): Promise<string> {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const skipped = () => {
    stdout.write(`${q}: skipped (hidden input needs a terminal)\n`);
    return "";
  };
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return skipped();
  const wasRaw = stdin.isRaw;
  try {
    stdin.setRawMode(true);
  } catch {
    return skipped();
  }

  let onData: ((chunk: Buffer | string) => void) | undefined;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (onData) stdin.off("data", onData);
    stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  };
  try {
    stdin.resume();
    stdout.write(`${style.question(q, opts.color ?? shouldUseColor(stdout))}: `);
    return await new Promise<string>((resolve) => {
      let value = "";
      let held = "";
      let done = false;
      const finish = (answer: string) => {
        if (done) return;
        done = true;
        restore();
        stdout.write("\n");
        resolve(answer);
      };
      onData = (chunk) => {
        const seqs = splitKeys(held + chunk.toString());
        held = "";
        if (seqs.includes("\x03")) {
          finish("");
          process.exit(130);
        }
        const last = seqs.at(-1);
        if (last !== undefined && last.length <= MAX_HELD && INCOMPLETE_SEQ_RE.test(last)) held = seqs.pop()!;
        let echo = "";
        for (const seq of seqs) {
          if (seq === "\r" || seq === "\n" || seq === "\x04") {
            stdout.write(echo);
            return finish(value.trim());
          }
          if (seq === "\x7f" || seq === "\b") {
            const chars = Array.from(value);
            if (chars.pop() !== undefined) echo += "\b \b";
            value = chars.join("");
          } else if (seq === "\x15") {
            echo += "\b \b".repeat(Array.from(value).length);
            value = "";
          } else if (seq.length === 1 && seq >= " " && value.length < MAX_SECRET_CHARS) {
            // One UTF-16 unit per piece: the second half of a surrogate pair joins its character without a second dot.
            value += seq;
            if (seq < "\udc00" || seq > "\udfff") echo += DOT;
          }
        }
        stdout.write(echo);
      };
      stdin.on("data", onData);
    });
  } finally {
    restore();
  }
}
