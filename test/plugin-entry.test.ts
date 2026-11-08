import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

function fakeApi(config: Record<string, unknown>) {
  const tools: { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
  const logs: string[] = [];
  return {
    api: {
      pluginConfig: config,
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      registerTool: (t: (typeof tools)[number]) => tools.push(t),
    },
    tools,
    logs,
  };
}

describe("plugin entry", () => {
  it("defaults to read-only and registers writes only when explicitly enabled", () => {
    const a = fakeApi({ appleId: "a@b.com", appPassword: "x" });
    (plugin as unknown as { register: (api: unknown) => void }).register(a.api);
    expect(a.tools.map((t) => t.name)).toEqual([
      "icloud_calendar_list",
      "icloud_calendar_events",
      "icloud_calendar_get",
    ]);
    const writable = fakeApi({ appleId: "a@b.com", appPassword: "x", readOnly: false });
    (plugin as unknown as { register: (api: unknown) => void }).register(writable.api);
    expect(writable.tools.map((t) => t.name)).toEqual([
      "icloud_calendar_list",
      "icloud_calendar_events",
      "icloud_calendar_get",
      "icloud_calendar_create",
      "icloud_calendar_update",
      "icloud_calendar_delete",
    ]);
  });

  it("returns a structured not_configured error instead of throwing", async () => {
    const a = fakeApi({});
    delete process.env.ICLOUD_APPLE_ID;
    delete process.env.ICLOUD_APP_PASSWORD;
    (plugin as unknown as { register: (api: unknown) => void }).register(a.api);
    const res = await a.tools[0].execute("1", {});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe("not_configured");
    expect(a.logs.some((l) => l.includes("not configured"))).toBe(true);
  });
});
