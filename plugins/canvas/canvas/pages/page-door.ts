// The one seam between bb's quick palette and the canvas panel's page menu.
//
// Task C1a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md, D-2 —
// "a 'Canvas: go to page…' command costs zero pixels and is the fastest path
// for anyone who knows the page's name".
//
// WHY THE PALETTE CANNOT SIMPLY LIST THE PAGES. Read off the SDK's bundled
// types rather than assumed: `PluginCommandPaletteActionRegistration` is
// `{ id, title, isAvailable?, run }` — ONE static row with a fixed title,
// registered inside `definePluginApp`'s setup callback, and its context
// (`PluginCommandPaletteActionContext`) carries `threadId`, `projectId` and
// `openPanel` and nothing else. There is no API for a row per page and no
// navigate in that context. So the palette is a DOOR onto the list the canvas
// panel already draws: the command opens the page popover (with its filter
// focused, which is where the "knows the page's name" speed actually comes
// from), rather than being the list itself.
//
// WHY A MODULE SINGLETON. Identical to canvas/dock/transcript-door.ts's
// reasoning, which is why this file is short: the palette registration lives
// in app.tsx at module scope, the page menu lives in a React component inside
// the nav panel, and there is no common plugin ancestor to hang a context on.
// One bundle in one window, so a singleton reaches both.
//
// THE HONEST LIMIT, stated rather than glossed: the command can only work
// while the canvas panel is MOUNTED, because the menu it opens is the panel's.
// Off the canvas route there is nothing to open and nothing in the palette's
// context to navigate there with, so the row hides itself — the same
// `isAvailable` idiom app.tsx's transcript row already uses ("hiding the row
// where it would decline beats offering a command that does nothing"). That
// the panel unmounts on a route change is inferred from React route semantics
// and from the transcript door's measured behaviour on the same host; it has
// not been observed for this panel.

/** What came back from an attempt to open the page menu. `status` is a
 * sentence for the user — a refusal that says nothing is indistinguishable
 * from a broken command. */
export type PageDoorOutcome =
  | { readonly kind: "opened" }
  | { readonly kind: "no-door"; readonly status: string };

/** Should the palette list the "go to page" row at all? */
export function decidePageCommandAvailable(input: { hasDoor: boolean }): boolean {
  return input.hasDoor;
}

/**
 * Read the answer to an open attempt.
 *
 * `hadDoor` false is reachable even though `isAvailable` hid the row: `run`
 * executes AFTER the palette closes and focus is restored (the SDK's own
 * wording), so a route change in between leaves nobody to ask.
 */
export function interpretPageOpen(hadDoor: boolean): PageDoorOutcome {
  if (hadDoor) return { kind: "opened" };
  return {
    kind: "no-door",
    status: "The page list lives on the canvas — open the Canvas panel first.",
  };
}

type Opener = () => void;

let opener: Opener | null = null;

export const pageDoor = {
  /**
   * Publish the mounted panel's "open the page menu" function. Returns an
   * unregister for the effect's cleanup — and that unregister only fires if
   * this handler is still the current one, because React runs a departing
   * component's cleanup AFTER the arriving one has registered (StrictMode's
   * double-mount does exactly this, as does a remount). Copied deliberately
   * from transcriptDoor.setOpener, including this reason.
   */
  setOpener(open: Opener): () => void {
    opener = open;
    return () => {
      if (opener !== open) return;
      opener = null;
    };
  },

  /** Is a canvas panel mounted right now? The palette's `isAvailable` is
   * called synchronously while the palette is open, so this is a plain read
   * and there is nothing to subscribe to — unlike the dock, which is
   * imperative DOM and has to be told. */
  hasOpener(): boolean {
    return opener !== null;
  },

  /** Open the menu, and say honestly what happened. */
  open(): PageDoorOutcome {
    const current = opener;
    if (current === null) return interpretPageOpen(false);
    current();
    return interpretPageOpen(true);
  },
};
