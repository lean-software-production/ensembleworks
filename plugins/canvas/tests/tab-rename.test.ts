// RENAMING A PAGE IN PLACE — the rule, the two surfaces that draw it, and the
// host fact that forced it to exist.
//
// THE BUG THIS FILE IS THE MEMORY OF (2026-09-22): every page rename in bb was
// a silent no-op. `rename` was `renamePageIntents(row, window.prompt("Rename
// page", row.name))`, and bb is an Electron app — Electron does not implement
// `window.prompt`, so no dialog appeared, no text came back, and
// `renamePageIntents` correctly read that as "no rename was asked for" and
// wrote nothing. All three entry points (a tab's double-click, the tab context
// menu's Rename, the Pages popover's ✎) share that one handler, so all three
// died together. `window.confirm` IS supported, which is exactly why DELETE
// went on working and only rename looked broken.
//
// THE MODEL LAYER WAS NEVER AT FAULT, which is why nothing below tests it: a
// `RenamePage` intent driven through a real Editor + LoroCanvasDoc renames the
// page, fires the doc subscriber and shows up in `toolContext.snapshot()`.
// canvas-editor owns that and its own tests cover it.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  NO_TAB_RENAME,
  decideTabRenameKey,
  nextTabRename,
  tabRenameDraft,
} from "../canvas/pages/tab-rename.js";
import { countInCode, stripComments } from "./lib/source.js";

const ACTIONS = stripComments(
  readFileSync(new URL("../canvas/pages/switcher/actions.ts", import.meta.url), "utf8"),
);
const BOX = stripComments(
  readFileSync(new URL("../canvas/pages/switcher/rename-box.tsx", import.meta.url), "utf8"),
);
const TABS = stripComments(
  readFileSync(new URL("../canvas/pages/switcher/page-tabs.tsx", import.meta.url), "utf8"),
);
const POPOVER = stripComments(
  readFileSync(new URL("../canvas/pages/switcher/page-menu-view.tsx", import.meta.url), "utf8"),
);

describe("nextTabRename — which row is being renamed, and what is in the box", () => {
  it("opens on the row it was asked for, seeded with that page's name", () => {
    expect(nextTabRename(NO_TAB_RENAME, { type: "begin", id: "page:q", name: "Retro" }))
      .toEqual({ id: "page:q", draft: "Retro" });
  });

  it("takes what is typed", () => {
    const open = { id: "page:q", draft: "Retro" };
    expect(nextTabRename(open, { type: "type", id: "page:q", text: "Retrospective" }))
      .toEqual({ id: "page:q", draft: "Retrospective" });
  });

  it("keeps an emptied box open rather than treating it as no edit", () => {
    // `""` is a real draft — a user who selected-all and hit Backspace is
    // mid-edit, not done. (`renamePageIntents` is what later refuses to WRITE
    // an empty name; that refusal is not this state's job.)
    const open = { id: "page:q", draft: "Retro" };
    expect(nextTabRename(open, { type: "type", id: "page:q", text: "" }))
      .toEqual({ id: "page:q", draft: "" });
  });

  it("IGNORES typing that arrives from a row which is not the edited one", () => {
    // The mutation this forbids: a change/blur racing out of an input React is
    // unmounting writes the dying row's text into the row that just opened,
    // renaming a page to another page's half-typed name.
    const open = { id: "page:q", draft: "Retro" };
    expect(nextTabRename(open, { type: "type", id: "page:other", text: "wrong" })).toBe(open);
  });

  it("does not resurrect a closed editor from a stray keystroke", () => {
    expect(nextTabRename(NO_TAB_RENAME, { type: "type", id: "page:q", text: "x" }))
      .toBe(NO_TAB_RENAME);
  });

  it("moves to another row when rename is asked for again, dropping the old draft", () => {
    const open = { id: "page:q", draft: "half-typed" };
    expect(nextTabRename(open, { type: "begin", id: "page:z", name: "Sketches" }))
      .toEqual({ id: "page:z", draft: "Sketches" });
  });

  it("closes on end, whichever way the edit ended", () => {
    expect(nextTabRename({ id: "page:q", draft: "Retro" }, { type: "end" })).toBe(NO_TAB_RENAME);
  });

  it("returns the SAME state when nothing moved, so a render can be skipped", () => {
    const open = { id: "page:q", draft: "Retro" };
    expect(nextTabRename(open, { type: "type", id: "page:q", text: "Retro" })).toBe(open);
    expect(nextTabRename(NO_TAB_RENAME, { type: "end" })).toBe(NO_TAB_RENAME);
  });
});

