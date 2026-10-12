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
