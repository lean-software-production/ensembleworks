// Run: npx vitest run tests/page-route.test.ts
//
// THE PAGE IS IN THE URL — and the two directions of that sentence are the
// whole hazard. Task C2a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md
// (D-3): bb hands a nav panel the route remainder as `subPath`
// (@get-bb/plugin-sdk bundled types, bb-plugin-sdk-app.d.ts:344-355), so
// `/plugins/canvas/canvas/page:retro` addresses one page. The URL therefore
// drives `currentPageId`, AND switching pages drives the URL. Two arrows into
// one pair of values is a ping-pong waiting to happen, so the arbitration is a
// pure function here rather than an `if` in CanvasPanel.tsx — this project has
// no jsdom, and a branch written in the .tsx is a branch nothing can check.
//
// The tests below are written as the SEQUENCES a person actually performs
// (cold deep link, click a tab, press Back), because every failure mode in
// this module is a failure of one step's output feeding the next step's input.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANVAS_PANEL_PATH,
  createPageRouter,
  decidePageRoute,
  pageIdFromSubPath,
  reconcilePageRoute,
  type PageRouteDecision,
  type PageRoutePorts,
} from "../canvas/pages/page-route.js";
import { callArguments, countInCode, stripComments } from "./lib/source.js";

const LIVE = ["page:a", "page:retro"] as const;

describe("pageIdFromSubPath — what bb's route remainder means", () => {
  it("reads a page id out of the remainder", () => {
    expect(pageIdFromSubPath("page:retro")).toBe("page:retro");
  });

  it("treats every spelling of 'no page was asked for' as no request", () => {
    // "" is what the SDK documents for the panel root; null/undefined are what
    // a caller with no prop has. One answer for all three, so `resolvePageId`
    // sees exactly the argument it already handles.
    expect(pageIdFromSubPath("")).toBeNull();
    expect(pageIdFromSubPath(null)).toBeNull();
    expect(pageIdFromSubPath(undefined)).toBeNull();
    expect(pageIdFromSubPath("   ")).toBeNull();
    expect(pageIdFromSubPath("/")).toBeNull();
  });

  it("normalises the slashes a hand-typed or copied URL carries", () => {
    expect(pageIdFromSubPath("/page:retro")).toBe("page:retro");
    expect(pageIdFromSubPath("page:retro/")).toBe("page:retro");
    expect(pageIdFromSubPath("  /page:retro/  ")).toBe("page:retro");
  });

  it("percent-decodes, because a colon in a path segment may arrive encoded", () => {
    // NOT VERIFIED against a running bb host: whether bb's router hands the
    // remainder decoded is unknown, and a browser or a chat client may encode
    // the colon on the way. Decoding covers both, and decoding an already-
    // decoded id is the identity — so this is cheap insurance rather than a
    // claim about bb.
    expect(pageIdFromSubPath("page%3Aretro")).toBe("page:retro");
  });

  it("keeps a malformed escape verbatim instead of throwing", () => {
    // decodeURIComponent throws on a truncated escape, and a thrown error in
    // the mount path would take the whole panel down over a bad bookmark. The
    // raw string is harmless: it is only ever COMPARED against live page ids,
    // never concatenated into a URL (every navigation targets `currentPageId`,
    // which comes from the doc).
    expect(pageIdFromSubPath("page%3")).toBe("page%3");
  });

  it("does not invent a page from a non-string", () => {
    expect(pageIdFromSubPath(42 as unknown as string)).toBeNull();
  });
});