describe("tabRenameDraft — what each row should draw", () => {
  it("gives the draft to the row being renamed", () => {
    expect(tabRenameDraft({ id: "page:q", draft: "Retro" }, "page:q")).toBe("Retro");
  });

  it("gives null to every other row — and null, not '', to a cleared box", () => {
    // `""` would be indistinguishable from "not editing" at the call site,
    // which would kick a user who cleared the box back to a plain tab.
    expect(tabRenameDraft({ id: "page:q", draft: "Retro" }, "page:z")).toBeNull();
    expect(tabRenameDraft({ id: "page:q", draft: "" }, "page:q")).toBe("");
    expect(tabRenameDraft(NO_TAB_RENAME, "page:q")).toBeNull();
  });
});

describe("decideTabRenameKey — what a keystroke in the box asks for", () => {
  it("commits on Enter and cancels on Escape", () => {
    expect(decideTabRenameKey("Enter")).toBe("commit");
    expect(decideTabRenameKey("Escape")).toBe("cancel");
  });

  it("is silent about every other key, including the ones that look like verbs", () => {
    for (const key of ["a", "Tab", "Backspace", "ArrowLeft", " ", "NumpadEnter"]) {
      expect(decideTabRenameKey(key)).toBeNull();
    }
  });
});

describe("no plugin surface asks the HOST to draw a text prompt", () => {
  /** Every .ts/.tsx the plugin ships, excluding tests and build output. */
  function pluginSources(): readonly string[] {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const skip = new Set(["node_modules", "dist", "tests", "mockups", "assets", "scripts"]);
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path);
      }
    };
    walk(root);
    return found;
  }

  it("finds the sources at all, so an empty sweep can never pass vacuously", () => {
    expect(pluginSources().length).toBeGreaterThan(50);
  });

  it("calls window.prompt nowhere — bb's Electron host does not implement it", () => {
    // THE WHOLE AUDIT, MECHANISED. `window.prompt` is not a style question
    // here: in Electron it shows nothing and returns nothing, so any feature
    // built on it is dead on arrival inside bb and dead SILENTLY — no error,
    // no dialog, nothing in the console to lead anyone to it. This is the gate
    // that stops the next one being written.
    const offenders = pluginSources().filter((path) =>
      countInCode(stripComments(readFileSync(path, "utf8")), "window.prompt(") > 0);
    expect(offenders).toEqual([]);
  });

  it("still uses window.confirm for delete, which Electron DOES implement", () => {
    // Stated so the rule above is read as "prompt is unsupported", not as
    // "native dialogs are banned" — deleting a page still asks, and still
    // asks through the host.
    expect(countInCode(ACTIONS, "window.confirm(")).toBe(1);
  });
});

describe("the editor that replaced the prompt", () => {
  it("is ONE component, drawn by both surfaces that can show a page row", () => {
    // The tab strip is hidden entirely on a narrow panel (page-tabs-fit.ts),
    // so a popover that could only send the user to a tab would have moved the
    // silent no-op from Electron to a phone rather than fixing it.
    expect(TABS).toContain("<RenameBox");
    expect(POPOVER).toContain("<RenameBox");
    expect(countInCode(TABS, "RenameBox")).toBeGreaterThan(0);
  });

  it("chooses the box over the ordinary control by asking the shared rule", () => {
    // Not an `=== row.id` written twice: two surfaces must not be able to
    // disagree about which row is being edited.
    expect(TABS).toMatch(/renameEdit\.draftFor\(row\.id\) !== null/);
    expect(POPOVER).toMatch(/renameEdit\.draftFor\(row\.id\) !== null/);
  });

  it("commits on Enter and on blur, and cancels on Escape", () => {
    expect(BOX).toMatch(/onBlur=\{\(\) => edit\.commit\(row\)\}/);
    expect(BOX).toContain("decideTabRenameKey(event.key)");
    expect(BOX).toMatch(/if \(action === "commit"\) edit\.commit\(row\);/);
    expect(BOX).toMatch(/else edit\.cancel\(\);/);
  });

  it("claims Escape rather than letting it also dismiss the menu behind it", () => {
    // The drag machine and both popovers listen for Escape on window/document.
    // Without this, one press would cancel the rename AND shut the surface the
    // rename was started from.
    expect(BOX).toContain("event.stopPropagation()");
  });

  it("selects the seeded name so typing replaces it", () => {
    expect(BOX).toMatch(/onFocus=\{\(event\) => event\.target\.select\(\)\}/);
    expect(BOX).toContain("autoFocus");
  });

  it("keeps renamePageIntents as the ONLY judge of the text, and the only write", () => {
    // The three refusals it owns (no answer, an emptied box, an unchanged
    // name) did not move into the editor and must not be duplicated there.
    expect(countInCode(ACTIONS, "renamePageIntents(")).toBe(1);
    expect(countInCode(BOX, "renamePageIntents(")).toBe(0);
    expect(countInCode(BOX, "applyAll(")).toBe(0);
  });

  it("opens the editor from rename() rather than writing there", () => {
    expect(ACTIONS).toMatch(/dispatchRename\(\{ type: "begin", id: row\.id, name: row\.name \}\)/);
  });
});
