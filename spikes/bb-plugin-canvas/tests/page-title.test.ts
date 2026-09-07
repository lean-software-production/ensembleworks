// Run: npx vitest run tests/page-title.test.ts
//
// WHAT THE BROWSER TAB IS CALLED, AND WHY THE DOCK CARES. Task C2b of
// docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-5).
//
// The presence strip reports its own `document.title` on every roster poll
// (canvas/dock/dock.ts's `selfReport`: `const title = document.title.trim()`),
// precisely so the server never has to look anything up. So putting the
// current PAGE NAME in `document.title` is the entire wire change needed to
// make the dock say which page somebody is on — there isn't one.
//
// That makes the title a REPORTED FACT rather than decoration, which is why
// every rule about it is here instead of in CanvasPanel.tsx: naming a page you
// are not on is the same "stale label is worse than none" failure
// canvas/dock/where.ts already refuses for stale locations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Page } from "@ensembleworks/canvas-model";
import {
  createPageDocumentTitle,
  decidePageDocumentTitle,
  decideTitleRestore,
  restorePageDocumentTitle,
  syncPageDocumentTitle,
  type DocumentTitleHost,
} from "../canvas/pages/page-title.js";
import { callArguments, countInCode, stripComments } from "./lib/source.js";

const HOST_TITLE = "bb";
const PAGES: Page[] = [
  { id: "page:a", name: "Canvas", index: "a0" },
  { id: "page:retro", name: "Retro", index: "a1" },
];

describe("decidePageDocumentTitle", () => {
  it("names the page the panel is showing", () => {
    // Bare page name, NOT "Canvas — Retro": canvas/dock/where.ts's
    // `locationLabel` wraps whatever arrives in quotes ("on the canvas —
    // “Retro”"), so anything else here reads back as a quoted mouthful.
    expect(
      decidePageDocumentTitle({
        pages: PAGES,
        currentPageId: "page:retro",
        original: HOST_TITLE,
        current: HOST_TITLE,
      }),
    ).toEqual({ kind: "set", title: "Retro" });
  });

  it("leaves the title alone when it already says the right thing", () => {
    // The effect re-runs on every doc change; rewriting an identical title on
    // each one is churn on a node the whole app observes.
    expect(
      decidePageDocumentTitle({
        pages: PAGES,
        currentPageId: "page:retro",
        original: HOST_TITLE,
        current: "Retro",
      }),
    ).toEqual({ kind: "leave" });
  });

  it("hands the title back to bb when currentPageId names no page", () => {
    // A REAL STATE, not a defensive shrug: it is what the panel looks like for
    // one render between a page-removing undo and canvas/pages/
    // history-repair.ts's clamp. Keeping the PREVIOUS page's name there would
    // publish it to every other client's dock — a name for a page nobody is
    // on. The host's own title is the only true thing left to say.
    expect(
      decidePageDocumentTitle({
        pages: PAGES,
        currentPageId: "page:gone",
        original: HOST_TITLE,
        current: "Retro",
      }),
    ).toEqual({ kind: "set", title: HOST_TITLE });
  });

  it("hands the title back for a page whose name is blank", () => {
    // An empty title is dropped by `selfReport` (it only reports a non-empty
    // one), so the dock would fall back to a flat "on the canvas" — but the
    // BROWSER TAB would be blank, which looks broken. The host's title is
    // better in both places.
    expect(
      decidePageDocumentTitle({
        pages: [{ id: "page:x", name: "   ", index: "a0" }],
        currentPageId: "page:x",
        original: HOST_TITLE,
        current: "Retro",
      }),
    ).toEqual({ kind: "set", title: HOST_TITLE });
  });

  it("trims, because the reported title is trimmed anyway", () => {
    expect(
      decidePageDocumentTitle({
        pages: [{ id: "page:x", name: "  Retro  ", index: "a0" }],
        currentPageId: "page:x",
        original: HOST_TITLE,
        current: HOST_TITLE,
      }),
    ).toEqual({ kind: "set", title: "Retro" });
  });
});

describe("decideTitleRestore — the panel does not leave its name behind", () => {
  it("puts the host's title back on unmount", () => {
    // A canvas page name left in `document.title` after you navigate away is
    // reported to every other client on the next 2s roster poll, from a tab
    // that is no longer on the canvas at all. That is a stale lie of exactly
    // the kind this codebase keeps refusing.
    expect(
      decideTitleRestore({ original: HOST_TITLE, wrote: "Retro", current: "Retro" }),
    ).toEqual({ kind: "set", title: HOST_TITLE });
  });

  it("leaves a title somebody else has since set", () => {
    // bb owns this node too. If the host re-titled the tab after the panel
    // last wrote, restoring would clobber a fresher, truer answer.
    expect(
      decideTitleRestore({ original: HOST_TITLE, wrote: "Retro", current: "bb — Settings" }),
    ).toEqual({ kind: "leave" });
  });

  it("leaves the title when the panel never wrote one", () => {
    // A panel that unmounted before its first snapshot has nothing to undo.
    expect(
      decideTitleRestore({ original: HOST_TITLE, wrote: null, current: HOST_TITLE }),
    ).toEqual({ kind: "leave" });
  });

  it("is a no-op when what we wrote was the host's title all along", () => {
    // The stranded-page branch above writes `original`; unmounting from that
    // state must not count as a change to undo.
    expect(
      decideTitleRestore({ original: HOST_TITLE, wrote: HOST_TITLE, current: HOST_TITLE }),
    ).toEqual({ kind: "leave" });
  });
});

