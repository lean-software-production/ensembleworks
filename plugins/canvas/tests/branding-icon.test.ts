// ux-contract: none — branding-only glyph registration/hints; no input/gesture
// behavior changes. Asserts manifest + slot registration only.
//
// BB 0.45.0 paints a contribution's own `icon` ahead of the plugin's branding
// asset whenever the host recognises the name, so a generic hint such as
// "Layers" replaced the Canvas mark in the sidebar. The mark is therefore
// declared as the named icon `main` and the nav panel names it explicitly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The host's own registration collector (the one `loadPluginApp` wraps): this
// package does not carry `@testing-library/react`, which the public
// `@get-bb/plugin-sdk/testing/app` harness imports, and a branding fix is no
// reason to add a dependency.
import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";

const PLUGIN_ID = "canvas";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  bb: { branding: unknown };
};

describe("Canvas branding icon", () => {
  it("declares its existing mark as the named icon `main` alongside the branding icon", () => {
    // BB derives the plugin id, and so the glyph namespace, from the package name.
    expect(pkg.name).toBe(`bb-plugin-${PLUGIN_ID}`);
    expect(pkg.bb.branding).toEqual({
      icon: "./assets/icon.svg",
      experimental_icons: { main: "./assets/icon.svg" },
    });
  });

  it("names its own mark on the Canvas nav panel", async () => {
    // `@get-bb/plugin-sdk/app` reads `definePluginApp` off the host runtime at
    // import time, so stand in the one function app.tsx calls at module scope
    // (same definition shape as the SDK's) before importing it.
    const runtime = globalThis as { __bbPluginRuntime?: unknown };
    runtime.__bbPluginRuntime ??= {
      pluginSdkApp: { definePluginApp: (setup: unknown) => Object.freeze({ __bbPluginApp: true, setup }) },
    };
    const { default: canvasApp } = await import("../app");
    const app = collectPluginAppRegistrations(canvasApp);
    expect(app.navPanels.map(({ id, icon }) => ({ id, icon }))).toEqual([
      { id: "canvas", icon: `${PLUGIN_ID}/main` },
    ]);
  });
});
