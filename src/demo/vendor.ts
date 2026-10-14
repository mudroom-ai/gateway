// Which assistant is calling, for the playground counter (demo mode only).
// From the user-agent, else the self-reported X-Agent-Name header that the
// demo llms.txt asks for: agents that call from a code sandbox (Muse,
// GrokBot) send a plain curl or python user-agent that names nobody. The
// playground supports Muse and GrokBot; every other caller counts as "other".

export const VENDORS = ["muse", "grokbot", "other"] as const;
export type Vendor = (typeof VENDORS)[number];

// Checked in order; first match wins. Tokens from each vendor's published crawler and fetcher user-agents.
const UA_RULES: [Vendor, RegExp][] = [
  ["grokbot", /\b(grok|grokbot|xai)\b/i],
  ["muse", /\b(muse|meta-externalagent|meta-externalfetcher)\b/i],
];

// The self-reported name: one short word, mapped to a vendor only when it names one.
const HINT_RULES: [Vendor, RegExp][] = [
  ["grokbot", /^(grok|grokbot|xai)\b/i],
  ["muse", /^(muse|meta)\b/i],
];

export function classifyVendor(userAgent: string | undefined, agentName?: string | undefined): Vendor {
  const ua = (userAgent ?? "").slice(0, 300);
  for (const [v, re] of UA_RULES) if (re.test(ua)) return v;
  const hint = (agentName ?? "").trim().slice(0, 40);
  for (const [v, re] of HINT_RULES) if (re.test(hint)) return v;
  return "other";
}

/** A stored vendor as the feed shows it: rows from before GrokBot's rename read "grok", and vendors no longer named count as "other". */
export function feedVendor(v: string): Vendor {
  if (v === "grok") return "grokbot";
  return (VENDORS as readonly string[]).includes(v) ? (v as Vendor) : "other";
}
