// The init wizard's "before you connect" step, shared by the booking-system
// flow (init.ts) and the owner-channel flow (init-channel.ts): print what a
// connector needs with a link to its page in docs/connectors/, then ask
// whether to connect now. The page opens in the browser only when asked for.

import { spawn } from "node:child_process";
import type { Prompter } from "./init.js";
import { style, type PickItem } from "./picker.js";

const DOCS_URL = "https://github.com/mudroom-ai/gateway/blob/main/docs/connectors";

/** What a merchant needs before the wizard can connect one connector; `doc` is its page in docs/connectors/. */
export interface SetupGuide {
  label: string;
  doc: string;
  steps: string[];
}

export const docUrl = (doc: string) => `${DOCS_URL}/${doc}.md`;

/** The numbered steps, then where the full guide is (web and local copy). */
export function guideLines(g: SetupGuide, indent = "  "): string[] {
  return [...g.steps.map((s, i) => `${indent}${i + 1}. ${s}`), `${indent}Guide: ${docUrl(g.doc)}`, `${indent}       (local copy: docs/connectors/${g.doc}.md)`];
}

/** Offered after the guide; "open" is left out where there is no browser to open (SSH, Linux without a display). */
export const READY_ITEMS = {
  yes: { emoji: "✅", label: "Yes, I have these" },
  open: { emoji: "🌐", label: "Open the guide in my browser first" },
  later: { emoji: "⏸", label: "Not yet, finish later" },
} satisfies Record<string, PickItem>;

const canOpenBrowser = (env: NodeJS.ProcessEnv, platform = process.platform) =>
  !(env.SSH_CONNECTION || env.SSH_TTY) && (platform !== "linux" || !!(env.DISPLAY || env.WAYLAND_DISPLAY));

/** Open the URL in the user's browser; best effort. */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // The URL is printed anyway.
  }
}

export interface GuideIO {
  env: NodeJS.ProcessEnv;
  log: (m: string) => void;
  /** Default: the system browser (tests observe the URL). */
  openUrl?: ((url: string) => void) | undefined;
}

/** Print the guide and ask "Ready to connect?". Resolves false for "Not yet, finish later". */
export async function showGuide(p: Prompter, g: SetupGuide, io: GuideIO): Promise<boolean> {
  io.log(`\n${style.question(`${g.label}: before you connect`)}\n${guideLines(g).join("\n")}\n`);
  for (let offerOpen = canOpenBrowser(io.env); ; offerOpen = false) {
    const items = offerOpen ? [READY_ITEMS.yes, READY_ITEMS.open, READY_ITEMS.later] : [READY_ITEMS.yes, READY_ITEMS.later];
    const picked = items[await p.choose("Ready to connect?", items)]!;
    if (picked === READY_ITEMS.yes) return true;
    if (picked === READY_ITEMS.later) return false;
    (io.openUrl ?? openBrowser)(docUrl(g.doc));
  }
}
