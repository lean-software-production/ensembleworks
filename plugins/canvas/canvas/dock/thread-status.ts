// The thread-row presence decoration — which rows should carry which faces,
// and, given what is on them already, what to add, update and remove.
//
// WHY THIS IS NO LONGER `experimental_setThreadRowStatus`. It was, and the
// product owner reported the defect that killed it:
//
//   "When you hover over the eye, the row state changes to show the archive
//    button and loses the eye; so you can never see who the eye refers to."
//
// The host paints a plugin's row status into the row's DRAFT-GLYPH SLOT, which
// is the same 28px slot bb reclaims for the row's hover actions
// (`.bb-sidebar-hover-actions-row` / `-inset` are the host's own names for that
// mechanism). So the glyph was replaced on hover — and its label, the only
// place "who" could be said, could only be read BY hovering. Unreadable by
// construction.
//
// The payload could not express the ask either. `PluginComposerThreadRowStatus`
// is `{icon: string, label: string, tone?}` where `icon` is a name from bb's
// own registry ("Eye" is real; so is "EyeOff"). There is no per-person colour
// and no avatar in it, so "the same coloured circle as in the header av dock"
// was not sayable through that door at any price.
//
// SO THE PLUGIN DRAWS THE CIRCLES ITSELF, into the row's TITLE span rather than
// the contested slot — which is what the SDK's own content-script docs sanction:
// "Styling or decorating existing app-shell DOM belongs here rather than in an
// always-on frontend stylesheet."
//
// EVERYTHING IN THIS FILE IS A DECISION AND NONE OF IT IS DOM. There is no
// jsdom in this project and never will be, so anything decided inline in
// dock.ts against `document` is decided where no test can reach it. dock.ts
// gets hands only: it reads the rows, calls `threadRowPresence` and
// `planRowDecorations`, and does exactly what it is told.
import { colorForName } from "../identity.js";
import { initialsFor } from "../roster.js";
import type { BbLocation } from "./where.js";

/**
 * How many circles a row draws before folding the rest into "+N".
 *
 * THE STRIP'S CONVENTION, SCALED TO THE ROW, not a second overflow idiom
 * invented here: the strip draws MAX_DOCK_BUBBLES faces and then "+N"
 * (canvas/dock/model.ts), and this does the same thing with a smaller cap
 * because the space is smaller. Measured on the running app: the row is 293px
 * wide, its title span 249px of that, and the title itself starts at 16px — so
 * three 18px circles overlapped by 5px plus a gap is ~50px, about a fifth of
 * the span, and leaves the thread title readable. Six would not.
 */
export const MAX_ROW_FACES = 3;

/**
 * What the decoration calls YOU.
 *
 * Never your own resolved name echoed back: on your own row "you viewing" is a
 * sentence and "mrdavidlaing viewing" is a stranger with your name.
 */
export const SELF_LABEL = "you";

/** One person, and where they are. `location` is null for unknown OR STALE —
 * canvas/locations.ts nulls a location past LOCATION_STALE_MS. */
export interface Viewer {
  readonly name: string;
  readonly location: BbLocation | null;
}

/**
 * One circle on a row — deliberately the same three fields the strip's
 * `DockBubble` carries for its faces, derived from the same two helpers.
 *
 * `initials` and `color` ALWAYS come from the person's REAL name, self
 * included. That is the whole request: one person is one colour and one pair of
 * initials, in the header strip and on the sidebar row. Only `label` changes
 * for you, and it changes to `you`.
 */
export interface RowFace {
  readonly name: string;
  /** `you`, or the person's name. What the accessible label says. */
  readonly label: string;
  readonly initials: string;
  readonly color: string;
  readonly isSelf: boolean;
}

/** One row's decoration, complete. */
export interface RowPresence {
  readonly threadId: string;
  /** The circles to draw, at most MAX_ROW_FACES, self first. */
  readonly faces: readonly RowFace[];
  /** How many viewers did not fit — the "+N". */
  readonly overflow: number;
  /**
   * The accessible name: `you, matt viewing`.
   *
   * NAMES EVERYBODY, including the ones folded into "+N". This is the answer
   * to "who", and hiding names behind a count that a screen reader cannot
   * expand would re-create the defect this change exists to fix.
   */
  readonly label: string;
  /**
   * A string that is equal for two decorations that would render identically,
   * and different otherwise.
   *
   * This is what makes "a row whose viewers changed updates, and a row where
   * nothing changed is not touched" a comparison rather than a re-render. It
   * lives on the decoration node as a data attribute, so it is also the
   * plugin's read-back: the DOM remembers, not a map in the content script that
   * a host re-render could silently invalidate.
   */
  readonly signature: string;
}

