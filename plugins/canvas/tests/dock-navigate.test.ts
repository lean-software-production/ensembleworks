// Run: npx vitest run tests/dock-navigate.test.ts
//
// "Jump to where they are" — the two decisions, without a browser.
//
// The jump link is a real `<a href>`, so middle-click, ⌘-click, copy-link-
// address and the status bar all work by doing nothing at all. On a PLAIN left
// click the strip would rather route client-side than reload the whole bb app,
// and bb's router does answer a pushed history entry (verified against the
// running app during this feature's preflight) — but that is an undocumented
// behaviour of somebody else's router, and it is the single most likely thing
// here to rot silently the next time bb changes.
//
// So the fallback is not written and hoped for, it is pinned: the two functions
// below are what dock.ts asks before it touches anything, and every branch that
// hands the click back to the browser has a test.
import { describe, expect, it } from "vitest";
import { clientSideTook, shouldTryClientSide } from "../canvas/dock/navigate.js";

const PLAIN = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
} as const;

describe("shouldTryClientSide", () => {
  it("takes a plain left click", () => {
    expect(shouldTryClientSide(PLAIN)).toBe(true);
  });

  it("leaves a middle click alone", () => {
    // Open-in-new-tab. Intercepting it would be the strip stealing a gesture
    // it did not invent.
    expect(shouldTryClientSide({ ...PLAIN, button: 1 })).toBe(false);
  });

  it("leaves a right click alone", () => {
    expect(shouldTryClientSide({ ...PLAIN, button: 2 })).toBe(false);
  });

  it("leaves every modifier click alone", () => {
    // ⌘/ctrl = new tab, shift = new window, alt = download. All of them are
    // the browser's, and all of them need the href to be untouched.
    expect(shouldTryClientSide({ ...PLAIN, metaKey: true })).toBe(false);
    expect(shouldTryClientSide({ ...PLAIN, ctrlKey: true })).toBe(false);
    expect(shouldTryClientSide({ ...PLAIN, shiftKey: true })).toBe(false);
    expect(shouldTryClientSide({ ...PLAIN, altKey: true })).toBe(false);
  });

  it("leaves a click something else has already handled alone", () => {
    expect(shouldTryClientSide({ ...PLAIN, defaultPrevented: true })).toBe(false);
  });
});

describe("clientSideTook", () => {
  const before = { path: "/projects/p1/threads/t1", title: "First thread" };
  const target = "/projects/p1/threads/t2";

  it("is true when the app both moved and repainted", () => {
    expect(
      clientSideTook(before, { path: target, title: "Second thread" }, target),
    ).toBe(true);
  });

  it("is FALSE when the url moved but the app did not", () => {
    // THE FALLBACK CASE, and the reason this is a function and not an if. A
    // pushState always changes location.pathname whether or not anybody was
    // listening, so "did the path change" is not evidence of anything; the
    // page still showing the old title is evidence that no router answered.
    expect(
      clientSideTook(before, { path: target, title: "First thread" }, target),
    ).toBe(false);
  });

  it("is false when the path did not even reach the target", () => {
    expect(
      clientSideTook(before, { path: before.path, title: "anything" }, target),
    ).toBe(false);
  });

  it("is true, and asks for nothing, when we were already there", () => {
    // Clicking a link to the page you are on. There is nothing to verify and
    // nothing to fall back to; a hard reload here would be a bug.
    expect(clientSideTook(before, before, before.path)).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    expect(
      clientSideTook(before, { path: `${target}/`, title: "Second" }, target),
    ).toBe(true);
    expect(
      clientSideTook(before, { path: target, title: "Second" }, `${target}/`),
    ).toBe(true);
  });

  it("accepts the host's own loading placeholder as a repaint", () => {
    // bb sets a placeholder title ("Thread thr_cjny") within a frame or two and
    // the real one later. The placeholder is already proof the router routed,
    // and waiting for the real title would fall back on every slow thread.
    expect(
      clientSideTook(before, { path: target, title: "Thread t2" }, target),
    ).toBe(true);
  });

  it("errs towards falling back when two pages share a title", () => {
    // Two threads with the same title is the one false negative here, and it
    // is the safe direction: the cost is a full page load that lands in
    // exactly the right place. A false POSITIVE would strand the user on the
    // old page with the new url in the bar, which is unrecoverable without a
    // manual reload — so this asymmetry is deliberate.
    expect(
      clientSideTook(
        { path: "/projects/p1/threads/t1", title: "Standup" },
        { path: target, title: "Standup" },
        target,
      ),
    ).toBe(false);
  });
});