// ---------------------------------------------------------------------------
// ACTUALLY TOUCHING THE TITLE. The two decisions above were well covered and
// still bought nothing: review on 2026-09-05 deleted the panel's whole
// `document.title` write effect, and separately its whole unmount restore, and
// the suite reported 751 passed each time — the wiring guards were satisfied by
// the panel's IMPORT lines. So the assignment itself lives here now, behind a
// two-method host a fake can stand in for, and the guards below require a CALL
// (with its parenthesis) in comment-stripped code rather than a mention.
// ---------------------------------------------------------------------------

function fakeHost(initial: string): DocumentTitleHost & { value: string } {
  const host = {
    value: initial,
    read: () => host.value,
    write: (title: string) => {
      host.value = title;
    },
  };
  return host;
}

describe("syncPageDocumentTitle — the page name reaches the tab", () => {
  it("writes the page name and reports what it wrote", () => {
    // THE MUTATION THIS CATCHES: deleting the write. Without it no page name
    // ever reaches anybody's dock and C2b is a no-op the tests call green.
    const host = fakeHost(HOST_TITLE);
    const wrote = syncPageDocumentTitle(host, {
      pages: PAGES,
      currentPageId: "page:retro",
      original: HOST_TITLE,
      wrote: null,
    });
    expect(host.value).toBe("Retro");
    expect(wrote).toBe("Retro");
  });

  it("reads the live title rather than being told it", () => {
    // bb owns this node; anything could have re-titled the tab since the last
    // pass. Reading through the host is what makes `decidePageDocumentTitle`'s
    // "leave it alone when it already says the right thing" arm reachable at
    // all.
    const host = fakeHost("Retro");
    const wrote = syncPageDocumentTitle(host, {
      pages: PAGES,
      currentPageId: "page:retro",
      original: HOST_TITLE,
      wrote: "Retro",
    });
    expect(host.value).toBe("Retro");
    expect(wrote).toBe("Retro");
  });

  it("keeps the previously written value when there is nothing to write", () => {
    // `wrote` is what the restore later compares against, so a no-op pass must
    // not forget it — forgetting would silently disable the restore.
    const host = fakeHost("Retro");
    expect(
      syncPageDocumentTitle(host, {
        pages: PAGES,
        currentPageId: "page:retro",
        original: HOST_TITLE,
        wrote: "Retro",
      }),
    ).toBe("Retro");
  });

  it("hands the tab back to bb when currentPageId names no page", () => {
    const host = fakeHost("Retro");
    const wrote = syncPageDocumentTitle(host, {
      pages: PAGES,
      currentPageId: "page:gone",
      original: HOST_TITLE,
      wrote: "Retro",
    });
    expect(host.value).toBe(HOST_TITLE);
    expect(wrote).toBe(HOST_TITLE);
  });
});

describe("restorePageDocumentTitle — the panel does not leave its name behind", () => {
  it("puts the host title back on unmount", () => {
    // THE MUTATION THIS CATCHES: deleting the restore. The departed page's
    // name would stay in `document.title` and be republished on every 2s
    // roster poll from a tab that has navigated away.
    const host = fakeHost("Retro");
    restorePageDocumentTitle(host, { original: HOST_TITLE, wrote: "Retro" });
    expect(host.value).toBe(HOST_TITLE);
  });

  it("leaves a title somebody else has since set", () => {
    const host = fakeHost("bb — Settings");
    restorePageDocumentTitle(host, { original: HOST_TITLE, wrote: "Retro" });
    expect(host.value).toBe("bb — Settings");
  });

  it("does nothing when the panel never wrote a title", () => {
    const host = fakeHost(HOST_TITLE);
    restorePageDocumentTitle(host, { original: HOST_TITLE, wrote: null });
    expect(host.value).toBe(HOST_TITLE);
  });
});