/**
 * Which rows should carry which faces.
 *
 * CALLERS PASS EVERY LOCATED TAB, YOUR OWN INCLUDED. The row you are reading
 * lights up too — that was asked for directly — but it is labelled `you`, and
 * `you` comes FIRST, so a shared thread reads `you, matt viewing` and never
 * `matt, you viewing`.
 *
 * `selfName` is `resolveSelfName`'s answer, and it is genuinely nullable: off
 * the canvas page, out of a call, with the identity fetch unresolved, the strip
 * does not know which name is yours. Null therefore means NOBODY is `you` —
 * every viewer is named. The two ways to get this wrong are calling everybody
 * `you` (a lie on every row) and silently dropping the unknown self (the row
 * you are on goes dark for no reason); naming everyone is neither.
 *
 * Names are deduplicated and ordered: one person with three tabs on a thread is
 * one circle — and your own several tabs collapse to a single `you` — while a
 * fixed order (self first, then localeCompare) stops the signature churning
 * every time the roster is re-serialised in a different tab order.
 */
export function threadRowPresence(
  viewers: readonly Viewer[],
  selfName: string | null,
): Map<string, RowPresence> {
  interface Row {
    self: boolean;
    readonly others: Set<string>;
  }
  const byThread = new Map<string, Row>();
  for (const viewer of viewers) {
    const location = viewer.location;
    if (location === null || location.kind !== "thread") continue;
    const row = byThread.get(location.threadId) ?? {
      self: false,
      others: new Set<string>(),
    };
    if (selfName !== null && viewer.name === selfName) row.self = true;
    else row.others.add(viewer.name);
    byThread.set(location.threadId, row);
  }

  const out = new Map<string, RowPresence>();
  for (const [threadId, row] of byThread) {
    const others = [...row.others].sort((a, b) => a.localeCompare(b));
    const names: readonly string[] =
      row.self && selfName !== null ? [selfName, ...others] : others;

    // Over the cap YOU are the face that never gets dropped, for the same
    // reason the strip keeps yours: the row you are reading must show that you
    // are on it, whoever else is folded away. Self is already first, so this is
    // a plain prefix.
    const drawn = names.slice(0, MAX_ROW_FACES);
    const faces = drawn.map((name): RowFace => {
      const isSelf = selfName !== null && name === selfName;
      return {
        name,
        label: isSelf ? SELF_LABEL : name,
        // The real name, always — the join to the strip's own face.
        initials: initialsFor(name),
        color: colorForName(name),
        isSelf,
      };
    });

    const label = `${names
      .map((name) => (selfName !== null && name === selfName ? SELF_LABEL : name))
      .join(", ")} viewing`;

    out.set(threadId, {
      threadId,
      faces,
      overflow: names.length - faces.length,
      label,
      signature: signatureOf(faces, names.length - faces.length, label),
    });
  }
  return out;
}

/**
 * What the decoration node has to say about itself for the next pass to
 * recognise it.
 *
 * Every field that reaches the DOM is in here — the drawn faces (name, hue,
 * initials, self), the overflow count and the accessible label — and nothing
 * that does not. A field left out would be a decoration that silently stops
 * updating; a field added that does not render would be a rewrite every tick.
 * The separators are control characters so no name can forge one.
 */
/** ASCII unit/record/group separators: no display name, hue or label can
 * contain one, so no viewer can forge a signature that collides with
 * another. */
const UNIT = "\u001f";
const RECORD = "\u001e";
const GROUP = "\u001d";

function signatureOf(
  faces: readonly RowFace[],
  overflow: number,
  label: string,
): string {
  const drawn = faces
    .map((face) => [face.name, face.initials, face.color, face.isSelf ? "1" : "0"].join(UNIT))
    .join(RECORD);
  return `${drawn}${GROUP}+${overflow}${GROUP}${label}`;
}

/** One thread row as it is in the sidebar right now. */
export interface RowSlot {
  readonly threadId: string;
  /** The `data-canvas-row-presence` value read off the decoration already on
   * this row, or null when it carries none. */
  readonly signature: string | null;
  /**
   * Whether that decoration is still the FIRST child of the row's title span.
   *
   * anchor.ts's rule, applied to a second React container. Writing a foreign
   * node into a container React owns is safe — React reconciles only the
   * children it created itself and never walks the container looking for
   * strangers — on ONE condition: that we notice when our position has drifted
   * and restore it. React's own `insertBefore`/`removeChild` can shuffle a
   * foreign node's position but not its existence, so the failure mode is a
   * decoration that ends up BEHIND the thread title, not one that disappears.
   *
   * Read only when there is a decoration to have a position; `true` is the
   * meaningless answer when `signature` is null.
   */
  readonly leading: boolean;
}

/** One thing for dock.ts to do to one row. `index` addresses the row by
 * POSITION in the list it passed in, never by threadId: the caller holds real
 * DOM nodes, and two rows for one thread (a search result beside the list, a
 * mid-scroll duplicate) must each be handled rather than fought over. */
