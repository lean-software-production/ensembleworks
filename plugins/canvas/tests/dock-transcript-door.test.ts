// Run: npx vitest run tests/dock-transcript-door.test.ts
//
// THE 📜 BUTTON'S DOOR.
//
// The room transcript panel is NOT URL-addressable — measured on the running
// app on 2026-09-01: opening it from the panel launcher and from the quick
// palette both leave `location.pathname`, `search`, `hash`, `history.state` and
// `history.length` completely unchanged; the tab's identity lives in
// localStorage (`bb.thread.fixedPanelTabsState-<threadId>-1`). So the guarded
// client-side navigation in navigate.ts, newly sanctioned though it is, has
// nothing to push at: there is no URL for this panel. `toPluginPanel` is for
// NAV panels only.
//
// What there IS, is `useBbNavigate().openThreadPanel` — which resolves its
// opener from a React context bb provides inside the thread route. A content
// script has no fiber, so it cannot call a hook; but a `threadHeaderAction`
// component renders INSIDE that provider (proved by walking the fiber ancestor
// chain on the live app: the header row is `YES@28`, the cluster the strip is
// prepended into is `YES@29`, while the sidebar accessory is `NO` for its whole
// 92-fiber chain). Same plugin bundle, same window, so a module singleton
// carries the hook's function from the React side to the imperative side —
// exactly the trick canvas/panel-bus.ts already documents for `panTo`.
//
// This module is that singleton plus the three decisions around it: is there a
// door to show a button for, what does an `openThreadPanel` that returns FALSE
// mean, and what does a click therefore do to the status line and to the
// popover's fold. It is pure and DOM-free because this project has no jsdom.
import { describe, expect, it } from "vitest";
import {
  decideDoorVisible,
  decideTranscriptClick,
  interpretOpen,
  transcriptDoor,
} from "../canvas/dock/transcript-door.js";

describe("decideDoorVisible", () => {
  it("hides the button when no opener is registered", () => {
    // Every non-thread route: /plugins/canvas/canvas, /settings, /. The panel
    // is a thread-surface object and there is no door there at all — the quick
    // palette row hides itself on those routes for the same reason. A button
    // that cannot work must not be drawn.
    expect(decideDoorVisible({ hasOpener: false })).toBe(false);
  });

  it("shows it once a thread header has published one", () => {
    expect(decideDoorVisible({ hasOpener: true })).toBe(true);
  });
});

describe("interpretOpen — the host's boolean is not decoration", () => {
  it("reports an accepted open", () => {
    expect(interpretOpen(true)).toEqual({ kind: "opened" });
  });

  it("reports a decline rather than pretending it worked", () => {
    // `openThreadPanel` returns false when the surface has no thread side panel
    // or the action is unavailable. The strip says so; it does not swallow it.
    const outcome = interpretOpen(false);
    expect(outcome.kind).toBe("declined");
    if (outcome.kind === "no-door" || outcome.kind === "opened") {
      throw new Error("unreachable");
    }
    expect(outcome.status).toMatch(/transcript/i);
  });

  it("distinguishes 'the host said no' from 'there was nobody to ask'", () => {
    const outcome = interpretOpen(null);
    expect(outcome.kind).toBe("no-door");
    if (outcome.kind !== "no-door") throw new Error("unreachable");
    expect(outcome.status).toMatch(/thread/i);
  });
});

