import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "../src/server.js";

describe("resolveConfigPath", () => {
  it("returns the path when it exists", () => {
    expect(resolveConfigPath("/config/config.json", { NODE_ENV: "production" }, () => true)).toBe("/config/config.json");
  });
  it("throws in production when missing", () => {
    expect(() => resolveConfigPath("/config/config.json", { NODE_ENV: "production" }, (p) => p === "config.example.json")).toThrow(/not found.*not used in production/);
  });
  it("falls back to the example outside production", () => {
    expect(resolveConfigPath("config.json", {}, (p) => p === "config.example.json")).toBe("config.example.json");
  });
});
