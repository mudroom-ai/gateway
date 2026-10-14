import { describe, expect, it } from "vitest";
import { startSetupServer } from "../src/cli/setup-server.js";

describe("setup UI assets", () => {
  it("serves the local theme bootstrap and font behind the session token", async () => {
    const session = await startSetupServer({ open: false, exitOnEnter: false });
    try {
      const script = await fetch(new URL("theme.js", session.url));
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect(script.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await script.text()).toContain("gateway-theme");
      const font = await fetch(new URL("geist-latin.woff2", session.url));
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString()).toBe("wOF2");
      const origin = new URL(session.url).origin;
      expect((await fetch(`${origin}/s/invalid/theme.js`)).status).toBe(404);
      expect((await fetch(`${origin}/s/invalid/geist-latin.woff2`)).status).toBe(404);
    } finally {
      await session.close();
    }
  });
});