export type RowDecorationStep =
  | {
      readonly action: "add";
      readonly index: number;
      readonly threadId: string;
      readonly presence: RowPresence;
    }
  | {
      readonly action: "update";
      readonly index: number;
      readonly threadId: string;
      readonly presence: RowPresence;
    }
  | { readonly action: "remove"; readonly index: number; readonly threadId: string }
  /** The right faces, in the wrong place: put the node back in front of the
   * title. No repaint — a `move` of a node already in the document relocates
   * it, so no number of these can ever produce a second decoration. */
  | { readonly action: "move"; readonly index: number; readonly threadId: string };

/**
 * The pass: given the rows on screen and who is viewing what, what to change.
 *
 * AN UNCHANGED ROW EMITS NOTHING. That is this function's whole reason to
 * exist. It runs on every coalesced DOM mutation bb makes anywhere plus a 2s
 * poll, for the length of a session, over every row in the sidebar — so
 * "rebuild the decoration and let the DOM sort it out" would be a subtree
 * replacement per row per frame, in the very subtree the observer that drives
 * this is watching.
 *
 * NO ROWS IS NOT AN ERROR, it is an empty plan. Another plugin registering its
 * own thread list (`PluginThreadListRegistration` — the `yaks` plugin on this
 * machine does exactly that) replaces bb's rows with its own, which carry no
 * `data-sidebar-thread-id`. There is then nothing to decorate and nothing to
 * throw about; `rowDecorationState` is how that stays distinguishable from a
 * fault.
 */
export function planRowDecorations(
  rows: readonly RowSlot[],
  presence: ReadonlyMap<string, RowPresence>,
): RowDecorationStep[] {
  const plan: RowDecorationStep[] = [];
  rows.forEach((row, index) => {
    const wanted = presence.get(row.threadId);
    if (wanted === undefined) {
      if (row.signature !== null) {
        plan.push({ action: "remove", index, threadId: row.threadId });
      }
      return;
    }
    if (row.signature === null) {
      plan.push({ action: "add", index, threadId: row.threadId, presence: wanted });
      return;
    }
    if (row.signature !== wanted.signature) {
      // An update re-inserts as well as repaints, so a decoration that is both
      // stale AND drifted is ONE step, never an update plus a move.
      plan.push({ action: "update", index, threadId: row.threadId, presence: wanted });
      return;
    }
    if (!row.leading) {
      plan.push({ action: "move", index, threadId: row.threadId });
    }
  });
  return plan;
}

/**
 * One MutationObserver record, reduced to the only two things the loop guard
 * cares about.
 *
 * `targetIsOurs` — the mutated node is inside DOM this plugin owns (the strip,
 * or a decoration). `nodes` — for a childList record, one flag per added and
 * removed node saying whether it is ours; empty for every other record type.
 */
export interface MutationShape {
  readonly targetIsOurs: boolean;
  readonly nodes: readonly boolean[];
}

/**
 * Did WE cause this mutation?
 *
 * THE FEEDBACK LOOP THIS PREVENTS IS THE REAL RISK OF THIS FEATURE. The
 * decoration pass writes into the sidebar — the very subtree the observer that
 * schedules the pass is watching — so every write raises the latch again. The
 * idempotence of `planRowDecorations` already means the second pass writes
 * nothing and the cascade dies after one extra pass, but "it converges" is a
 * property that survives exactly until somebody adds a field that is not in the
 * signature. This makes it not a loop at all.
 *
 * Two shapes count as ours, and they are not the same shape:
 *   * the mutated node is ours (an attribute rewritten on a decoration);
 *   * the mutated node is the HOST's — a row's title span — and every node
 *     added or removed is ours. That is literally "we inserted a decoration
 *     into a host row", and it is the case that would otherwise loop.
 *
 * A batch that also moved a host node is NOT ours, deliberately: the host
 * re-rendering the row it happens to be sharing with us is exactly the event
 * this whole mechanism has to react to.
 */
export function isOwnMutation(shape: MutationShape): boolean {
  if (shape.targetIsOurs) return true;
  return shape.nodes.length > 0 && shape.nodes.every((own) => own);
}

/** Should this batch of records wake the sync pass at all? Only if at least one
 * record was somebody else's. An empty batch never does. */
export function shouldScheduleSync(records: readonly MutationShape[]): boolean {
  return records.some((record) => !isOwnMutation(record));
}

/**
 * What the strip should report about the row decorations, for the smoke
 * checklist to read off `#canvas-av-dock[data-dock-row-decor]`.
 *
 * The job `data-dock-row-status` used to do for the feature-detected host API:
 * "there is nothing to decorate" and "this is broken" produce the same empty
 * sidebar from outside the app, and they need different fixes. `no-rows` means
 * `a[data-sidebar-thread-id]` was not found — a plugin has replaced the thread
 * list, or no sidebar is open. `failed` means the pass threw.
 */
export function rowDecorationState(
  rowCount: number,
  failed: boolean,
): "failed" | "no-rows" | "ok" {
  if (failed) return "failed";
  return rowCount === 0 ? "no-rows" : "ok";
}
