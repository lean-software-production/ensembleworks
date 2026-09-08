// Run: npx vitest run tests/page-presence.test.ts
//
// D-4 (PRESENCE-BY-PAGE) END TO END, in the plugin.
//
// The library halves of D-4 landed first and are tested where they live:
// canvas-sync's `Presence.page` (optional, absent means UNKNOWN) and
// canvas-react's `Cursors` page filter (`isOnOtherPage`, opt-in behind a
// `currentPageId` prop). Neither of them is worth anything until this plugin
// actually PUBLISHES a page, CARRIES it through the presence adapter, and
// TELLS the overlay which page the local view is on — and for a while it did
// none of the three, so the filter was inert for everybody and a peer on page
// 2 still had their cursor drawn on your page 1. This file covers the three
// seams that close that, plus the composition of them.
//
// THE ONE INVARIANT THAT MUST NEVER REGRESS: an ABSENT page means UNKNOWN,
// never "elsewhere". A peer running an older bundle publishes no page at all,
// and their cursor must still be drawn. Erasing somebody because they have
// not told you where they are is the same confidently-wrong report D-4 exists
// to prevent.
//
// The panel guards at the bottom read COMMENT-STRIPPED code, for the reason
// tests/source-guard.test.ts documents: a guard satisfied by the file's own
// prose stayed green while the call it was pinning was deleted.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOnOtherPage } from "@ensembleworks/canvas-react";
import type { Camera } from "@ensembleworks/canvas-editor";
import type { Presence } from "@ensembleworks/canvas-sync";
import { adaptPresence } from "../canvas/identity.js";
import { speakerRingsFor } from "../canvas/roster.js";
import {
  isPageRepublishNeeded,
  presencePageFor,
} from "../canvas/pages/page-presence.js";
import { callArguments, countInCode, stripComments } from "./lib/source.js";

describe("presencePageFor", () => {
  it("publishes a real page id unchanged", () => {
    expect(presencePageFor("page:retro")).toBe("page:retro");
  });

  it("publishes null — UNKNOWN — when the local page is not known", () => {
    // null and undefined are the same state to every reader: canvas-react's
    // isOnOtherPage falls through to "do not hide" for both.
    expect(presencePageFor(null)).toBeNull();
    expect(presencePageFor(undefined)).toBeNull();
  });

  it("publishes null rather than an empty page id", () => {
    // THE FAILURE THIS FORBIDS. `page: ""` is not "unknown" on the wire, it is
    // a page id that no live page has — so every peer would compute
    // isOnOtherPage("", theirPage) === true and hide this cursor everywhere.
    // Unknown read as "elsewhere" is exactly the D-4 failure mode.
    expect(presencePageFor("")).toBeNull();
  });
});

describe("isPageRepublishNeeded", () => {
  it("is true for the first page this peer learns", () => {
    expect(isPageRepublishNeeded(null, "page:a")).toBe(true);
    expect(isPageRepublishNeeded(undefined, "page:a")).toBe(true);
  });

  it("is true for a real switch", () => {
    expect(isPageRepublishNeeded("page:a", "page:b")).toBe(true);
  });

  it("is false when the page did not move", () => {
    // WHY THIS MATTERS RATHER THAN BEING AN OPTIMISATION: the publisher's page
    // write bypasses the throttle (a switch must not wait for the next pointer
    // move), so a caller that re-asserts the same page on every editor-state
    // change — which is how the panel's other presence write is driven — would
    // publish at pointer-move rate with the throttle disabled. "Only when it
    // changed" is what makes the bypass safe.
    expect(isPageRepublishNeeded("page:a", "page:a")).toBe(false);
    expect(isPageRepublishNeeded(null, null)).toBe(false);
    expect(isPageRepublishNeeded(undefined, null)).toBe(false);
  });

  it("is true when a known page becomes unknown", () => {
    // Going quiet is itself news: peers who were hiding this cursor because it
    // was elsewhere must stop hiding it.
    expect(isPageRepublishNeeded("page:a", null)).toBe(true);
  });
});