describe("decidePageRoute — cold loads", () => {
  it("is idle when the URL already names the page the editor is on", () => {
    // The deep-link happy path. `resolvePageId(doc, subPath)` (canvas/page.ts,
    // Task A2) has ALREADY adopted the requested page at construction time, so
    // the first pass of this decision must produce no navigation at all —
    // navigating here would rewrite the URL the user deep-linked to.
    const decision = decidePageRoute({
      subPath: "page:retro",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: null,
    });
    expect(decision.action).toEqual({ kind: "idle" });
    expect(decision.settled).toBe("page:retro");
  });

  it("writes the page into a bare panel route, replacing rather than pushing", () => {
    // Somebody opened /plugins/canvas/canvas with no page. The panel resolved
    // the canonical page, and the URL should catch up so the address bar is
    // shareable.
    //
    // REPLACE, and this is the trap it avoids: pushing would put the BARE
    // route in history directly behind the page route, so pressing Back lands
    // on the bare route, which immediately navigates forward again — a Back
    // button that does nothing. The SDK says the same thing in its own words
    // ("use it for redirects so back does not bounce", bb-plugin-sdk-app.d.ts
    // on `toPluginPanel`).
    const decision = decidePageRoute({
      subPath: "",
      currentPageId: "page:a",
      livePageIds: LIVE,
      settled: null,
    });
    expect(decision.action).toEqual({
      kind: "navigate",
      subPath: "page:a",
      replace: true,
    });
  });

  it("replaces a stale bookmark's URL with the page it actually landed on", () => {
    // A2's fallback already put the editor on a real page; this is the other
    // half — the dead id must not stay in the address bar, and must not stay
    // in HISTORY either, for the same back-bounce reason as the bare route.
    const decision = decidePageRoute({
      subPath: "page:deleted-last-week",
      currentPageId: "page:a",
      livePageIds: LIVE,
      settled: null,
    });
    expect(decision.action).toEqual({
      kind: "navigate",
      subPath: "page:a",
      replace: true,
    });
  });
});

describe("decidePageRoute — the two arrows, and the loop between them", () => {
  it("pushes a history entry when the user switches pages", () => {
    // The URL still says page:a (bb has not re-rendered yet), the editor has
    // moved to page:retro. This is the one case that DOES deserve a history
    // entry: page:a is a real place the user was, and Back should return to it.
    const decision = decidePageRoute({
      subPath: "page:a",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: "page:a",
    });
    expect(decision.action).toEqual({
      kind: "navigate",
      subPath: "page:retro",
      replace: false,
    });
  });

  it("adopts the URL when the URL is what changed — Back and Forward", () => {
    // The distinguishing fact is not the values, it is WHICH ONE MOVED: the
    // observed subPath differs from the one this module last reconciled, so
    // the router moved and the editor must follow.
    const decision = decidePageRoute({
      subPath: "page:a",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: "page:retro",
    });
    expect(decision.action).toEqual({ kind: "adopt", pageId: "page:a" });
    expect(decision.settled).toBe("page:a");
  });

  it("never adopts a URL that names no live page", () => {
    // Back onto a page somebody has since deleted. Adopting would set
    // currentPageId to a dead page and the render filter would paint NOTHING —
    // the exact failure canvas/pages/history-repair.ts exists to prevent.
    const decision = decidePageRoute({
      subPath: "page:deleted-last-week",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: "page:retro",
    });
    expect(decision.action).toEqual({
      kind: "navigate",
      subPath: "page:retro",
      replace: true,
    });
  });

  it("is idle on a same-value navigation even when the URL moved", () => {
    // Back onto the page you are already on (or a duplicate history entry).
    // A same-value SetCurrentPage still notifies every editor subscriber
    // (page-menu.ts's `switchPageIntents` refuses one for that reason), and a
    // same-value navigation would push a redundant history entry.
    const decision = decidePageRoute({
      subPath: "page:retro",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: "page:a",
    });
    expect(decision.action).toEqual({ kind: "idle" });
  });

  it("does not bounce the user back when a navigation silently fails to land", () => {
    // THE FAILURE THIS FORBIDS. `toPluginPanel` is somebody else's router, and
    // this plugin has been burned by one before (canvas/dock/navigate.ts
    // verifies its own client-side jump rather than assuming it took). If a
    // navigation no-ops, the observed subPath simply never changes — and
    // because `settled` records what was OBSERVED rather than what was
    // INTENDED, the next page switch must still navigate forward instead of
    // reading the unchanged URL as a Back press and yanking the user to it.
    const first = decidePageRoute({
      subPath: "page:a",
      currentPageId: "page:retro",
      livePageIds: LIVE,
      settled: "page:a",
    });
    expect(first.action.kind).toBe("navigate");
    // The router ignored it: subPath is STILL page:a on the next pass.
    const second = decidePageRoute({
      subPath: "page:a",
      currentPageId: "page:third",
      livePageIds: [...LIVE, "page:third"],
      settled: first.settled,
    });
    expect(second.action).toEqual({
      kind: "navigate",
      subPath: "page:third",
      replace: false,
    });
  });

  it("settles in one step and then stays settled — no ping-pong", () => {
    // The whole loop, driven: a router that honours navigation, an editor that
    // honours adoption, and this decision in between. It must reach `idle` and
    // stay there, or the panel spins.
    const world = { url: "" as string | null, page: "page:a", settled: null as string | null };
    const steps: PageRouteDecision["action"]["kind"][] = [];
    for (let i = 0; i < 6; i += 1) {
      const decision = decidePageRoute({
        subPath: world.url,
        currentPageId: world.page,
        livePageIds: LIVE,
        settled: world.settled,
      });
      world.settled = decision.settled;
      steps.push(decision.action.kind);
      if (decision.action.kind === "navigate") world.url = decision.action.subPath;
      if (decision.action.kind === "adopt") world.page = decision.action.pageId;
    }
    expect(steps).toEqual(["navigate", "idle", "idle", "idle", "idle", "idle"]);
    expect(world.url).toBe("page:a");
    expect(world.page).toBe("page:a");
  });

  it("replaces the URL of a page that was just deleted", () => {
    // `deletePageIntents` moves currentPageId to an adjacent page, so this
    // arrives as "the editor moved". The deleted page is no longer live, so
    // the entry is REPLACED — Back must not offer a page that no longer
    // exists.
    const decision = decidePageRoute({
      subPath: "page:retro",
      currentPageId: "page:a",
      livePageIds: ["page:a"],
      settled: "page:retro",
    });
    expect(decision.action).toEqual({
      kind: "navigate",
      subPath: "page:a",
      replace: true,
    });
  });
});