describe("createPageDocumentTitle — the two values the panel used to thread", () => {
  // WHY THIS EXISTS. `original` (bb's own title, read at mount) and `wrote`
  // (the last value this panel wrote) were two refs in CanvasPanel.tsx,
  // carried out of one effect and into another effect's cleanup — in a .tsx,
  // in a project with no jsdom. Mutation on 2026-09-05 showed nothing reached
  // either: dropping the `wroteTitleRef.current =` store, and separately
  // seeding `originalTitleRef` with `useRef("")`, each left `npx tsc --noEmit`
  // at exit 0 and the whole suite at 39 files / 843 tests passed. Both delete
  // the restore, and this panel's page name then rides out on every 2s roster
  // poll from a tab that has navigated away.
  //
  // With the values inside the controller the sequence is drivable, so these
  // tests are sequences: construct, sync, sync again, restore.

  it("puts bb's own title back after having borrowed the tab", () => {
    // THE `wrote` MUTATION, end to end: a controller that forgot what it wrote
    // answers "leave" here and the tab keeps saying "Retro".
    const host = fakeHost(HOST_TITLE);
    const title = createPageDocumentTitle(host);
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    expect(host.value).toBe("Retro");

    title.restore();

    expect(host.value).toBe(HOST_TITLE);
  });

  it("captures bb's title at construction, not from whatever it later says", () => {
    // THE `useRef("")` MUTATION, and its sibling — reading the "original" back
    // off the node AFTER this panel has written to it. Either way the restore
    // writes something that was never bb's: an empty tab, and an empty
    // `LocationReport.title` published to every peer.
    const host = fakeHost(HOST_TITLE);
    const title = createPageDocumentTitle(host);
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    // The fallback arm reads `original` too, so this pins the captured value
    // twice over: a page id naming nothing must hand the tab back to bb.
    title.sync({ pages: PAGES, currentPageId: "page:gone" });
    expect(host.value).toBe(HOST_TITLE);
  });

  it("remembers what it wrote across a pass that wrote nothing", () => {
    // The effect re-runs on every doc change, so most passes are "leave". A
    // controller that let `wrote` fall to null on one of them would disable the
    // restore silently — the same end state as the mutation above, reached by
    // a path a single-call test cannot see.
    const host = fakeHost(HOST_TITLE);
    const title = createPageDocumentTitle(host);
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    title.sync({ pages: PAGES, currentPageId: "page:retro" });

    title.restore();

    expect(host.value).toBe(HOST_TITLE);
  });

  it("follows the page across a switch", () => {
    const host = fakeHost(HOST_TITLE);
    const title = createPageDocumentTitle(host);
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    title.sync({ pages: PAGES, currentPageId: "page:a" });
    expect(host.value).toBe("Canvas");

    title.restore();

    expect(host.value).toBe(HOST_TITLE);
  });

  it("leaves a title somebody else has since set", () => {
    // bb owns this node; the departing panel is not automatically its last
    // writer (React runs a departing cleanup AFTER the arriving component's
    // effects). Restoring over a fresher answer is the failure the restore
    // exists to prevent, pointed backwards.
    const host = fakeHost(HOST_TITLE);
    const title = createPageDocumentTitle(host);
    title.sync({ pages: PAGES, currentPageId: "page:retro" });
    host.value = "bb — Settings";

    title.restore();

    expect(host.value).toBe("bb — Settings");
  });

  it("does nothing when it never borrowed the tab at all", () => {
    const host = fakeHost(HOST_TITLE);
    createPageDocumentTitle(host).restore();
    expect(host.value).toBe(HOST_TITLE);
  });

  it("gives each panel its own memory", () => {
    // Two controllers over one host must not share `wrote`: a restore from one
    // must not be authorised by what the other wrote.
    const host = fakeHost(HOST_TITLE);
    const first = createPageDocumentTitle(host);
    first.sync({ pages: PAGES, currentPageId: "page:retro" });
    const second = createPageDocumentTitle(host);

    second.restore();

    // `second` captured "Retro" as ITS original and wrote nothing, so it has
    // nothing to restore — the tab keeps what `first` put there.
    expect(host.value).toBe("Retro");
  });
});

const PANEL = readFileSync(
  new URL("../canvas/CanvasPanel.tsx", import.meta.url),
  "utf8",
);

const PANEL_CODE = stripComments(PANEL);

