// Prompter for tests of the interactive wizard: answers are taken in order,
// strings for `ask` and booleans for `confirm`. An empty string accepts the
// prompt's default, as Enter does on a terminal.

import type { Prompter } from "../../src/cli/init.js";
import type { PickItem } from "../../src/cli/picker.js";

export class ScriptedPrompter implements Prompter {
  /** Every prompt shown, in order, with its default in brackets when there is one. */
  readonly prompts: string[] = [];
  /** The items each `choose` call offered, in order (so tests can assert labels and status text). */
  readonly choices: PickItem[][] = [];
  private readonly queue: (string | boolean)[];

  constructor(answers: (string | boolean)[]) {
    this.queue = [...answers];
  }

  private next(prompt: string, kind: "string" | "boolean"): string | boolean {
    this.prompts.push(prompt);
    if (!this.queue.length) throw new Error(`scripted prompter ran out of answers at "${prompt}"`);
    const a = this.queue.shift()!;
    if (typeof a !== kind) throw new Error(`scripted prompter: "${prompt}" wants a ${kind}, got ${JSON.stringify(a)}`);
    return a;
  }

  async ask(q: string, def?: string, shown?: string): Promise<string> {
    const label = shown ?? def;
    const a = (this.next(label ? `${q} [${label}]` : q, "string") as string).trim();
    return a || def || "";
  }

  async confirm(q: string): Promise<boolean> {
    return this.next(q, "boolean") as boolean;
  }

  /** Answer with a 1-based number or a label; an empty string keeps the default, as Enter does. */
  async choose(q: string, items: PickItem[], def = 0): Promise<number> {
    this.choices.push(items);
    const a = (this.next(`${q} [${items[def]!.label}]`, "string") as string).trim();
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    const i = items.findIndex((it) => it.label === a);
    if (i < 0) throw new Error(`scripted prompter: "${q}" has no item ${JSON.stringify(a)}`);
    return i;
  }

  close(): void {}

  /** Answers not consumed (a test that expects the wizard to use them all checks this is 0). */
  get remaining(): number {
    return this.queue.length;
  }
}
