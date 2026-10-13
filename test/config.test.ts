import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, parseConfig, parseTrustProxy, resolveServiceAccountJson } from "../src/config.js";

const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));

describe("config schema", () => {
  it("accepts the example config and fills defaults", () => {
    const c = parseConfig(example);
    expect(c.timezone).toBe("America/Los_Angeles");
    expect(c.services[0]?.price_cents).toBe(6500);
    expect(c.limits.max_window_days).toBe(14);
  });

  it("rejects a non-IANA timezone", () => {
    expect(() => parseConfig({ ...example, timezone: "PST-ish" })).toThrow(/IANA/);
  });

  // protects: ask_services takes a plain entry, and refuses text that would break out of the markdown
  //   served to agents (backtick, line break), an over-long name, and an id used in both lists.
  // fails_when: a limit is loosened or dropped from the schema, or the duplicate-id check stops
  //   spanning services and ask_services.
  // seam: none.
  it("ask_services: accepts a plain entry; rejects a backtick, a newline, a long name and a cross-list duplicate id", () => {
    const ask = (entry: object) => parseConfig({ ...example, ask_services: [entry] });
    expect(parseConfig(example).ask_services).toEqual([]);
    expect(ask({ id: "color-2", name: "Cut & color", price_note: "from $150" }).ask_services).toEqual([
      { id: "color-2", name: "Cut & color", price_note: "from $150" },
    ]);
    expect(() => ask({ id: "color", name: "Color `rm -rf`" })).toThrow(/ask_services\.0\.name/);
    expect(() => ask({ id: "color", name: "Color", price_note: "from $150\n## New section" })).toThrow(/ask_services\.0\.price_note/);
    expect(() => ask({ id: "color", name: "Color [book](https://example.com/pay)" })).toThrow(/ask_services\.0\.name/);
    expect(ask({ id: "color", name: "Color [long hair] (2 hr)" }).ask_services).toHaveLength(1);
    expect(() => ask({ id: "color", name: "x".repeat(81) })).toThrow(/at most 80 characters/);
    expect(() => ask({ id: "Color Fix", name: "Color" })).toThrow(/ask_services\.0\.id/);
    const taken = example.services[0].id as string;
    expect(() => ask({ id: taken, name: "Color" })).toThrow(`ask_services: duplicate id "${taken}" (already in services)`);
  });

  it.each([
    ["loopback", ["loopback"]],
    ["false", false],
    ["1", 1],
    [" 10.0.0.0/8, loopback ", ["10.0.0.0/8", "loopback"]],
  ])("TRUST_PROXY=%j parses to %j", (raw, want) => {
    expect(parseTrustProxy(raw as string)).toEqual(want);
  });

  it("GOOGLE_SERVICE_ACCOUNT_FILE is read; GOOGLE_SERVICE_ACCOUNT_JSON wins with a warning", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gw-sa-")), "key.json");
    writeFileSync(file, '{"client_email":"from-file"}');
    expect(loadEnv({ GOOGLE_SERVICE_ACCOUNT_FILE: file }, parseConfig(example)).google_service_account_json).toBe('{"client_email":"from-file"}');
    const warnings: string[] = [];
    const json = resolveServiceAccountJson({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"x":1}', GOOGLE_SERVICE_ACCOUNT_FILE: file }, (m) => warnings.push(m));
    expect(json).toBe('{"x":1}');
    expect(warnings[0]).toMatch(/both .* set/);
    expect(() => resolveServiceAccountJson({ GOOGLE_SERVICE_ACCOUNT_FILE: `${file}.missing` })).toThrow(/cannot read/);
  });

  it("TRUST_PROXY=true is rejected (would trust spoofed X-Forwarded-For)", () => {
    expect(() => parseTrustProxy("true")).toThrow(/hop count/);
  });
});
