// Which assistant is calling, for the playground counter (demo mode only).
// From the user-agent, else the self-reported X-Agent-Name header that the
// demo llms.txt asks for: agents that call from a code sandbox (Muse, Grok's
// tools) send a plain curl or python user-agent that names nobody.

export const VENDORS = ["muse", "grok", "openai", "claude", "other"] as const;
export type Vendor = (typeof VENDORS)[number];

// Checked in order; first match wins. Tokens from each vendor's published crawler and fetcher user-agents.
const UA_RULES: [Vendor, RegExp][] = [
  ["claude", /\b(claude-user|claude-searchbot|claudebot|claude-web|anthropic)/i],
  ["openai", /\b(chatgpt|oai-searchbot|gptbot|openai)/i],
  ["grok", /\b(grok|xai)\b/i],
  ["muse", /\b(muse|meta-externalagent|meta-externalfetcher)\b/i],
];

// The self-reported name: one short word, mapped to a vendor only when it names one.
const HINT_RULES: [Vendor, RegExp][] = [
  ["claude", /^(claude|anthropic)\b/i],
  ["openai", /^(chatgpt|openai|gpt|codex|operator)\b/i],
  ["grok", /^(grok|xai)\b/i],
  ["muse", /^(muse|meta)\b/i],
];

export function classifyVendor(userAgent: string | undefined, agentName?: string | undefined): Vendor {
  const ua = (userAgent ?? "").slice(0, 300);
  for (const [v, re] of UA_RULES) if (re.test(ua)) return v;
  const hint = (agentName ?? "").trim().slice(0, 40);
  for (const [v, re] of HINT_RULES) if (re.test(hint)) return v;
  return "other";
}
