// The first question of an interactive `npm run init`: stay in the terminal or
// finish the same wizard in a browser on this machine. Asked only when nothing
// else has already decided (no --web, no --non-interactive, no injected prompter).

import type { Prompter } from "./init.js";
import type { PickItem } from "./picker.js";

export const SETUP_MODE_ITEMS = [
  { emoji: "⌨️", label: "Continue setup in the terminal" },
  { emoji: "🌐", label: "Complete setup in the browser" },
] as const satisfies readonly PickItem[];

const SETUP_MODE_DESCRIPTION = [
  "  Continue setup in the terminal: the questions run here",
  "  Complete setup in the browser: the same questions open on this machine",
];

export type SetupMode = "terminal" | "web";

/** Default is the terminal, so Enter keeps the wizard where it has always run. */
export async function askSetupMode(p: Prompter): Promise<SetupMode> {
  const i = await p.choose("How do you want to set up Mudroom?", [...SETUP_MODE_ITEMS], 0, SETUP_MODE_DESCRIPTION);
  return i === 1 ? "web" : "terminal";
}
