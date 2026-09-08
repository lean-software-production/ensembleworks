// WHETHER THE TAB BAR IS DRAWN AT ALL.
//
// Task C1a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md, D-2. The
// tab bar is a straight port of client/src/canvas-v2/PageSwitcher.tsx, and
// ported unchanged it costs a PERMANENT ROW — one per panel, forever, whether
// or not the room has more than one page. In the standalone client that was
// the plan's accepted judgement call #1; inside a bb nav panel it lands on
// exactly the narrow viewports canvas/dock/squeeze.ts's ladder exists to
// defend, and it competes with the drawing surface rather than with a title.
//
// So the tab bar is the WIDE-VIEWPORT AFFORDANCE and the button-and-popover is
// the one that is always there. This module is the gate, and it is a module
// rather than an `if` in the .tsx for the reason squeeze.ts states in its own
// header: this project has no jsdom, so a threshold written inline is a
// threshold no test can reach.
//
// THE TWO NUMBERS YOU WILL ACTUALLY OBSERVE ARE 408 AND 312, NOT 360. Stated
// first because a tester who reads PAGE_TABS_MIN_PX below and then drags a
// pane to 360px will see nothing happen and reasonably conclude the feature is
// broken.
//   * The row APPEARS when the column reaches 408 (= 360 + 48 hysteresis).
//   * Once drawn, it stays until the column drops BELOW 312 (= 360 - 48), so
//     312 still shows it and 311 does not.
//   * 360 itself is never a boundary anything crosses.
// WHY: the bare threshold only governs `choosePageTabsVisible`, the answer
// with no history, and in this wiring that call always lands on the not-a-
// measurement branch. CanvasPanel.tsx holds `columnWidth` at `useState(0)` and
// hands it straight to `usePageSwitcher`, whose `useState(() =>
// choosePageTabsVisible(containerWidth))` initialiser therefore runs exactly
// once, with 0, and hides the row. Every decision after that is
// `nextPageTabsVisible(false, w)` — the hysteresis band, and the `false` side
// of it — until the row first appears. There is no path on which a real
// measurement reaches `choosePageTabsVisible`: a nonzero first value would
// need CanvasPanel to mount with `columnWidth` already measured, and its
// initial state is the literal 0.
//
// READ IN THE TREE, NOT OBSERVED RUNNING (same standard as the rest of this
// file — no browser has been pointed at any of it). The arithmetic and the
// wiring are facts about the source; that a user drags a pane past these
// widths and sees exactly this is the inference drawn from them.
//
// WHAT THE CALLER MEASURES. The canvas column's width — CanvasPanel.tsx
// already keeps one, from the ResizeObserver on the viewport element, and that
// element is the same column the tab bar would sit above. Two notes on that,
// both load-bearing:
//   * It is the COLUMN, not the window. Opening the thread aside genuinely
//     narrows the column (the aside is a flex sibling, not an overlay), so the
//     tab bar retreats when the canvas is squeezed by bb's own furniture, not
//     only when the window is small.
//   * Showing or hiding this row cannot change the width it is measured
//     against. That was true when the row was a flex sibling ABOVE the
//     viewport (it took height from the viewport and no width) and it is true
//     for a different reason since 2026-09-05: the row LEFT THE FLOW
//     altogether and now floats over the canvas inside the chrome dock
//     (canvas/pages/chrome-dock.ts), so it takes neither height nor width from
//     the box the ResizeObserver measures. There is no feedback loop here,
//     which is worth stating because the hysteresis below looks like a defence
//     against one and is not.
//   * WHAT THE GATE NOW COSTS, AND WHY IT IS STILL HERE. It no longer buys
//     canvas HEIGHT back — the floating row costs none. It still refuses to
//     draw a horizontally-scrolling strip of tabs across a phone-width panel,
//     where it would cover the drawing surface and be the widest thing in the
//     card. The Pages button is unchanged and lists every page at any width.