// ---------------------------------------------------------------------------
// CARRYING THE DECISION OUT. `decidePageRoute` above is only half the story:
// the ARROW from an `adopt` decision to an actual `SetCurrentPage`, and from a
// `navigate` decision to an actual `toPluginPanel`, is where the URL-drives-
// the-editor direction lives. Review on 2026-09-05 deleted the whole `adopt`
// branch out of CanvasPanel.tsx and the suite still reported 751 passed —
// Back/Forward would have changed the URL and left the editor where it was,
// with nothing red. There is no jsdom here to catch that in the .tsx, so the
// arrow moved down into this module, where a fake port can watch it happen.
// ---------------------------------------------------------------------------

function spyPorts(): {
  readonly ports: PageRoutePorts;
  readonly applied: { type: "SetCurrentPage"; pageId: string }[];
  readonly navigated: { path: string; options?: { subPath?: string; replace?: boolean } }[];
} {
  const applied: { type: "SetCurrentPage"; pageId: string }[] = [];
  const navigated: {
    path: string;
    options?: { subPath?: string; replace?: boolean };
  }[] = [];
  return {
    applied,
    navigated,
    ports: {
      apply: (intent) => {
        applied.push({ ...intent });
      },
      navigate: {
        toPluginPanel: (path, options) => {
          navigated.push({ path, options });
        },
      },
    },
  };
}