describe("the panel is wired to the title", () => {
  it("calls the title sync, rather than merely importing it", () => {
    // A CALL, with its parenthesis, in comment-stripped code. An earlier
    // version of this guard asserted `toContain("decidePageDocumentTitle")`,
    // which the import line satisfied on its own — the whole effect was
    // deleted and it stayed green.
    expect(PANEL_CODE).toContain("pageTitle.sync(");
  });

  it("hands the sync the live pages and the page being shown", () => {
    // MUTATION VERIFIED 2026-09-05: `pages: snapshot.pages,` -> `pages: [],`
    // at this call site left `npx tsc --noEmit` at exit 0 and the whole suite
    // at 39 files / 868 tests passed. `decidePageDocumentTitle` then never
    // finds the current page, so `name` is "" and the title falls back to bb's
    // `original` forever: the page name never reaches `document.title`, which
    // is the ONE wire field carrying it to anybody else's dock
    // (canvas/dock/dock.ts's `selfReport` -> canvas/dock/where.ts's
    // `locationLabel`). D-5 entirely dead, every test still green.
    //
    // Bounded to this call's own argument list, because
    // `currentPageId: editorState.currentPageId` appears at three other call
    // sites in the panel and `snapshot.pages` in several dependency arrays —
    // a file-wide `toContain` survives deleting either from HERE, and the
    // dependency-array guard below only proves the effect RE-RUNS on them.
    expect(countInCode(PANEL, "pageTitle.sync(")).toBe(1);
    // MUTATION VERIFIED 2026-09-05: `toContain` pins a PREFIX, so
    // `snapshot.pages.slice(0, 0)` — an empty page list, so the title can
    // never name the page — passed it with tsc at exit 0 and the suite at 882
    // tests. Both properties are therefore bounded to their whole value.
    const args = callArguments(PANEL_CODE, "pageTitle.sync");
    expect(args).toMatch(/[,{]\s*pages:\s*snapshot\.pages\s*,/);
    expect(args).toMatch(/[,{]\s*currentPageId:\s*editorState\.currentPageId\s*,/);
  });

  it("calls the restore on the way out, and only on the way out", () => {
    // The cleanup, with its dependency array verbatim. Adding the page or the
    // snapshot to those deps would run the restore on every page switch —
    // handing bb's title back mid-session and, worse, clearing what the
    // controller knows it wrote, which disables the restore that matters.
    expect(PANEL_CODE).toContain("useEffect(() => () => pageTitle.restore(), [pageTitle]);");
  });

  it("keeps no title state of its own", () => {
    // THE MUTATIONS THIS CATCHES, both verified on 2026-09-05 against the
    // panel as it stood when it held these two refs: removing the
    // `wroteTitleRef.current =` assignment (leaving a bare
    // `syncPageDocumentTitle(...)` call, which the old guard above still
    // accepted), and `originalTitleRef = useRef("")` in place of
    // `useRef(titleHost.read())`. Each typechecked, each left 39 files / 843
    // tests passing, and each deletes the restore outright.
    //
    // Both values live in the controller now, so the panel has no copy to get
    // wrong. Counted in CODE, not raw text — this file's own prose above names
    // `wrote` and `original` repeatedly, which is exactly the decoy
    // tests/source-guard.test.ts exists for.
    expect(countInCode(PANEL, "wrote")).toBe(0);
    expect(countInCode(PANEL, "original")).toBe(0);
    expect(countInCode(PANEL, "syncPageDocumentTitle")).toBe(0);
    expect(countInCode(PANEL, "restorePageDocumentTitle")).toBe(0);
  });

  it("holds one controller for the panel's whole life", () => {
    // Constructing the controller is what captures bb's title, so a controller
    // rebuilt mid-life re-captures it from a title THIS PANEL wrote — and the
    // restore then writes the page name back instead of bb's, which is the
    // `useRef("")` mutation with a different wrong value. Constructed exactly
    // once, through the lazy-REF idiom rather than a `useMemo`: React is free
    // to discard a memoised value and recompute it.
    expect(countInCode(PANEL, "createPageDocumentTitle(")).toBe(1);
    expect(PANEL_CODE).toContain("useRef<PageDocumentTitle | null>(null)");
    expect(PANEL_CODE).toContain("pageTitleRef.current ??= createPageDocumentTitle(titleHost)");
  });

  it("re-syncs when the page or the document moves", () => {
    // Without both deps the tab keeps the name of whatever page the panel
    // opened on, and every peer's dock reads that stale name off the wire.
    const after = PANEL_CODE.slice(PANEL_CODE.indexOf("pageTitle.sync("));
    const deps = /\}, \[([^\]]*)\]\);/.exec(after);
    expect(deps, "no dependency array follows the sync call").not.toBeNull();
    expect(deps![1]).toContain("editorState.currentPageId");
    expect(deps![1]).toContain("snapshot.pages");
  });

  it("touches document.title only through the host it hands over", () => {
    // Exactly two references, and both inside the adapter: the read and the
    // write. Anything else in the .tsx is a title rule written where no test
    // in this jsdom-free project could reach it.
    const reads = PANEL_CODE.match(/document\.title/g) ?? [];
    expect(reads).toHaveLength(2);
    expect(PANEL_CODE).toContain("read: () => document.title");
  });

  it("builds no title string of its own", () => {
    // A template literal assembling a title in the .tsx would be a string
    // nothing in this jsdom-free project could read back.
    expect(PANEL_CODE.match(/document\.title\s*=\s*`/g) ?? []).toEqual([]);
  });
});
