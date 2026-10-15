import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { connectionNotes } from "../src/cli/setup-copy.js";
import { SETUP_GUIDES } from "../src/cli/init.js";
import { CHANNEL_GUIDES } from "../src/cli/init-channel.js";

function textOf(node: Element | string): string {
  if (typeof node === "string") return node;
  if (!node.children.length) return node.textContent;
  return node.children.map((child) => textOf(child as Element | string)).join("");
}

class Element {
  children: (Element | string)[] = [];
  textContent = "";
  className = "";
  title = "";
  href = "";
  hidden = true;
  attributes: Record<string, string> = {};
  constructor(public tag: string) {}
  append(...children: (Element | string)[]) { this.children.push(...children); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  get childElementCount() { return this.children.filter((child) => child instanceof Element).length; }
}
const source = readFileSync(new URL("../src/cli/setup-ui/app.js", import.meta.url), "utf8");
function renderer() {
  const log = new Element("div");
  const script = source.slice(source.indexOf("function appendText("), source.indexOf("function archiveNotes("));
  const context = { document: { createElement: (tag: string) => new Element(tag) }, URL, logEl: log, notes: new Element("section") };
  const runtime = runInNewContext(`${script}\n({ appendText, appendNote, appendLog });`, context);
  return { ...runtime, log };
}

describe("wizard guidance", () => {
  it("uses the same concise checklist and labeled guide link for every connector", () => {
    const guides = [SETUP_GUIDES.google(8765), SETUP_GUIDES.square(8765), SETUP_GUIDES.glossgenius(8765), CHANNEL_GUIDES.slack!, CHANNEL_GUIDES.twilio!, CHANNEL_GUIDES.whatsapp!];
    for (const guide of guides) {
      const note = connectionNotes(guide, 8765)[0];
      expect(typeof note).toBe("object");
      if (typeof note !== "object") throw Error("Expected structured guidance");
      expect(note.items).toHaveLength(3);
      expect(note.links![0]!.label).toBe("View setup guide");
      expect(note.links![0]!.href).toContain(`/connectors/${guide.doc}.md`);
    }
    expect(JSON.stringify(connectionNotes(guides[0]!, 8765))).toContain("Make changes to events");
    expect(JSON.stringify(connectionNotes(guides[1]!, 8765))).toContain("http://localhost:8765/callback");
    expect(JSON.stringify(connectionNotes(guides[3]!, 8765))).toContain("connections:write");
  });

  it("renders semantic checklists and literal text while rejecting unsafe links", () => {
    const { appendNote, log } = renderer();
    appendNote({ title: "Setup", items: [{ label: "<script>untrusted</script>" }], links: [{ label: "Unsafe", href: "javascript:alert(1)" }] });
    const block = log.children[0] as Element;
    expect((block.children[0] as Element).tag).toBe("h2");
    const list = block.children[1] as Element;
    expect(list.tag).toBe("ol");
    expect(((list.children[0] as Element).children[0] as Element).textContent).toBe("<script>untrusted</script>");
    expect((block.children[2] as Element).children).toHaveLength(0);
  });

  it("turns the next-steps transcript into a list with command blocks", () => {
    const { appendLog, log } = renderer();
    appendLog([
      "Ready to save Test Account Foyer.",
      "",
      "Next steps:",
      "",
      "  1. Go to your Mudroom folder",
      "       cd /Users/dennischia/projects/agent-gateway",
      "",
      "  2. Open a tunnel so Muse or Grok can reach it (skip if you only call it locally)",
      "       cloudflared tunnel --url http://localhost:3000",
      "     install: brew install cloudflared, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
      "     ChatGPT and Claude.ai don't work through a tunnel; host the gateway on a real domain for them (docs/deploy.md)",
      "     It prints https://<tunnel-host>.trycloudflare.com. Add that host to .env:",
      "       ALLOWED_HOSTS=<tunnel-host>.trycloudflare.com,localhost,127.0.0.1",
      "",
      "  3. Start Mudroom",
      "       npm start",
      "     Check it locally:",
      "       curl localhost:3000/api/services",
      "",
      "  4. Point your agent at the entry page",
      "       https://<tunnel-host>.trycloudflare.com",
      "",
      "Details: docs/deploy.md",
    ].join("\n"));
    appendLog([
      "Next steps:",
      "  1. Go to your Mudroom folder",
      "       cd /tmp/gw",
      "  2. Set up Google Calendar",
      "       a. Enable the API",
      "     Guide: https://github.com/mudroom-ai/gateway/blob/main/docs/connectors/google.md",
      "            (local copy: docs/connectors/google.md)",
      "  3. Run the wizard again (it keeps your answers; press Enter through them)",
      "       npm run init",
    ].join("\n"));

    const statusCard = log.children[0] as Element;
    expect(statusCard.className).toBe("note-line");
    const status = statusCard.children[0] as Element;
    expect(status.tag).toBe("p");
    expect(textOf(status)).toContain("Ready to save");

    const block = log.children[1] as Element;
    expect(block.className).toBe("instruction note-card");
    expect((block.children[0] as Element).textContent).toBe("Next steps");
    const steps = block.children[1] as Element;
    expect(steps.className).toContain("instruction-steps");
    expect(steps.children).toHaveLength(4);
    const command = (step: Element, index: number) => ((step.children[index] as Element).children[0] as Element).textContent;
    const first = steps.children[0] as Element;
    expect(command(first, 1)).toBe("cd /Users/dennischia/projects/agent-gateway");
    const tunnel = steps.children[1] as Element;
    expect(textOf(tunnel.children[0] as Element)).toContain("skip if you only call it locally");
    expect(command(tunnel, 1)).toBe("cloudflared tunnel --url http://localhost:3000");
    expect((tunnel.children[1] as Element).tag).toBe("pre");
    const install = tunnel.children[2] as Element;
    expect(install.className).toBe("step-copy");
    expect((install.children.find((child) => child instanceof Element && child.tag === "code") as Element).textContent).toBe("brew install cloudflared");
    expect((install.children.find((child) => child instanceof Element && child.tag === "a") as Element).href).toContain("developers.cloudflare.com");
    expect(command(tunnel, 5)).toBe("ALLOWED_HOSTS=<tunnel-host>.trycloudflare.com,localhost,127.0.0.1");
    expect(command(steps.children[2] as Element, 1)).toBe("npm start");
    expect(command(steps.children[2] as Element, 3)).toBe("curl localhost:3000/api/services");
    const footer = block.children[2] as Element;
    expect(footer.className).toBe("step-copy");
    expect(textOf(footer)).toBe("Details: docs/deploy.md");
    expect((steps.children[3] as Element).children.some((child) => child instanceof Element && child.className === "step-copy" && textOf(child).startsWith("Details:"))).toBe(false);

    const guide = (log.children[2] as Element).children[1] as Element;
    const setup = guide.children[1] as Element;
    expect(setup.children.filter((child) => child instanceof Element && child.className === "command")).toHaveLength(0);
    expect((setup.children[1] as Element).className).toBe("step-copy");
    expect(textOf(setup.children[1] as Element)).toBe("a. Enable the API");
    expect(textOf(setup.children[3] as Element)).toContain("(local copy: docs/connectors/google.md)");
    expect(command(guide.children[2] as Element, 1)).toBe("npm run init");
  });

  it("shortens filenames but preserves commands and full-path tooltips", () => {
    const { appendText } = renderer();
    const node = new Element("p");
    appendText(node, "Use `/invite` and /private/tmp/config.json.");
    const elements = node.children.filter((child): child is Element => child instanceof Element);
    expect(elements[0]!.textContent).toBe("/invite");
    expect(elements[1]!.textContent).toBe("config.json");
    expect(elements[1]!.title).toBe("/private/tmp/config.json");
  });

  it("gives each structured note its own card and keeps one-line notes as text", () => {
    const { appendLog, appendNote, log } = renderer();
    appendLog("Found /private/tmp/config.json and /private/tmp/.env.");
    appendNote({ title: "Your setup", fields: [{ label: "Business", value: "Foyer" }] });
    appendLog("Line one.\nLine two.");
    expect((log.children[0] as Element).className).toBe("note-line");
    expect(((log.children[0] as Element).children[0] as Element).tag).toBe("p");
    expect((log.children[2] as Element).className).toBe("note-card");
    expect((log.children[1] as Element).className).toBe("instruction note-card");
    expect((log.children[1] as Element).children.some((child) => child instanceof Element && child.className === "instruction-fields")).toBe(true);
  });
});
