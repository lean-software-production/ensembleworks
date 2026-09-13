import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";

describe("attractor plugin scaffold", () => {
  it("logs a startup message when loaded", async () => {
    const info = vi.fn();
    const bb = { log: { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as BbPluginApi;

    await plugin(bb);

    expect(info).toHaveBeenCalledWith(expect.stringContaining("Attractor"));
  });
});