describe("adaptPresence carries the page to the overlay", () => {
  it("passes a published page straight through", () => {
    const adapted = adaptPresence(
      { "tab-1": { cursor: { x: 1, y: 2 }, page: "page:a" } },
      { "tab-1": "alice" },
    );
    expect(adapted["tab-1"]!.page).toBe("page:a");
  });

  it("reports a peer that published NO page as unknown, not as elsewhere", () => {
    // The older-bundle case, asserted at the adapter rather than only at the
    // renderer: `page` absent on the wire must arrive as null (unknown), and
    // null must NOT be inherited from some other peer or fabricated into the
    // local page.
    const adapted = adaptPresence(
      { "tab-1": { cursor: { x: 1, y: 2 } } },
      { "tab-1": "alice" },
    );
    expect(adapted["tab-1"]!.page).toBeNull();
  });

  it("emits the key on every peer, so a dropped page is visible to a test", () => {
    // Deliberately `toEqual` on the whole object: an adapter that dropped the
    // field would emit `page: undefined`, which toEqual treats as absent and
    // would therefore pass an assertion written the other way round. Emitting
    // null keeps "did the adapter carry it?" falsifiable.
    expect(
      adaptPresence({ "tab-1": { cursor: null } }, { "tab-1": "alice" })["tab-1"],
    ).toEqual({
      cursor: null,
      name: "alice",
      color: expect.any(String),
      page: null,
    });
  });
});

describe("the whole D-4 loop: published page -> adapter -> cursor filter", () => {
  /** What `Cursors` would do with this peer, given the local page. */
  const hidden = (
    peer: { cursor: { x: number; y: number } | null; page?: string | null },
    localPage: string | undefined,
  ): boolean => {
    const adapted = adaptPresence({ "tab-1": peer }, { "tab-1": "alice" });
    return isOnOtherPage(adapted["tab-1"]!.page, localPage);
  };

  it("hides a peer who is demonstrably on another page", () => {
    expect(hidden({ cursor: { x: 0, y: 0 }, page: "page:b" }, "page:a")).toBe(true);
  });

  it("shows two peers on the SAME page, exactly as before", () => {
    // The neutral case. Page-scoping must be invisible to the common case of
    // everybody working together on one page.
    expect(hidden({ cursor: { x: 0, y: 0 }, page: "page:a" }, "page:a")).toBe(false);
  });

  it("shows a peer running an older bundle, which publishes no page at all", () => {
    // BACK-COMPATIBILITY, end to end and in the direction that actually
    // regresses: absent -> null -> not hidden. If this ever flips, upgrading
    // one tab silently erases everybody who has not upgraded.
    expect(hidden({ cursor: { x: 0, y: 0 } }, "page:a")).toBe(false);
    expect(hidden({ cursor: { x: 0, y: 0 }, page: null }, "page:a")).toBe(false);
  });

  it("shows everybody when the local view is not page-aware", () => {
    // The other compatibility direction: a caller that passes no
    // `currentPageId` (canvas-v2's own app, today) filters nothing.
    expect(hidden({ cursor: { x: 0, y: 0 }, page: "page:b" }, undefined)).toBe(false);
  });
});