/**
 * The narrowest canvas column that gets the tab bar — the CENTRE of the
 * hysteresis band, not an edge of it. Nothing visibly changes at 720; see the
 * header's "THE TWO NUMBERS YOU WILL ACTUALLY OBSERVE" for the 768/672 a
 * person watching the panel sees, and why.
 *
 * A JUDGEMENT CALL, AND NOBODY HAS MEASURED IT IN A BROWSER. The arithmetic it
 * comes from, so the next reader can argue with the reasoning rather than the
 * digits: in the ported component a tab group is a name button (`padding:
 * '4px 10px'` at `fontSize: 12` — call it 70px for a short name) plus three
 * 6px-padded micro-buttons at about 22px each, so roughly 136px per page, plus
 * the "+" button. Four pages is therefore ~580px of row before the canvas gets
 * anything, and below that the bar is mostly a horizontal scroller — which is
 * strictly worse than the popover, because the popover shows every page at
 * once and never steals canvas height. 720px leaves the four-page case real
 * breathing room and sits a little under a typical laptop half-screen.
 *
 * DELIBERATELY NOT `SQUEEZE_ROOMY_MIN_PX` (760), and not imported from it: the
 * dock's ladder is about bb's page-header row and what a thread TITLE needs,
 * this is about a canvas column and what a drawing surface needs. Two numbers
 * that happen to be near each other are not one number, and coupling them
 * would mean a retune of the presence strip silently moved the canvas's tab
 * bar.
 */
export const PAGE_TABS_MIN_PX = 360;

/*
 * WHY 360, AND WHY IT WAS 720 (owner bug, 2026-09-06: "i'm not seeing the tabs
 * at all").
 *
 * 720 was chosen when this strip was a SECOND row of chrome stacked on the
 * floating toolbar at the bottom: it competed for vertical space with the
 * drawing surface, and the Pages button offered the same capability in no
 * space at all, so giving up the row early was nearly free.
 *
 * The strip is now the PRIMARY page navigation, in the flow at the top of the
 * column where a tab strip conventionally lives. Hiding it on an ordinary
 * panel width is no longer a graceful degradation, it is the feature going
 * missing — which is precisely what the owner saw. Compounding it: the gate is
 * seeded `false` (columnWidth is 0 until the first measurement), so the width
 * that actually REVEALED the row was MIN + HYSTERESIS = 768, not 720.
 *
 * 360 keeps a real floor — below ~408px revealed there is not room to seat a
 * tab and read its name, and the Pages button still covers the capability —
 * while letting every ordinary canvas column show its tabs. The strip already
 * scrolls (`overflowX: auto` on tabBarStyle), so more pages than fit is a
 * scroll, never an overflow.
 *
 * NOT MEASURED IN A BROWSER — this spike has none. 360 is a judgement about
 * legible tab width, not an observation.
 */

/**
 * How far past the threshold the width must travel before the row follows it.
 *
 * The same 48px canvas/dock/squeeze.ts uses, for the same two twitches — a
 * scrollbar appearing and disappearing (~15px) and a pane divider held near
 * the boundary — but declared here rather than imported, for the reason given
 * on PAGE_TABS_MIN_PX above. A row appearing and disappearing at frame rate
 * during a drag reads as a rendering fault, and this row moves the canvas
 * underneath it every time it does.
 */
export const PAGE_TABS_HYSTERESIS_PX = 48;

/** Is this number something that was actually measured? Same test and same
 * wording as squeeze.ts and popover-place.ts: 0 is what a detached or
 * not-yet-laid-out element reports, and NaN/Infinity are what a failed read
 * gives back. */
function isMeasurement(width: number): boolean {
  return Number.isFinite(width) && width > 0;
}

