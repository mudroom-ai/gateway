import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { EnvSchema } from "../src/config.js";
import { slackOwnerChannel } from "../src/connectors/slack.js";
import { checkOwnerChannel, describeListenError, describeStartupError, listenOrExit } from "../src/server.js";

describe("describeStartupError", () => {
  it("lists env issues one per line, like config errors", () => {
    const r = EnvSchema.safeParse({ SQUARE_ENV: "staging", PORT: "abc" });
    expect(r.success).toBe(false);
    const msg = describeStartupError(r.success ? undefined : r.error);
    expect(msg).toMatch(/^Invalid environment:\n/);
    expect(msg).toContain("  - SQUARE_ENV:");
    expect(msg).toContain("  - PORT:");
    expect(msg).not.toContain("    at ");
  });

  it("names the config file when it is not JSON", () => {
    let err: unknown;
    try {
      JSON.parse("{ nope");
    } catch (e) {
      err = e;
    }
    expect(describeStartupError(err, "config.json")).toMatch(/^config\.json is not valid JSON: /);
  });

  it("passes other errors through by message", () => {
    expect(describeStartupError(new Error("Invalid config:\n  - name: Required"))).toBe("Invalid config:\n  - name: Required");
  });
});

describe("listen errors", () => {
  it("names host, port and code with the PORT fix", () => {
    const e = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    expect(describeListenError("0.0.0.0", 80, e)).toBe("cannot listen on 0.0.0.0:80 (EACCES): stop the other process or set PORT in .env");
  });

  it("prints one line and exits 1 when the port is already bound", async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as AddressInfo).port;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await new Promise<number>((resolve) => {
        listenOrExit(createServer(), "127.0.0.1", port, () => resolve(-1), resolve);
      });
      expect(code).toBe(1);
      expect(errors.mock.calls).toEqual([
        [`[gateway] cannot listen on 127.0.0.1:${port} (EADDRINUSE): stop the other process or set PORT in .env`],
      ]);
    } finally {
      errors.mockRestore();
      holder.close();
    }
  });
});

describe("owner channel startup check", () => {
  const slack = (authTest: Response) =>
    slackOwnerChannel({
      botToken: "xoxb-bot",
      appToken: "xapp-app",
      channelId: "C0123",
      fetch: async () => authTest.clone(),
    });

  it("a channel_auth_failed fails the boot and describeStartupError prints the fix hint", async () => {
    const e = await checkOwnerChannel(slack(new Response(JSON.stringify({ ok: false, error: "invalid_auth" })))).then(() => undefined, (x: unknown) => x);
    expect(describeStartupError(e)).toMatch(/SLACK_BOT_TOKEN is wrong or revoked: copy the Bot User OAuth Token/);
  });

  it("a transient outage only warns so the gateway still boots", async () => {
    const warns: string[] = [];
    await expect(checkOwnerChannel(slack(new Response("", { status: 503 })), (m) => warns.push(m))).resolves.toBeUndefined();
    expect(warns[0]).toMatch(/owner channel not reachable at startup/);
  });

  it("no channel is a no-op", async () => {
    await expect(checkOwnerChannel(undefined)).resolves.toBeUndefined();
  });
});
