// Connector developer-experience checklist (docs/connectors/README.md, CLAUDE.md).
// Every connector must ship with a doc, tests, onboarding, a README row and documented env vars.
// Adding a connector: add its name here and complete the checklist.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNEL_GUIDES } from "../src/cli/init-channel.js";
import { SETUP_GUIDES } from "../src/cli/init.js";

const CONNECTORS = ["google", "square", "glossgenius", "twilio", "slack"] as const;

/** Files under src/connectors that are not connectors themselves. */
const HELPERS = new Set(["types.ts", "calendar.ts", "square-oauth.ts", "slack-socket.ts"]);

const REQUIRED_HEADINGS = ["Overview", "Prerequisites", "Setup", "Use cases", "Limitations", "Errors", "Env vars", "Tests"];

const read = (p: string) => readFileSync(p, "utf8");
const readme = read("README.md");
const registry = read("docs/connectors/README.md");
const configuration = read("docs/configuration.md");
const init = read("src/cli/init.ts");

describe("connector checklist", () => {
  it("README links the configuration reference that holds every connector env var", () => {
    expect(readme, "README.md needs a link to docs/configuration.md").toContain("docs/configuration.md");
  });

  it("every setup guide the wizard links points at a connector doc that exists", () => {
    for (const g of [...Object.values(SETUP_GUIDES).map((f) => f(0)), ...Object.values(CHANNEL_GUIDES)]) expect(existsSync(`docs/connectors/${g.doc}.md`), `${g.label}: docs/connectors/${g.doc}.md`).toBe(true);
  });

  it("every connector source file is registered here or listed as a helper", () => {
    const files = readdirSync("src/connectors").filter((f) => f.endsWith(".ts"));
    const unknown = files.filter((f) => !HELPERS.has(f) && !CONNECTORS.includes(f.replace(/\.ts$/, "") as (typeof CONNECTORS)[number]));
    expect(unknown, "add the connector to CONNECTORS in test/connectors-dx.test.ts and finish docs/connectors/README.md").toEqual([]);
  });

  for (const name of CONNECTORS) {
    describe(name, () => {
      it("has a doc with every required heading in order", () => {
        const path = `docs/connectors/${name}.md`;
        expect(existsSync(path), `${path} missing; copy docs/connectors/_template.md`).toBe(true);
        const doc = read(path);
        let last = -1;
        for (const h of REQUIRED_HEADINGS) {
          const i = doc.indexOf(`\n## ${h}\n`);
          expect(i, `${path}: missing "## ${h}"`).toBeGreaterThan(-1);
          expect(i, `${path}: "## ${h}" is out of order`).toBeGreaterThan(last);
          last = i;
        }
      });

      it("has a test file", () => {
        expect(existsSync(`test/${name}.test.ts`), `test/${name}.test.ts missing`).toBe(true);
      });

      it("is in the registry table", () => {
        expect(registry, `docs/connectors/README.md registry lacks a row for ${name}`).toMatch(new RegExp(`^\\| \`${name}\` \\|`, "m"));
      });

      it("is linked from the README connectors table", () => {
        expect(readme, `README.md needs a link to docs/connectors/${name}.md`).toContain(`docs/connectors/${name}.md`);
      });

      it("is set up by npm run init", () => {
        expect(init.toLowerCase(), `src/cli/init.ts does not mention ${name}`).toContain(name);
      });

      it("env vars in the doc are in docs/configuration.md", () => {
        const doc = read(`docs/connectors/${name}.md`);
        const envSection = doc.split("\n## Env vars\n")[1]?.split("\n## ")[0] ?? "";
        const vars = [...envSection.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]);
        expect(vars.length, "Env vars section lists no variables").toBeGreaterThan(0);
        for (const v of vars) expect(configuration, `docs/configuration.md env table lacks ${v}`).toContain(`\`${v}\``);
      });
    });
  }
});