describe("reconcilePageRoute — the decision actually happens", () => {
  it("puts the editor on the page the URL names (Back/Forward)", () => {
    // THE MUTATION THIS CATCHES: dropping the adopt arm. Without it the URL
    // moves and the canvas does not.
    const spy = spyPorts();
    const settled = reconcilePageRoute(
      {
        subPath: "page:a",
        currentPageId: "page:retro",
        livePageIds: LIVE,
        settled: "page:retro",
      },
      spy.ports,
    );
    expect(spy.applied).toEqual([{ type: "SetCurrentPage", pageId: "page:a" }]);
    expect(spy.navigated).toEqual([]);
    expect(settled).toBe("page:a");
  });

  it("writes the page into the URL when the editor moved, and pushes", () => {
    const spy = spyPorts();
    const settled = reconcilePageRoute(
      {
        subPath: "page:a",
        currentPageId: "page:retro",
        livePageIds: LIVE,
        settled: "page:a",
      },
      spy.ports,
    );
    expect(spy.navigated).toEqual([
      { path: CANVAS_PANEL_PATH, options: { subPath: "page:retro", replace: false } },
    ]);
    expect(spy.applied).toEqual([]);
    expect(settled).toBe("page:a");
  });

  it("replaces rather than pushes for a bare or dead route", () => {
    const spy = spyPorts();
    reconcilePageRoute(
      {
        subPath: "",
        currentPageId: "page:a",
        livePageIds: LIVE,
        settled: null,
      },
      spy.ports,
    );
    expect(spy.navigated).toEqual([
      { path: CANVAS_PANEL_PATH, options: { subPath: "page:a", replace: true } },
    ]);
  });

  it("navigates through CANVAS_PANEL_PATH itself, not a caller-chosen path", () => {
    // A navigation to a path bb has no panel registered at goes nowhere,
    // silently. The module owns the path so the .tsx cannot get it wrong.
    const spy = spyPorts();
    reconcilePageRoute(
      { subPath: "", currentPageId: "page:a", livePageIds: LIVE, settled: null },
      spy.ports,
    );
    expect(spy.navigated[0]?.path).toBe(CANVAS_PANEL_PATH);
  });

  it("touches nothing at all when the two agree", () => {
    // Idle must be genuinely idle: a same-value SetCurrentPage notifies every
    // editor subscriber and a same-value navigation pushes a duplicate history
    // entry.
    const spy = spyPorts();
    const settled = reconcilePageRoute(
      {
        subPath: "page:retro",
        currentPageId: "page:retro",
        livePageIds: LIVE,
        settled: "page:a",
      },
      spy.ports,
    );
    expect(spy.applied).toEqual([]);
    expect(spy.navigated).toEqual([]);
    expect(settled).toBe("page:retro");
  });

  it("runs the whole loop to rest against honest ports", () => {
    // The panel's real feedback loop, driven end to end through the same
    // function the panel calls: a router that honours navigation and an editor
    // that honours adoption must reach silence rather than spin.
    const world = { url: null as string | null, page: "page:a" };
    let settled: string | null = null;
    const ports: PageRoutePorts = {
      apply: (intent) => {
        world.page = intent.pageId;
      },
      navigate: {
        toPluginPanel: (_path, options) => {
          world.url = options?.subPath ?? "";
        },
      },
    };
    for (let i = 0; i < 6; i += 1) {
      settled = reconcilePageRoute(
        {
          subPath: world.url,
          currentPageId: world.page,
          livePageIds: LIVE,
          settled,
        },
        ports,
      );
    }
    expect(world.url).toBe("page:a");
    expect(world.page).toBe("page:a");
  });
});