/**
 * The answer with no history — the first render, before any width has been
 * seen.
 *
 * A WIDTH THAT IS NOT A MEASUREMENT HIDES THE TABS, and the two failures are
 * not symmetrical: a tab bar that failed to appear costs nothing, because the
 * Pages button beside the tools is always drawn and lists every page; a tab
 * bar drawn on a phone-width panel eats canvas height and there is no
 * affordance to get it back.
 *
 * WHETHER THAT BRANCH IS THE MOUNT PATH IS THE CALLER'S DOING, NOT A FACT
 * ABOUT BROWSERS, and this comment previously claimed otherwise. What is
 * actually known, read in the tree rather than observed running: CanvasPanel
 * holds `columnWidth` at 0 until its ResizeObserver effect fires, and passes
 * that raw number here — so on the first render this function is called with 0
 * and hides the row. It is deliberately NOT given `viewportSize.width`, which
 * carries a fabricated 1024 fallback for shape culling; fed that, this branch
 * would be unreachable and the safety property above would be false for the
 * first frame of every narrow panel.
 *
 * tests/page-tabs-fit.test.ts pins BOTH ENDS of that wiring, and it is worth
 * being precise about which two, because for a day it only pinned one:
 *   * the PANEL end — `columnWidth` is `useState(0)`, declared once, handed to
 *     `containerWidth:` unmodified, and never given the `|| 1024` culling
 *     fallback;
 *   * the HOOK end — `usePageSwitcher` seeds its `tabsVisible` from
 *     `choosePageTabsVisible(containerWidth)` rather than from a literal,
 *     re-decides every width change through `nextPageTabsVisible(<what is
 *     drawn>, containerWidth)` rather than re-answering historyless, and gates
 *     the tab-bar node on that state.
 * The hook end was ADDED on 2026-09-05, after review found it missing: cutting
 * the initialiser down to `useState(true)` and the width effect down to `void
 * containerWidth;` — which deletes everything this module does to what anyone
 * sees, and starts the row visible on a phone-width panel — reported 39 files
 * / 819 tests passed, byte-identical to the unmutated baseline. Both ends are
 * pinned as CODE rather than as text: the guards read each file through
 * `stripComments` (tests/lib/source.ts). That detail is the whole guard.
 * Until 2026-09-05 the panel guard read the file raw, and raw it could be
 * satisfied by a comment — a single commented-out `// const [columnWidth,
 * setColumnWidth] = useState(0);` line above a real `useState(1024)` left the
 * suite green with the initial width at 1024, which makes the 768/672 stated
 * at the top of this file quietly false. VERIFIED BY MUTATION, 2026-09-05,
 * both directions: with that decoy in the panel the raw-text guard reported 12
 * passed and the stripped one failed on `starts at 0`; with the wiring
 * restored, 13 passed. (Those are that file's counts on the day; it holds 18
 * tests now that the hook end is guarded too.)
 *
 * A CONSEQUENCE WORTH SPELLING OUT: because 0 is the only width this function
 * is ever called with in the shipped wiring, its `width >= PAGE_TABS_MIN_PX`
 * comparison never actually decides anything — it is exercised by
 * tests/page-tabs-fit.test.ts and by nothing else. That is why 720 is not a
 * width a user can observe. The function is kept honest and total anyway
 * (rather than collapsed to `return false`) because "the answer with no
 * history" is a real question with a real answer, and a second caller that
 * mounted already-measured would need it.
 *
 * NOTHING HERE WAS SEEN IN A BROWSER. Whether a real ResizeObserver's first
 * callback lands before or after the first paint is not established by this
 * spike — but it does not need to be: either order starts from 0 and ends at a
 * measurement, and this function's answer is safe at both ends.
 */
export function choosePageTabsVisible(width: number): boolean {
  if (!isMeasurement(width)) return false;
  return width >= PAGE_TABS_MIN_PX;
}

/**
 * The answer given what is already on screen.
 *
 * The band around PAGE_TABS_MIN_PX belongs to whatever is currently drawn:
 * appearing needs a full band ABOVE the threshold, disappearing needs a full
 * band BELOW it. A width inside the band changes nothing.
 *
 * A width that is not a measurement HOLDS the current row rather than choosing
 * afresh — a failed read must never be the reason a row appears or vanishes,
 * which is the same call `nextSqueeze` makes for the presence strip.
 */
export function nextPageTabsVisible(visible: boolean, width: number): boolean {
  if (!isMeasurement(width)) return visible;
  if (visible) return width >= PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX;
  return width >= PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX;
}