describe("speaker rings are page-scoped too", () => {
  // WHY THIS IS PART OF D-4 AND NOT A SEPARATE FEATURE. `SpeakerRings` draws a
  // pulsing ring AT A PEER'S CURSOR (canvas/roster.ts's `speakerRingsFor`), on
  // its own overlay, from the raw presence map — so page-scoping only the
  // cursors would leave a talking peer on page 2 as a ring hovering over
  // nothing on your page 1. That is strictly worse than before this feature
  // existed, because the cursor that used to explain the ring is now hidden.
  // The hiding rule is canvas-react's `isOnOtherPage` in both places, not a
  // second copy of it.
  const camera: Camera = { x: 0, y: 0, z: 1 };
  const VIEWPORT = { width: 800, height: 600 };
  const identities = { "client-a": "alice", me: "zoe" };
  const presenceOn = (page?: string | null): Record<string, Presence> => ({
    "client-a": {
      cursor: { x: 100, y: 120 },
      viewport: null,
      stamp: null,
      presenting: [],
      editing: null,
      ...(page === undefined ? {} : { page }),
    },
  });
  const rings = (page: string | null | undefined, localPage?: string) =>
    speakerRingsFor(
      presenceOn(page),
      identities,
      ["alice"],
      camera,
      VIEWPORT,
      "me",
      localPage,
    );

  it("draws no ring for a speaker who is on another page", () => {
    expect(rings("page:b", "page:a")).toEqual([]);
  });

  it("draws a ring for a speaker on the same page", () => {
    expect(rings("page:a", "page:a")).toHaveLength(1);
  });

  it("draws a ring for a speaker who published no page", () => {
    // Same back-compatibility rule as the cursors: unknown is not elsewhere.
    expect(rings(undefined, "page:a")).toHaveLength(1);
    expect(rings(null, "page:a")).toHaveLength(1);
  });

  it("draws every ring when the caller passes no local page", () => {
    // The existing six call sites in tests/roster.test.ts pass no local page
    // and must keep meaning "do not filter", which is what makes the parameter
    // additive rather than a migration.
    expect(rings("page:b", undefined)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PANEL WIRING GUARDS. CanvasPanel.tsx is a .tsx and there is no jsdom here, so
// no behavioural test can watch the prop being passed or the effect running.
// These read comment-stripped CODE for the reason tests/source-guard.test.ts
// documents, and each one exists because DELETING the line it names is a
// silent, total loss of D-4 at runtime with every other test still green.
// ---------------------------------------------------------------------------

const PANEL = readFileSync(
  new URL("../canvas/panel/session-presence.ts", import.meta.url),
  "utf8",
)+ readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8");
const PANEL_CODE = stripComments(PANEL);

/** The text of the single self-closing `<Tag ... />` element in `code`. */
function jsxElement(code: string, tag: string): string {
  const at = code.indexOf(`<${tag}`);
  expect(at, `no <${tag} element in the panel's code`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("/>", at);
  expect(end, `<${tag} is not self-closing`).toBeGreaterThan(at);
  return code.slice(at, end + 2);
}

describe("the panel is wired to page-scoped presence", () => {
  it("tells the cursor overlay which page the local view is on", () => {
    // WITHOUT THIS PROP the canvas-react filter is inert — `currentPageId`
    // undefined means "this caller is not page-aware", so every peer renders
    // on every page and D-4 does nothing at all. Asserted on the ELEMENT, not
    // the file: `currentPageId: editorState.currentPageId` appears three other
    // times in this panel as an object property (route, title, switcher), so a
    // file-wide toContain would survive deleting it from <Cursors>.
    expect(countInCode(PANEL, "<Cursors")).toBe(1);
    expect(jsxElement(PANEL_CODE, "Cursors")).toContain(
      "currentPageId={editorState.currentPageId}",
    );
  });

  it("publishes the local page through the publisher", () => {
    // A CALL, in stripped code. Without it this peer never sets `Presence.page`
    // and every OTHER client reads it as unknown — so page filtering works in
    // one direction only, which looks like it works.
    expect(PANEL_CODE).toContain(
      "presencePublisher.setPage(currentPageId)",
    );
  });

  it("republishes on the page itself, not on the next pointer move", () => {
    // The effect carrying the setPage call must depend on the current page, so
    // a SWITCH publishes at once. Parked in an effect keyed on something else
    // (or in the pointermove path) a peer who switches page and then sits
    // still stays advertised on the page they left — a stale location that is
    // wrong and looks right.
    const after = PANEL_CODE.slice(
      PANEL_CODE.indexOf("presencePublisher.setPage("),
    );
    const deps = /\}, \[([^\]]*)\]\);/.exec(after);
    expect(deps, "no dependency array follows the setPage call").not.toBeNull();
    expect(deps![1]).toContain("currentPageId");
  });

  it("tells the speaker-ring overlay which page the local view is on", () => {
    // The second overlay drawn on peers' cursors. Without this prop a talking
    // peer on another page keeps a ring painted here — over a cursor that is
    // now hidden, so it reads as a ring around nothing.
    expect(countInCode(PANEL, "<SpeakerRings")).toBe(1);
    expect(jsxElement(PANEL_CODE, "SpeakerRings")).toContain(
      "currentPageId={editorState.currentPageId}",
    );
  });

  it("builds the roster with the page it is looking at", () => {
    // WITHOUT THIS ARGUMENT the avatar strip is the one D-4 surface left
    // room-wide: `hasCursor` decides `DockBubble.canPan` (canvas/dock/
    // model.ts), which decides whether the dock's pan button is ENABLED and
    // titled "jump to their cursor". A peer on another page would keep an
    // enabled button whose click flies the camera to a point where D-4 has
    // just hidden the cursor — empty canvas, no explanation. The panel has
    // the page in scope two lines away, so the only thing between the bug and
    // the fix is this argument being passed.
    expect(countInCode(PANEL, "buildRoster(")).toBe(1);
    const args = callArguments(PANEL_CODE, "buildRoster")
      .split(",")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    expect(args).toContain("currentPageId");
  });

  it("asks panIntentFor where a header click should land, with the live page", () => {
    // The render-to-click race, and the reason the page arrives by REF rather
    // than by closure: the header lives outside this component's React tree
    // and the handler is registered once per identity change, so the click can
    // be delivered on a page the closure never saw. Read at click time, like
    // the cursor beside it.
    expect(countInCode(PANEL, "panIntentFor(")).toBe(1);
    const args = callArguments(PANEL_CODE, "panIntentFor")
      .split(",")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    expect(args).toContain("currentPageIdRef.current");
  });

  it("keeps that ref in step with the rendered page", () => {
    // A ref assigned once at mount would pin the pan rule to whatever page the
    // panel opened on and never move again — passing the guard above while
    // being wrong in exactly the same way. The assignment must be at render
    // scope, which is the pattern viewportSizeRef beside it already uses.
    // MUTATION VERIFIED 2026-09-05: a bare `toContain` of this assignment does
    // NOT pin where it sits — moving it into a `useEffect(..., [])` kept the
    // text, tsc at exit 0 and the suite at 39 files / 882 tests. So the match
    // is anchored to the component's own top-level indent (two spaces, the
    // scope `viewportSizeRef` beside it uses); nesting it inside any callback
    // indents further and no longer matches.
    expect(PANEL_CODE).toMatch(
      /^ {2}currentPageIdRef\.current = currentPageId;$/m,
    );
  });

  it("re-derives no pan rule of its own", () => {
    // HANDS, NOT POLICY. "Is there somewhere honest to fly to?" is one
    // decision (canvas/roster.ts's panIntentFor, over canvas-react's
    // isOnOtherPage) shared with `hasCursor`, so the enabled-ness of the
    // button and the behaviour of the click can never disagree. A second
    // comparison here would be an unreachable branch — this file has no jsdom
    // to test it with.
    expect(PANEL_CODE).not.toContain("isOnOtherPage");
    expect(PANEL_CODE).not.toContain("?.cursor");
  });

  it("builds no Presence payload of its own", () => {
    // Every wire field is the publisher's to write, in ONE object rewritten in
    // place (see canvas/presence-publisher.ts's header). A `page:` assembled
    // in the .tsx would be a wire value no test in this project could read
    // back, and a second place for "what does unknown look like" to drift.
    expect(PANEL_CODE.match(/\bpage:\s/g) ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE MIDDLE HOP. `SpeakerRings` (canvas/roster-ui.tsx) is the adapter between
// the guarded `<SpeakerRings currentPageId=…>` prop above and the behavioural
// `speakerRingsFor` filter tested further up — and it is a .tsx, so with no
// jsdom nothing behavioural can reach it. Until this guard existed, DELETING
// the `currentPageId` argument from its `speakerRingsFor(...)` call left the
// whole suite green and `tsc --noEmit` at exit 0 (the parameter is optional and
// last, precisely so older callers keep working), while at runtime
// `isOnOtherPage` then returned false for everybody and the entire speaker-ring
// page filter was dead: a talking peer on page 2 keeps a pulsing ring on your
// page 1, over a cursor D-4 has just hidden — a ring around nothing, which is
// worse than before page filtering existed. Verified by mutation on 2026-09-05:
// with that one argument removed, this guard was the ONLY failure in the whole
// spike suite (814 other tests passed) and `tsc --noEmit` still exited 0 — the
// parameter is optional and last, so nothing else in the repo can notice.
// ---------------------------------------------------------------------------

const ROSTER_UI = readFileSync(
  new URL("../canvas/roster-ui.tsx", import.meta.url),
  "utf8",
);
const ROSTER_UI_CODE = stripComments(ROSTER_UI);

describe("the SpeakerRings adapter forwards the local page", () => {
  it("passes currentPageId into speakerRingsFor", () => {
    // Read from COMMENT-STRIPPED code and bounded to the call's own argument
    // list: roster-ui.tsx names `currentPageId` in its props interface, in the
    // interface's doc comment and in the destructuring, so a file-wide
    // `toContain` would survive deleting it from exactly the place that
    // matters. Split on commas and matched WHOLE, so a differently-named
    // argument that merely contains the string cannot satisfy it either.
    expect(countInCode(ROSTER_UI, "speakerRingsFor(")).toBe(1);
    const args = callArguments(ROSTER_UI_CODE, "speakerRingsFor")
      .split(",")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    expect(args).toContain("currentPageId");
  });

  it("re-derives no page rule of its own", () => {
    // HANDS, NOT POLICY. The one page decision — "is this peer elsewhere?" —
    // is canvas-react's `isOnOtherPage`, called once from canvas/roster.ts. A
    // second comparison in this .tsx would be an unreachable policy branch
    // that could disagree with the cursors overlay about who is hidden.
    expect(ROSTER_UI_CODE).not.toContain("isOnOtherPage");
    expect(ROSTER_UI_CODE.match(/currentPageId\s*[=!]==/g) ?? []).toEqual([]);
  });
});
