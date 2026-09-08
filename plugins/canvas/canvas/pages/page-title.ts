// WHAT THE BROWSER TAB IS CALLED WHILE THE CANVAS IS OPEN. No DOM here — the
// panel does the assigning; this decides what to assign.
//
// Task C2b of docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-5).
//
// `document.title` IS A WIRE FIELD IN THIS PLUGIN. That is the whole reason
// these rules are worth a module. The presence strip reads its own
// `document.title` on every roster poll and sends it as `LocationReport.title`
// (canvas/dock/dock.ts's `selfReport`), specifically so the server never has
// to look anything up; canvas/dock/where.ts's `locationLabel` then renders it
// as the page name in "on the canvas — “Retro”". The path carries a page ID,
// never a name, so this is the ONLY route by which a page's name reaches
// another person's dock — and it costs no protocol change at all.
//
// Which also means a wrong title is not cosmetic: it is published to everyone
// else on the next 2s poll. Every fallback below is chosen on that basis
// rather than on how the tab looks.
//
// NOT VERIFIED: whether bb's own shell re-asserts `document.title` on its own
// schedule. If it does, the panel's write is simply overwritten and the dock
// falls back to a flat "on the canvas" — which is the honest degradation, not
// a wrong answer. `decideTitleRestore` below is built for the same uncertainty
// from the other end.
import { type Page } from "@ensembleworks/canvas-model";

/** What to do with `document.title`. A union rather than a bare string so the
 * "leave it alone" answer is a value the panel dispatches on, instead of a
 * comparison written in the .tsx where nothing could read it. */
export type DocumentTitleAction =
  | { readonly kind: "leave" }
  | { readonly kind: "set"; readonly title: string };

/**
 * The title for a panel showing `currentPageId`.
 *
 * THE BARE PAGE NAME, nothing around it: `locationLabel` wraps whatever
 * arrives in quotes, so a decorated title reads back as a quoted mouthful in
 * everybody else's dock.
 *
 * FALLING BACK TO THE HOST'S OWN TITLE is the interesting half. Two states
 * reach it: `currentPageId` naming no page (what the panel looks like for one
 * render between a page-removing undo and canvas/pages/history-repair.ts's
 * clamp — the same real state `pageMenuRows` documents by marking no row
 * current), and a page whose name is blank. Keeping the PREVIOUS page's name
 * in either case would publish a page name for a page nobody is on, which is
 * the "a stale label is worse than none" failure canvas/dock/where.ts already
 * refuses for stale locations. Writing an empty string instead would leave the
 * browser tab blank, which looks broken to the person actually sitting there.
 * `original` is true in both places.
 */
export function decidePageDocumentTitle(input: {
  readonly pages: readonly Page[];
  readonly currentPageId: string;
  /** `document.title` as it was when the panel mounted — bb's own. */
  readonly original: string;
  /** `document.title` right now. */
  readonly current: string;
}): DocumentTitleAction {
  const page = input.pages.find((candidate) => candidate.id === input.currentPageId);
  const name = page === undefined ? "" : page.name.trim();
  const desired = name.length > 0 ? name : input.original;
  // The panel re-runs this on every doc change, so an identical rewrite would
  // be churn on a node the whole app can observe.
  return desired === input.current ? { kind: "leave" } : { kind: "set", title: desired };
}

/**
 * Put the host's title back when the panel goes away.
 *
 * WHY IT IS NOT AN UNCONDITIONAL ASSIGNMENT. `document.title` belongs to bb;
 * this panel only borrows it. React runs a departing component's cleanup AFTER
 * the arriving one's effects (StrictMode's double-mount does exactly this, as
 * does any remount), and bb may re-title the tab on a route change of its own
 * — so by the time this runs, the title may already be somebody else's fresher
 * answer. Restoring over it would replace a true title with a stale one, which
 * is the failure the restore exists to prevent, pointed the other way.
 *
 * The test is therefore "are we still the last writer": restore only when the
 * title is verbatim what this panel last wrote.
 */
export function decideTitleRestore(input: {
  /** `document.title` as captured at mount. */
  readonly original: string;
  /** The last value this panel wrote, or null if it never wrote one. */
  readonly wrote: string | null;
  /** `document.title` right now. */
  readonly current: string;
}): DocumentTitleAction {
  if (input.wrote === null) return { kind: "leave" };
  if (input.current !== input.wrote) return { kind: "leave" };
  if (input.current === input.original) return { kind: "leave" };
  return { kind: "set", title: input.original };
}

