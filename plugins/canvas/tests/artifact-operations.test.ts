import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

it("startup announces the destructive rollback floor", async () => {
  const host = createFakePluginHost({ pluginId: "canvas" });
  try {
    await plugin(host.bb);
    const logs = host.harness.inspection.logEntries.map((entry) => entry.message).join("\n");
    expect(logs).toContain("rollback floor: Release N");
    expect(logs).toContain("rolling back below Release N after artifacts have existed can delete them");
  } finally { await host.harness.lifecycle.dispose(); }
});

it("operator docs state deployment ordering and destructive rollback", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("rolling back below Release N after artifacts have existed can delete them");
  expect(readme).toContain("every host sharing room storage");
});
