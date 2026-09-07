// Run: npx vitest run tests/page-door.test.ts
//
// TASK C1a, the first surface — the quick-palette row.
//
// WHY A SEAM IS NEEDED. `commandPaletteAction` is registered ONCE, at
// `definePluginApp` time, with a static `title` and `run`
// (@get-bb/plugin-sdk bundled types, PluginCommandPaletteActionRegistration),
// and its `run` context carries only `threadId`, `projectId` and `openPanel` —
// there is no navigate and no way to enumerate rows per page. So the palette
// cannot BE the page list; it is a door onto the one the canvas panel already
// draws. That door is a module singleton for the same reason
// canvas/dock/transcript-door.ts is one: two mount points in one bundle with
// no common React ancestor.
import { describe, expect, it } from "vitest";
import {
  decidePageCommandAvailable,
  interpretPageOpen,
  pageDoor,
} from "../canvas/pages/page-door.js";

describe("decidePageCommandAvailable", () => {
  it("offers the row only when a canvas panel is mounted to open", () => {
    // app.tsx's existing `isAvailable` idiom: "hiding the row where it would
    // decline beats offering a command that does nothing". The palette opens
    // over Settings and over any thread, where there is no canvas panel and
    // therefore no page list to show.
    expect(decidePageCommandAvailable({ hasDoor: true })).toBe(true);
    expect(decidePageCommandAvailable({ hasDoor: false })).toBe(false);
  });
});

describe("interpretPageOpen", () => {
  it("says nothing at all when the menu opened", () => {
    expect(interpretPageOpen(true)).toEqual({ kind: "opened" });
  });

  it("explains itself when the panel went away between listing and running", () => {
    // Reachable despite `isAvailable`: `run` executes after the palette
    // closes, so a route change in between leaves nobody to ask. A refusal
    // that says nothing is indistinguishable from a broken command.
    const outcome = interpretPageOpen(false);
    expect(outcome.kind).toBe("no-door");
    expect(outcome.kind === "no-door" && outcome.status.length > 0).toBe(true);
  });
});

describe("pageDoor", () => {
  it("has no door until a panel publishes one", () => {
    expect(pageDoor.hasOpener()).toBe(false);
    expect(pageDoor.open()).toEqual(interpretPageOpen(false));
  });

  it("routes open() to the published opener", () => {
    let opened = 0;
    const release = pageDoor.setOpener(() => {
      opened += 1;
    });
    expect(pageDoor.hasOpener()).toBe(true);
    expect(pageDoor.open()).toEqual({ kind: "opened" });
    expect(opened).toBe(1);
    release();
    expect(pageDoor.hasOpener()).toBe(false);
  });

  it("ignores a stale release, because React registers the new panel before unmounting the old", () => {
    const releaseFirst = pageDoor.setOpener(() => {});
    let second = 0;
    const releaseSecond = pageDoor.setOpener(() => {
      second += 1;
    });
    // The departing panel's cleanup runs AFTER the arriving panel registered
    // — honouring it would take the live door away with it.
    releaseFirst();
    expect(pageDoor.hasOpener()).toBe(true);
    pageDoor.open();
    expect(second).toBe(1);
    releaseSecond();
    expect(pageDoor.hasOpener()).toBe(false);
  });
});
