import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar, UI_VARS } from "@ensembleworks/canvas-ui";
import { canvasThemeStyle } from "../canvas/theme.js";

describe("the plugin mounts the shared canvas chrome", () => {
  it("renders the shared nine-tool icon toolbar", () => {
    const html = renderToStaticMarkup(createElement(Toolbar, { activeToolId: "select", onSelectTool: () => {} }));
    for (const id of ["select", "hand", "note", "text", "geo", "frame", "arrow", "draw", "line"]) {
      expect(html).toContain(`data-canvas-tool="${id}"`);
    }
  });

  it("has no plugin-local copy of the session layer", () => {
    expect(existsSync(new URL("../canvas/tool-loop.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../canvas/panel/session-input.ts", import.meta.url))).toBe(false);
  });

  it("keeps the bb theme as the paper colour", () => {
    expect((canvasThemeStyle as Record<string, string>)["--canvas-paper"]).toBe("var(--background)");
  });
});

describe("bb theme mapping for the shared chrome", () => {
  it("maps every --canvas-ui-* variable onto a bb theme token", () => {
    const style = canvasThemeStyle as Record<string, string>;
    for (const value of Object.values(UI_VARS)) {
      const name = /var\((--canvas-ui-[a-z-]+)/.exec(value)?.[1];
      expect(name, `UI_VARS entry ${value} names a --canvas-ui-* variable`).toBeDefined();
      expect(style[name!], `${name} is mapped`).toMatch(/var\(--/);
    }
  });
});