/**
 * The one node this feature touches, behind two methods.
 *
 * WHY A PORT AND NOT A DIRECT `document.title =` IN THE PANEL. There is no
 * jsdom in this project, so an assignment written in CanvasPanel.tsx is an
 * assignment nothing can watch. Review on 2026-09-05 deleted the panel's
 * entire title effect, and separately its entire unmount restore, and the
 * suite stayed green both times — the guards were satisfied by the panel's
 * import lines. Behind this interface a fake host watches the write happen.
 *
 * `read` is a method rather than a value because bb owns the title too: it may
 * have re-titled the tab since the last pass, and both decisions below turn on
 * what it says RIGHT NOW.
 */
export interface DocumentTitleHost {
  read(): string;
  write(title: string): void;
}

/**
 * Bring the tab's title in line with the page the panel is showing, and return
 * the value to remember as "what this panel last wrote" — which is what
 * `restorePageDocumentTitle` later compares against.
 *
 * A pass with nothing to do returns the previous `wrote` unchanged rather than
 * null: forgetting it would silently disable the restore, leaving this panel's
 * page name in a tab that has navigated away.
 */
export function syncPageDocumentTitle(
  host: DocumentTitleHost,
  input: {
    readonly pages: readonly Page[];
    readonly currentPageId: string;
    /** `document.title` as it was when the panel mounted — bb's own. */
    readonly original: string;
    /** The last value this panel wrote, or null if it never wrote one. */
    readonly wrote: string | null;
  },
): string | null {
  const action = decidePageDocumentTitle({
    pages: input.pages,
    currentPageId: input.currentPageId,
    original: input.original,
    current: host.read(),
  });
  if (action.kind === "leave") return input.wrote;
  host.write(action.title);
  return action.title;
}

/**
 * Hand the tab's title back to bb, iff this panel is still its last writer.
 * See `decideTitleRestore` for why that condition is not optional.
 */
export function restorePageDocumentTitle(
  host: DocumentTitleHost,
  input: {
    readonly original: string;
    readonly wrote: string | null;
  },
): void {
  const action = decideTitleRestore({
    original: input.original,
    wrote: input.wrote,
    current: host.read(),
  });
  if (action.kind === "set") host.write(action.title);
}

/**
 * The panel's title borrowing, with `original` and `wrote` already inside it.
 *
 * WHY THE STATE MOVED IN HERE. `syncPageDocumentTitle` hands `wrote` back and
 * `restorePageDocumentTitle` needs it, so the panel was threading a value from
 * one effect into another effect's cleanup. Mutation on 2026-09-05 showed that
 * thread was unguarded: dropping the `wroteTitleRef.current =` assignment, and
 * separately seeding `originalTitleRef` with `useRef("")` instead of
 * `useRef(titleHost.read())`, each left `npx tsc --noEmit` at exit 0 and the
 * whole spike suite at 39 files / 843 tests passed. Both are total losses of
 * the restore, and this project has no jsdom in which to have caught either.
 *
 * WHAT EACH ONE DOES AT RUNTIME. With `wrote` never stored,
 * `decideTitleRestore` sees null and answers "leave" every time — so this
 * panel's page name stays in `document.title` after the panel is gone, and
 * canvas/dock/dock.ts's `selfReport` republishes it to everybody else on every
 * 2s roster poll from a tab that is no longer on the canvas. With `original`
 * empty, the restore that does happen writes "" — a blank tab, and a blank
 * `LocationReport.title`.
 *
 * `original` IS CAPTURED AT CONSTRUCTION, which is why this is a factory and
 * not a pair of free functions: the value has to be read at the last moment
 * the title is still bb's own, and "the last moment" is a lifetime fact, not
 * an argument a caller can be trusted to re-derive. The panel makes one of
 * these on its first render.
 *
 * ONE PER PANEL, and it must outlive every render — a controller rebuilt
 * mid-life would re-read `original` from a title THIS PANEL wrote, and the
 * restore would then put the page name back rather than bb's. That is a React
 * fact rather than this module's, and CanvasPanel.tsx states it where it holds
 * the controller.
 */
export interface PageDocumentTitle {
  /** Bring the tab in line with the page being shown. Safe to call on every
   * doc change; a pass with nothing to do writes nothing. */
  sync(input: { readonly pages: readonly Page[]; readonly currentPageId: string }): void;
  /** Hand the tab back to bb, iff this panel is still its last writer. */
  restore(): void;
}

/**
 * Start borrowing `host`'s title. Reads it immediately — see
 * `PageDocumentTitle` for why that read is this function's job and not the
 * caller's.
 */
export function createPageDocumentTitle(host: DocumentTitleHost): PageDocumentTitle {
  const original = host.read();
  let wrote: string | null = null;
  return {
    sync(input) {
      wrote = syncPageDocumentTitle(host, {
        pages: input.pages,
        currentPageId: input.currentPageId,
        original,
        wrote,
      });
    },
    restore() {
      restorePageDocumentTitle(host, { original, wrote });
    },
  };
}