describe("createPageRouter — the memory between calls", () => {
  // WHY THIS EXISTS AS A SEQUENCE AND NOT A CALL. `settled` is what tells the
  // two arrows apart, and until 2026-09-05 the panel held it in a ref: a value
  // returned by one call and fed to the next, in a .tsx, in a project with no
  // jsdom. Nothing could reach it, and mutation proved it — `settled: null`,
  // and dropping the store, each typechecked and left 39 files / 843 tests
  // passing. Folding it in here is what makes the round-trip testable at all,
  // so these tests drive the router the way a panel does: repeatedly, with the
  // world changing between calls.

  it("does not undo the user's own page switch", () => {
    // THE FAILURE THE FOLD EXISTS TO PREVENT, driven end to end: deep link,
    // then a click on another tab. Step 3 must write the new page into the URL
    // — with a forgetful router it reads as a Back press instead and the
    // canvas is yanked back to page:retro, which is what a user would see as
    // "the page tabs do not work".
    const router = createPageRouter();
    const spy = spyPorts();

    // 1. Cold deep link at /…/page:retro while the editor booted elsewhere.
    router.reconcile(
      { subPath: "page:retro", currentPageId: "page:a", livePageIds: LIVE },
      spy.ports,
    );
    expect(spy.applied).toEqual([{ type: "SetCurrentPage", pageId: "page:retro" }]);

    // 2. The adopt lands; the effect re-runs with the two in agreement.
    router.reconcile(
      { subPath: "page:retro", currentPageId: "page:retro", livePageIds: LIVE },
      spy.ports,
    );

    // 3. The user clicks the page:a tab. The URL has not moved yet.
    router.reconcile(
      { subPath: "page:retro", currentPageId: "page:a", livePageIds: LIVE },
      spy.ports,
    );
    expect(spy.applied).toEqual([{ type: "SetCurrentPage", pageId: "page:retro" }]);
    expect(spy.navigated).toEqual([
      { path: CANVAS_PANEL_PATH, options: { subPath: "page:a", replace: false } },
    ]);
  });

  it("still follows a genuine Back press", () => {
    // The other direction, from the same router, so "remembers" cannot be
    // satisfied by a router that simply never adopts.
    const router = createPageRouter();
    const spy = spyPorts();
    router.reconcile(
      { subPath: "page:a", currentPageId: "page:a", livePageIds: LIVE },
      spy.ports,
    );
    // Back: the URL moves on its own to a page the editor is not on.
    router.reconcile(
      { subPath: "page:retro", currentPageId: "page:a", livePageIds: LIVE },
      spy.ports,
    );
    expect(spy.applied).toEqual([{ type: "SetCurrentPage", pageId: "page:retro" }]);
    expect(spy.navigated).toEqual([]);
  });

  it("starts with nothing reconciled", () => {
    // A fresh router must behave as `settled: null`: the first pass over a
    // bare route corrects the URL rather than treating it as a Back press.
    const spy = spyPorts();
    createPageRouter().reconcile(
      { subPath: "", currentPageId: "page:a", livePageIds: LIVE },
      spy.ports,
    );
    expect(spy.navigated).toEqual([
      { path: CANVAS_PANEL_PATH, options: { subPath: "page:a", replace: true } },
    ]);
  });

  it("gives each panel its own memory", () => {
    // Two panels can be mounted at once (bb re-renders, StrictMode double-
    // mounts). Module-level state would make one panel's history decide the
    // other's, so the state belongs to the router instance.
    const first = createPageRouter();
    const second = createPageRouter();
    const spyFirst = spyPorts();
    const spySecond = spyPorts();
    first.reconcile(
      { subPath: "page:retro", currentPageId: "page:a", livePageIds: LIVE },
      spyFirst.ports,
    );
    second.reconcile(
      { subPath: "page:retro", currentPageId: "page:a", livePageIds: LIVE },
      spySecond.ports,
    );
    expect(spySecond.applied).toEqual([{ type: "SetCurrentPage", pageId: "page:retro" }]);
  });

  it("reaches rest against honest ports", () => {
    // The panel's real feedback loop through the router: a host that honours
    // navigation and an editor that honours adoption must go quiet rather than
    // spin.
    const world = { url: null as string | null, page: "page:a" };
    const ports: PageRoutePorts = {
      apply: (intent) => {
        world.page = intent.pageId;
      },
      navigate: {
        toPluginPanel: (_path, options) => {
          world.url = options?.subPath ?? "";
        },
      },
    };
    const router = createPageRouter();
    for (let i = 0; i < 6; i += 1) {
      router.reconcile(
        { subPath: world.url, currentPageId: world.page, livePageIds: LIVE },
        ports,
      );
    }
    expect(world.url).toBe("page:a");
    expect(world.page).toBe("page:a");
  });
});

// ---------------------------------------------------------------------------
// The wiring. CanvasPanel.tsx is HANDS ONLY, so what a test can honestly check
// about it is that it CALLS the decisions rather than making them — the same
// thing tests/page-switcher-layering.test.ts checks about the popover's layer,
// and for the same reason (no jsdom, so a rule written in the .tsx is a rule
// nothing reaches).
//
// EVERY GUARD BELOW READS COMMENT-STRIPPED CODE. The first version of this
// block read the panel as one flat string, and the panel's own header comment
// spells out the mount sequence it performs — so `toContain("resolvePageId(
// peer.doc, pageIdFromSubPath(")` was satisfied by the PROSE, and cutting the
// real call down to `resolvePageId(peer.doc)` (which deletes cold-load deep
// linking outright) left the suite reporting 751 passed. See
// tests/source-guard.test.ts for the stripper and its own tests.
// ---------------------------------------------------------------------------