describe("transcriptDoor — the register/unregister singleton", () => {
  it("has no opener until a thread header publishes one", () => {
    expect(transcriptDoor.hasOpener()).toBe(false);
    expect(transcriptDoor.open()).toEqual(interpretOpen(null));
  });

  it("calls the registered opener and reports what it returned", () => {
    const calls: number[] = [];
    const off = transcriptDoor.setOpener(() => {
      calls.push(1);
      return true;
    });
    try {
      expect(transcriptDoor.hasOpener()).toBe(true);
      expect(transcriptDoor.open()).toEqual({ kind: "opened" });
      expect(calls.length).toBe(1);
    } finally {
      off();
    }
  });

  it("passes a declining opener's false straight through", () => {
    const off = transcriptDoor.setOpener(() => false);
    try {
      expect(transcriptDoor.open().kind).toBe("declined");
    } finally {
      off();
    }
  });

  it("goes back to having no door when the header unmounts", () => {
    const off = transcriptDoor.setOpener(() => true);
    off();
    expect(transcriptDoor.hasOpener()).toBe(false);
    expect(transcriptDoor.open().kind).toBe("no-door");
  });

  it("is last-writer-wins across a split's two headers", () => {
    // A split layout renders one thread header per pane, so two components
    // publish. bb's own quick palette resolves its opener from a module-level
    // Map the same way (`for (let t of _B.values()) e = t` — the last one
    // registered wins), so this matches the host's behaviour rather than
    // inventing a worse one.
    const offA = transcriptDoor.setOpener(() => false);
    const offB = transcriptDoor.setOpener(() => true);
    try {
      expect(transcriptDoor.open().kind).toBe("opened");
    } finally {
      offB();
      offA();
    }
  });

  it("does not let a stale unregister clear a newer opener", () => {
    // The cleanup ordering React actually produces when one header unmounts
    // while another stays: the OLD component's effect cleanup runs after the
    // new one has already registered.
    const offA = transcriptDoor.setOpener(() => false);
    const offB = transcriptDoor.setOpener(() => true);
    offA();
    try {
      expect(transcriptDoor.hasOpener()).toBe(true);
      expect(transcriptDoor.open().kind).toBe("opened");
    } finally {
      offB();
    }
  });

  it("notifies subscribers when a door appears and when it goes", () => {
    // The strip is imperative DOM: it has to be told to re-render the glyph
    // when a route change mounts or unmounts the thread header.
    const seen: boolean[] = [];
    const unsubscribe = transcriptDoor.subscribe(() => {
      seen.push(transcriptDoor.hasOpener());
    });
    try {
      const off = transcriptDoor.setOpener(() => true);
      off();
      expect(seen).toEqual([true, false]);
    } finally {
      unsubscribe();
    }
  });

  it("stops notifying an unsubscribed listener", () => {
    let count = 0;
    const unsubscribe = transcriptDoor.subscribe(() => {
      count += 1;
    });
    unsubscribe();
    const off = transcriptDoor.setOpener(() => true);
    off();
    expect(count).toBe(0);
  });
});

describe("decideTranscriptClick — what a click does to the status line and the fold", () => {
  // This is the half of the button that dock.ts used to decide inline, where no
  // test could reach it: with the branch written in the DOM file, wiring the
  // fold onto EVERY outcome instead of the accepted one left all 463 tests
  // green. That is the one regression this control cannot afford, because the
  // refusal is a sentence on a status line that lives inside the popover.
  it("clears the status and folds when the panel actually opened", () => {
    // Clearing first is what makes a second click after an earlier refusal stop
    // showing the stale complaint.
    expect(decideTranscriptClick({ kind: "opened" })).toEqual({ status: "", fold: true });
  });

  it("does NOT fold a decline — folding would hide the only explanation", () => {
    const declined = interpretOpen(false);
    if (declined.kind !== "declined") throw new Error("unreachable");
    expect(decideTranscriptClick(declined)).toEqual({
      status: declined.status,
      fold: false,
    });
  });

  it("does NOT fold when there was nobody to ask", () => {
    // The click that races an unmount. Same argument as the decline: it answers
    // on the status line, so the popover has to stay up to carry it.
    const noDoor = interpretOpen(null);
    if (noDoor.kind !== "no-door") throw new Error("unreachable");
    expect(decideTranscriptClick(noDoor)).toEqual({ status: noDoor.status, fold: false });
  });
});