const PANEL =
  readFileSync(new URL("../canvas/panel/connection-boot.ts", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../canvas/panel/session-pages.ts", import.meta.url), "utf8");
const PANEL_CODE = stripComments(PANEL);
const APP = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

describe("the panel is wired to the route", () => {
  it("seeds the editor from the subPath through resolvePageId, not around it", () => {
    // A2 already implements the adopt-or-fall-back rule; the deep link has to
    // route THROUGH it rather than be re-decided at the mount. The whole call
    // verbatim, so dropping the argument is a failure here — and, since
    // `requested` is a REQUIRED parameter, a typecheck error as well. Two
    // independent guards because losing this one line is losing cold-load deep
    // linking, C2a's headline behaviour, with nothing visible at runtime.
    expect(PANEL_CODE).toContain(
      "resolvePageId(\n        peer.doc,\n        pageIdFromSubPath(subPathRef.current),\n        readLastPage(pageMemoryStore(), ROOM_ID),\n      )",
    );
  });

  it("reads this client's remembered page at boot and writes every page switch", () => {
    expect(PANEL_CODE).toMatch(
      /useEffect\(\(\) => \{\s*writeLastPage\(pageMemoryStore\(\), ROOM_ID, editorState\.currentPageId\);\s*\}, \[editorState\.currentPageId\]\);/,
    );
    expect(countInCode(PANEL, "readLastPage(")).toBe(1);
    expect(countInCode(PANEL, "writeLastPage(")).toBe(1);
  });

  it("reads the subPath for the seed through a ref, never a boot dependency", () => {
    // THE FAILURE THIS FORBIDS: putting `subPath` in the boot effect's
    // dependency array would tear down the transport, the peer, the presence
    // store and the editor and rebuild the whole session every time somebody
    // clicks a page tab. The seed is a MOUNT-time read; every later change is
    // the route effect's job.
    //
    // Counted, not merely present: a declared-and-never-read ref satisfied the
    // old `toContain("subPathRef")`. Three uses is the honest minimum —
    // declare, keep current, read at the seed.
    expect(countInCode(PANEL, "subPathRef")).toBeGreaterThanOrEqual(3);
    expect(PANEL_CODE).toContain("}, [clientId, makeTransport]);");
  });

  it("hands the router to the reconciler instead of calling it itself", () => {
    // A navigation to a path bb has no panel registered at goes nowhere,
    // silently, so page-route.ts owns both the path constant and the call. The
    // panel supplying its own `toPluginPanel(...)` would be a second place for
    // the path to drift, unreachable by any test here.
    expect(PANEL_CODE).toContain("pageRouter.reconcile(");
    expect(countInCode(PANEL, "toPluginPanel")).toBe(0);
    expect(APP).toContain("path: CANVAS_PANEL_PATH");
  });

  it("hands the router the URL the panel was actually given", () => {
    // MUTATION VERIFIED 2026-09-05: `subPath,` -> `subPath: null,` at this
    // call site left `npx tsc --noEmit` at exit 0 and the whole suite at 39
    // files / 868 tests passed. The router then never sees the URL at all —
    // `pageIdFromSubPath(null)` is null, so every pass falls to rule 3 and
    // orders a `replace: true` navigation: Back/Forward dead, deep links
    // dead, and each page switch silently overwriting the current history
    // entry. The dependency-array guard below did not catch it, and could
    // not: DEPENDING on a value and PASSING it are different facts.
    //
    // Bounded to this call's own arguments (see `callArguments`), because
    // `subPath` appears in the boot seed and in two dependency arrays as well.
    // The shape allows the shorthand or the spelt-out `subPath: subPath`, and
    // nothing else — the point is that the value reaching the router is the
    // panel's own prop.
    expect(countInCode(PANEL, "pageRouter.reconcile(")).toBe(1);
    const args = callArguments(PANEL_CODE, "pageRouter.reconcile");
    expect(args).toMatch(/[{,]\s*subPath\s*(?:,|:\s*subPath\b)/);
  });

  it("hands the router every page the doc currently has", () => {
    // MUTATION VERIFIED 2026-09-05: `livePageIds: snapshot.pages.map((page) =>
    // page.id)` -> `livePageIds: []`, tsc exit 0, 39 files / 868 tests passed.
    // With the list empty `decidePageRoute`'s `requestedIsLive` is permanently
    // false, so rule 2 can never fire: adopt is dead (Back/Forward and deep
    // links never move the canvas) AND every navigate is forced to
    // `replace: true`, so a deliberate page switch stops pushing a history
    // entry and Back can never return to the page you left. Two behaviours
    // this file tests in detail, both unreachable through the only caller.
    //
    // Verbatim, including the projection: passing `snapshot.pages` itself
    // would be a type error, and passing a stale or filtered list would be the
    // same liveness bug in a subtler dress.
    // MUTATION VERIFIED 2026-09-05: `toContain` pins a PREFIX, so appending
    // `.slice(0, 0)` to the projection — no page is ever "live", so every
    // subPath looks stale — passed it with tsc at exit 0 and the suite at 882
    // tests. Both properties are therefore bounded to their whole value.
    const args = callArguments(PANEL_CODE, "pageRouter.reconcile");
    expect(args).toMatch(
      /[,{]\s*livePageIds:\s*snapshot\.pages\.map\(\(page\) => page\.id\)\s*,/,
    );
    expect(args).toMatch(/[,{]\s*currentPageId:\s*editorState\.currentPageId\s*,/);
  });

  it("wires the apply port to the real editor, and the navigate port to bb", () => {
    // MUTATION VERIFIED 2026-09-05: `apply: (intent) => editor.apply(intent)`
    // -> `apply: () => {}`, tsc exit 0, 39 files / 868 tests passed — the
    // entire URL-drives-the-editor arm gone at runtime, with Back/Forward and
    // cold-load deep links changing the address bar while the canvas stays
    // put. That is C2a's headline behaviour, and it is exactly the failure
    // `PageRoutePorts`' doc comment records having already been found once by
    // review. Moving the arm behind a port took the `if` out of this file; the
    // port BODY is still written here, so it needs its own guard.
    //
    // The ports are one-line hands, so they are pinned verbatim: a body that
    // does anything other than forward is policy in a .tsx that no test in
    // this jsdom-free project could reach.
    const args = callArguments(PANEL_CODE, "pageRouter.reconcile");
    expect(args).toContain("apply: (intent) => editor.apply(intent)");
    expect(args).toMatch(/[{,]\s*navigate\s*,/);
  });

  it("keeps no `settled` value of its own", () => {
    // THE MUTATIONS THIS CATCHES, both verified on 2026-09-05 against the
    // panel as it stood when it threaded `settled` itself: passing
    // `settled: null` into the call, and dropping the
    // `settledSubPathRef.current =` store, each left `npx tsc --noEmit` at exit
    // 0 and the whole suite at 39 files / 843 tests passed — while breaking
    // every page switch, since the effect then re-adopts the URL and snaps the
    // canvas back to the page the address bar still shows.
    //
    // The state lives in `createPageRouter` now, so the honest guard is that
    // the panel has no copy of it to get wrong: no `settled`, and no call to
    // the stateless `reconcilePageRoute` that would reintroduce the
    // round-trip. Both counted in CODE, so a mention in the prose above the
    // effect cannot satisfy either.
    expect(countInCode(PANEL, "settled")).toBe(0);
    expect(countInCode(PANEL, "reconcilePageRoute")).toBe(0);
  });

  it("holds one router for the panel's whole life", () => {
    // A router rebuilt on each render forgets what it reconciled, which is the
    // `settled: null` mutation above wearing a different hat — and it is one
    // character away (`const pageRouter = createPageRouter()` at render scope
    // typechecks and reads fine). So: constructed exactly once, through the
    // lazy-REF idiom rather than a `useMemo`, because React is free to discard
    // a memoised value and recompute it.
    expect(countInCode(PANEL, "createPageRouter()")).toBe(1);
    expect(PANEL_CODE).toContain("useRef<PageRouter | null>(null)");
    expect(PANEL_CODE).toContain("pageRouterRef.current ??= createPageRouter()");
  });

  it("re-reconciles when the URL or the page moves", () => {
    // The effect must depend on BOTH arrows. Keyed on neither (`[]`) the URL
    // and the canvas would only ever agree by luck, and nothing else in this
    // project could notice.
    const after = PANEL_CODE.slice(PANEL_CODE.indexOf("pageRouter.reconcile("));
    const deps = /\}, \[([^\]]*)\]\);/.exec(after);
    expect(deps, "no dependency array follows the reconcile call").not.toBeNull();
    expect(deps![1]).toContain("subPath");
    expect(deps![1]).toContain("editorState.currentPageId");
  });

  it("decides nothing about pages inline", () => {
    // No page-id comparison in the .tsx: whether a navigation is owed, whether
    // it replaces, and whether the URL should be adopted are all
    // decidePageRoute's, and a duplicate of any of them here would be
    // unreachable by every test in this project.
    expect(PANEL_CODE.match(/currentPageId\s*[=!]==/g) ?? []).toEqual([]);
    expect(countInCode(PANEL, "SetCurrentPage")).toBe(0);
  });
});

describe("CANVAS_PANEL_PATH", () => {
  it("is the panel path bb routes on", () => {
    // Recorded rather than derived: it is half of `/plugins/canvas/canvas/*`,
    // the shape canvas/dock/where.ts parses.
    expect(CANVAS_PANEL_PATH).toBe("canvas");
  });
});
