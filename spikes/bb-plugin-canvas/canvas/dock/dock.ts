// The presence strip — the room, in bb's own title bar, on every page.
//
// WHY A CONTENT SCRIPT AND NOT A SLOT. Every React surface bb offers a plugin
// is scoped to a route: `navPanel` and its `headerContent` exist only while the
// canvas page is open, `threadPanelAction` only inside a thread's side panel,
// `experimental_sidebarAccessory` is one short line of text. A call you are IN
// cannot be a thing that disappears when you click a thread — so this is
// `app.contentScripts.register`, which the SDK describes as "mounted once per
// active frontend generation in each bb app window", survives every route
// change, and is disposed exactly once when the plugin reloads or the window
// closes.
//
// WHY IT IS NO LONGER A FLOATING PILL. It used to be a draggable bottom-centre
// slab with a drop shadow, and it was in the way of everything — over the
// composer, over dialogs' backdrops, a thing you had to move rather than a
// thing you read. The good version of this already existed: the avatar stack
// the canvas page's `headerContent` drew in bb's page-header row. So the strip
// IS that stack, and it is now bar furniture on every route — inside
// `[data-testid="app-page-header-content-row"]`, leftmost in that row's
// right-hand actions cluster where the page has one (see anchor.ts's
// three-level chain) — no shadow, no slab, no blur, no grip. It is cut to the
// same 28px/6px/hover/pressed/focus contract as bb's own header buttons (see
// canvas/dock/styles.ts, where those numbers were measured off the running app),
// because it is a button and had stopped looking like one.
//
// EVERY DECISION LIVES IN A PURE SIBLING MODULE, because there is no jsdom in
// this project
// and never will be: anything decided inline in this file is decided where no
// test can reach it, which is how the last placement bug got in — and how the
// anchor latch below went a whole generation without a backstop.
//   * canvas/dock/anchor.ts — where the strip belongs and when it has to move
//     (tests/dock-anchor.test.ts)
//   * canvas/dock/expand.ts — folded or open (tests/dock-expand.test.ts)
//   * canvas/dock/model.ts  — who gets a bubble, in what order, whose face is a
//     place the camera can fly to, and where each person is (tests/dock.test.ts)
//   * canvas/dock/where.ts  — a bb path's meaning, its label, and whether it is
//     safe to put in an href (tests/dock-where.test.ts)
//   * canvas/dock/thread-status.ts — which sidebar thread rows should carry
//     whose faces, what to add/update/move/remove given what is on them
//     already, and which mutations are our own
//     (tests/dock-thread-status.test.ts)
//   * canvas/dock/navigate.ts — whose click a jump link is, and whether the
//     client-side attempt took (tests/dock-navigate.test.ts)
//   * canvas/dock/sync-latch.ts — which of the two drivers (the observer's
//     frame, the 2s tick) re-places the strip, and how a frame that never
//     arrives is stopped from wedging re-placement forever
//     (tests/dock-sync-latch.test.ts)
//   * canvas/dock/transcript-door.ts — whether the transcript button has
//     anywhere to go, what the host's refusal means, and what a click on it
//     therefore does to the status line and the fold
//     (tests/dock-transcript-door.test.ts)
// This file is the renderer, and it makes no decisions of its own.
//
// WHAT IT DELIBERATELY IS NOT:
//   * Not a second LiveKit connection. Join here and the same session is the
//     one the canvas page's controls drive, and vice versa (canvas/av-room.ts,
//     canvas/av-session.ts).
//   * Not bubbles that follow cursors. That was tried on the canvas and read as
//     confusing; video lives in this popover and only here.
//   * Not the transcript panel's owner. The "Transcript" button — one of the
//     popover's controls, beside Join audio / Mute / Camera on — only relays a
//     hook a thread header published (canvas/dock/transcript-door.ts); the
//     panel itself is the same `threadPanelAction` the launcher row and the
//     quick palette open. See the note at the bottom of this file.
import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import {
  attachVideo,
  detachVideo,
  joinAudio,
  leaveAudio,
  setCameraEnabled,
  setMuted,
} from "../av-room.js";
import { canvasBus } from "../panel-bus.js";
import type { AvTokenResult } from "../av.js";
import { fetchIdentity } from "../identity.js";
import { tabClientId } from "../tab-id.js";
import { createContentScriptRpc } from "./rpc.js";
import { createDockAnchor } from "./anchor.js";
import { EXPANDED_AT_LOAD, nextExpanded, type ExpandEvent } from "./expand.js";
import {
  buildDockModel,
  describeRoom,
  overflowLabel,
  mergeRoster,
  locateEveryone,
  locatedTabs,
  parseRoster,
  resolveSelfName,
  whereChoiceOf,
  type DockBubble,
  type DockModel,
  type DockRosterEntry,
  type WhereChoice,
} from "./model.js";
import { clientSideTook, shouldTryClientSide } from "./navigate.js";
import { placePopoverBox } from "./popover-place.js";
import { createDockRepaint } from "./repaint.js";
import {
  chooseSqueeze,
  containerWidth,
  maxBubblesFor,
  nextSqueeze,
  type SqueezeTier,
} from "./squeeze.js";
import { createSyncScheduler } from "./sync-latch.js";
import { DOCK_POPOVER_ID, DOCK_ROOT_ID, DOCK_STYLES } from "./styles.js";
import {
  decideDoorVisible,
  decideTranscriptClick,
  transcriptDoor,
} from "./transcript-door.js";
import {
  isOwnMutation,
  planRowDecorations,
  rowDecorationState,
  shouldScheduleSync,
  threadRowPresence,
  type MutationShape,
  type RowPresence,
  type RowSlot,
} from "./thread-status.js";
import {
  MAX_PATH_LENGTH,
  jumpHref,
  locationLabel,
  parseLocation,
  type BbLocation,
} from "./where.js";

/**
 * How often the strip re-reads room membership — and, since this feature,
 * republishes where THIS tab is and learns where everyone else is.
 *
 * TIGHTENED FROM 5s TO 2s, and the reason is the second half of that sentence.
 * Membership genuinely does change on the scale of people arriving at a
 * meeting, but WHEREABOUTS changes on the scale of clicking a thread — at five
 * seconds a "jump to them" link is routinely pointing at the page somebody has
 * already left, and a link that lands in the wrong place is worse than no link.
 * Two seconds is roughly a click: fast enough that a jump is almost always
 * current, slow enough that a bb window costs 30 requests a minute rather than
 * 300, and comfortably inside the 15s staleness horizon (LOCATION_STALE_MS)
 * so seven consecutive polls have to fail before a location is disowned.
 *
 * A route change does not wait for the next tick — see `checkRoute` below.
 */
const ROSTER_POLL_MS = 2_000;

/** How often expired speaking holds are swept. Only ticks while connected. */
const SPEAKING_TICK_MS = 250;

/** The last of the three checks a jump link makes before giving up on
 * client-side routing (two animation frames, then this). Long enough for a
 * route that has to fetch before it paints anything, short enough that the
 * fallback reload does not feel like a hang. */
const JUMP_VERIFY_MS = 150;

/**
 * bb's page-header row: the 48px flex line that holds the page title on the
 * left and the page's action buttons on the right. A `data-testid` rather than
 * a class chain on purpose — the classes are Tailwind and change with any
 * restyle, while a testid is the closest thing to a name the host has given
 * this element.
 */
const HEADER_ROW_SELECTOR = '[data-testid="app-page-header-content-row"]';

// The strip's preferred slot inside that row — the FIRST CHILD of the row's
// right-hand actions cluster, so presence reads to the LEFT of whatever
// controls the page puts there (a thread's workflow and pane buttons, the
// canvas page's open-sidebar toggle) rather than at the far edge of the bar.
// The cluster has no name of its own, so it is located by climbing from one of
// the marker attributes in `ACTIONS_CLUSTER_MARKERS` — anchor.ts's decision,
// driven by the two hands (`findMarker`, `parentOf`) below.

/**
 * A sidebar thread row's overlay click target — and the join key.
 *
 * `data-sidebar-thread-id` IS the thread id (`thr_axc38p737w`), which is what
 * the location data is keyed by, so no lookup is needed to decide whose faces
 * a row gets. Absent means somebody else is rendering the thread list (a
 * `PluginThreadListRegistration`; the `yaks` plugin on this machine does
 * exactly that) — nothing to decorate, which is not an error.
 */
const THREAD_ROW_LINK = "a[data-sidebar-thread-id]";

/**
 * The row's TITLE span — where the faces go.
 *
 * NOT the row's right-hand 28px slot, which is the one the host's own status
 * API paints into and the one bb reclaims for the row's hover actions. Measured
 * on the running app (bb 0.40.0) on 2026-09-01, hovering a row:
 *
 *   * the contested slot holds `span.bb-sidebar-hover-actions-fade` (the draft
 *     glyph / plugin status) AND `div.bb-sidebar-hover-actions` (Archive,
 *     Thread actions) — the hover swap between them is the reported defect;
 *   * this span's `padding-right` goes 0px → 24px on hover. A LEADING child is
 *     unmoved by that (measured at x=40 both at rest and hovered); a TRAILING
 *     one is pushed 24px left (x=247 → 223) and eats the title's width
 *     (177px → 153px).
 *
 * So: leading child of this span. It is the only position in the row that the
 * hover state does not touch.
 */
const ROW_TITLE_INSET = "span.bb-sidebar-hover-actions-inset";

/** Our decoration, and its own read-back: the attribute's VALUE is the
 * signature of what is painted (canvas/dock/thread-status.ts). */
const ROW_DECORATION = "[data-canvas-row-presence]";

/**
 * The popover, by its own attribute, for the disposer's document-wide sweep.
 *
 * The same discipline `ROW_DECORATION` above is swept with, and for the same
 * reason: this node lives OUTSIDE the tree `root.remove()` takes with it (it is
 * a child of <body> now), so "remove the thing we are holding a reference to"
 * stops being the whole of the cleanup. A generation whose disposer ran but
 * whose reference was somehow stale, or an earlier generation that left one
 * behind, would otherwise strand a dialog in the page for the life of the
 * window — with LiveKit video tiles attached to it.
 */
const POPOVER_NODE = "[data-canvas-dock-popover]";

const ROOT_ID = DOCK_ROOT_ID;
const STYLE_ID = "canvas-av-dock-styles";

/** Preferences the floating pill persisted and the strip does not have. Cleared
 * once on mount so a window that used the old dock does not carry a dead
 * position (or a "collapsed" that now means the opposite) around forever. */
const RETIRED_KEYS = ["canvas-av-dock:position", "canvas-av-dock:collapsed"];

export function mountAvDock(
  context: PluginContentScriptContext,
): PluginContentScriptDisposer {
  // Every fetch this strip makes carries the host's abort signal, so a poll in
  // flight when the generation is replaced cannot write into DOM the disposer
  // has already removed.
  const rpc = createContentScriptRpc(context.pluginId, (input, init) =>
    fetch(input, { ...init, signal: context.signal }),
  );

  forgetRetiredPreferences();

  // ---- state ----------------------------------------------------------
  let polledRoster: readonly DockRosterEntry[] = [];
  let expanded = EXPANDED_AT_LOAD;
  /** Bubble nodes by model key, kept across renders so a live <video> is never
   * torn down and re-created just because someone else started talking. Two
   * maps because there are two rows: the strip's small initials-only faces, and
   * the popover's big ones, which are the only bubbles that carry video. */
  const stripNodes = new Map<string, BubbleNode>();
  const popoverNodes = new Map<string, BubbleNode>();
  let disposed = false;
  /** This browser's own display name, from the same `/http/identity` door the
   * canvas panel uses. On a thread route there is no panel and no LiveKit
   * session, so without this the strip could not tell which bubble was you. */
  let selfIdentity: string | null = null;
  /** Where THIS tab is. Drives "in this thread" and stops the strip offering to
   * send you where you already are. */
  let here: BbLocation | null = null;
  /** The pathname `here` was parsed from, so a route change is a string
   * compare rather than a re-parse. */
  let herePath: string | null = null;
  /**
   * How many DOM writes the row decorations have made this generation.
   *
   * Introspection only, and it earns its place: the pass writes into the very
   * subtree the MutationObserver that drives it is watching, so "did that
   * become a feedback loop" is a question somebody has to be able to answer
   * from outside the app. A count that stops climbing while nothing is
   * happening is the answer. Read off
   * `#canvas-av-dock[data-dock-row-writes]`.
   */
  let rowWrites = 0;
  /**
   * Which tab of each person the strip last decided to point at.
   *
   * The strip holds this memory because `locateEveryone` must not answer a
   * question about a person by holding a race between their tabs' polling
   * timers — see WHERE_STICKY_LEAD_MS. It is a cache of a DECISION, not of
   * state: throw it away and the next answer is merely un-defended, never
   * wrong.
   */
  let whereChoice: WhereChoice = new Map();
  /**
   * How hard the strip is currently squeezing itself — how many faces it draws
   * and, through `data-dock-squeeze`, how big they are. canvas/dock/squeeze.ts
   * owns every judgement behind this value; this file only measures, holds the
   * answer, and paints it.
   *
   * SEEDED FROM A REAL MEASUREMENT, not from a hopeful "roomy". The first paint
   * is the one nobody gets to correct: a strip that mounts six faces wide into
   * a phone-width row has already pushed bb's own page title into an ellipsis
   * by the time the first sync pass arrives, and that shove is the bug the
   * whole feature exists to prevent. `chooseSqueeze` is the no-history answer
   * for exactly this moment — including for a row that cannot be measured yet,
   * where it takes the small end and the first pass widens it.
   */
  let squeeze: SqueezeTier = chooseSqueeze(measureContainer(headerRow()));

  // ---- DOM ------------------------------------------------------------
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DOCK_STYLES;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.dataset.canvasDock = "";
  // Set here and not only in setStatus(): the status line is empty until
  // something goes wrong, and `[data-dock-status=""]` — the rule that hides it
  // — cannot match an attribute that is absent.
  root.dataset.dockStatus = "";
  root.dataset.dockExpanded = "false";
  root.dataset.dockAnchor = "fixed";
  // The tier the faces are drawn at, mirrored out for the same reason as its
  // neighbours: it is what makes "why is this strip only showing three faces"
  // answerable by looking, rather than by instrumenting a measurement nobody
  // can see. The stylesheet switches the face geometry on it too, so it has to
  // exist before the first paint and not only after the first change.
  root.dataset.dockSqueeze = squeeze;
  // Where the row decorations stand, made visible. "There are no thread rows
  // to decorate" (another plugin owns the list) and "this is broken" produce
  // the same empty sidebar from outside the app and need different fixes — the
  // job `data-dock-row-status` used to do for the feature-detected host API
  // this replaced. See `rowDecorationState`.
  root.dataset.dockRowDecor = "idle";
  root.dataset.dockRows = "0";
  root.dataset.dockRowWrites = "0";

  // The strip. A <button>, so it is one keyboard-reachable control with one
  // job: open the popover. That is also why the faces inside it are <span>s —
  // a button inside a button is not valid HTML, and the fly-to-cursor
  // affordance belongs on the big faces in the popover where you can see them.
  const strip = document.createElement("button");
  strip.type = "button";
  strip.className = "dock-strip";
  strip.dataset.canvasDockStrip = "";
  strip.setAttribute("aria-haspopup", "dialog");
  strip.setAttribute("aria-expanded", "false");
  // THE DIALOG IS NO LONGER A DESCENDANT OF ITS TRIGGER, so the relationship
  // has to be stated instead of being read off the tree. `aria-haspopup` says
  // "this opens a dialog" and `aria-expanded` says "it is open"; neither says
  // WHICH dialog, and until this change containment answered that. It no longer
  // can — the popover is a child of <body>, arbitrarily far from the strip in
  // reading order.
  //
  // `aria-controls` is the honest amount to claim. Its support in screen
  // readers is uneven (it is a hint, not a guaranteed jump), but it is the
  // attribute that MEANS this, and stating a true relationship weakly is better
  // than not stating it. `aria-owns` was considered and rejected: it would
  // reparent the popover into the strip in the accessibility tree, which is a
  // stronger claim than "these are related" and a known source of confusing
  // traversal when the visual and a11y orders disagree — which, with a
  // body-parented fixed box, they now do.
  //
  // NOT VERIFIED WITH A SCREEN READER. There is no browser here.
  strip.setAttribute("aria-controls", DOCK_POPOVER_ID);

  const bubbles = document.createElement("span");
  bubbles.className = "dock-bubbles";
  const overflow = document.createElement("span");
  overflow.className = "dock-overflow";
  // The quiet "you are in a call" indication, and the affordance that keeps the
  // popover reachable on a page where the room happens to be empty.
  const callDot = micGlyph();
  callDot.classList.add("dock-call");
  strip.append(bubbles, overflow, callDot);

  // THE POPOVER IS NOT INSIDE THE STRIP. It is a child of <body> with a root id
  // of its own (canvas/dock/styles.ts holds both ids, so the sheet and these
  // elements cannot drift), because the user reported it "showing behind the
  // left side menu" and the screenshot cuts it off dead on the line where bb's
  // left pane ends — pixels deleted, not dimmed, which is an ancestor's
  // `overflow: hidden` rather than a lost z-index. Making it `position: fixed`
  // in place would NOT have been enough: a fixed box is re-based and re-clipped
  // by any ancestor carrying `transform`, `filter`, `backdrop-filter`,
  // `will-change` or `contain`. Leaving the chain is what makes the escape
  // unconditional. See canvas/dock/styles.ts's popover block, and
  // popover-place.ts's header for how much of that was observed (none of it —
  // there is no browser in this spike).
  const popover = document.createElement("div");
  popover.id = DOCK_POPOVER_ID;
  popover.className = "dock-popover";
  popover.dataset.canvasDockPopover = "";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Canvas room audio");
  // Mirrored from the root, where it is also written and where external
  // read-backs grep for it. The stylesheet's "hide the status line while it is
  // empty" rule used to key on the root's copy and match a descendant; the
  // status line is no longer a descendant of the root, so the rule reads this
  // one instead. Set here as well as in `setStatus` for the same reason the
  // root's is: `[data-dock-status=""]` cannot match an attribute that is
  // absent, and the line is empty until something goes wrong.
  popover.dataset.dockStatus = "";
  popover.hidden = true;

  const faces = document.createElement("div");
  faces.className = "dock-faces";

  const controls = document.createElement("div");
  controls.className = "dock-controls";
  const audioButton = button("dock-btn dock-audio", "", "");
  const micButton = button("dock-btn dock-mic", "", "");
  const cameraButton = button("dock-btn dock-camera", "", "");

  // The door to the room transcript, and it lives HERE rather than beside the
  // strip in bb's header row. The header is the scarce resource — on a phone
  // that row holds the page title and every action bb itself wants, and a
  // second glyph of ours is one the user pays for on every route. The popover
  // is not scarce: it is a surface we open on demand and it already has a row
  // of controls this is one of.
  //
  // No 📜 in the label. Its three neighbours are plain words, so a lone emoji
  // here would read as the odd one out — and it is the same objection
  // `micGlyph` below records for the strip: an emoji is a different font at a
  // different baseline on every platform, which is not something to put in a
  // row that has to line up.
  //
  // Hidden on every route where there is no door to walk through, which is
  // every non-thread route: the transcript panel is a thread-surface object,
  // the slot that relays the opener is not rendered anywhere else, and bb's own
  // palette row hides itself on those routes for the same reason. See
  // canvas/dock/transcript-door.ts.
  const scribe = button("dock-btn dock-transcript", "Transcript", "Open the room transcript");
  // `data-canvas-dock-scribe` SURVIVES THE MOVE. Deploy verification and
  // external selectors grep for this attribute and for the `scribe` name; this
  // is the same button with a new home, and renaming its handle to match a
  // cosmetic change would break every one of them for nothing.
  scribe.dataset.canvasDockScribe = "";
  scribe.setAttribute("aria-label", "Open the room transcript");
  scribe.hidden = true;

  controls.append(audioButton, micButton, cameraButton, scribe);

  const status = document.createElement("p");
  status.className = "dock-status";
  // A polite live region: the one thing here a screen reader must not miss is
  // "LiveKit is not configured", which is the answer on every fresh install.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  popover.append(faces, controls, status);
  root.append(strip);
  // Straight onto <body>, once, at mount. It does NOT travel with the strip:
  // anchor.ts relocates `root` between three placements and one of them
  // (`fixed`) also appends to <body>, but it only ever moves the one node it
  // was given, so the popover is neither carried along nor duplicated. What
  // makes that safe rather than merely true is that a relocation folds the
  // popover — `syncAnchor` applies `reanchored`, which expand.ts turns into
  // "closed" — so it is never left hanging where the strip used to be.
  document.body.appendChild(popover);

  // ---- placement ------------------------------------------------------
  //
  // WRITING INTO A REACT-RENDERED CONTAINER IS TOLERATED, and this is why:
  // React reconciles only the children it created itself, matched positionally
  // against its own previous render, and never walks a container looking for
  // strangers. Its `insertBefore`/`removeChild` calls name its own nodes, so a
  // re-render can shuffle a foreign node's POSITION but never remove it. That
  // is why anchor.ts treats "no longer where this level says I should be" —
  // not the trailing child at level 2, not the cluster's first child at
  // level 1 — as a reason to move, and why every move is an insert of the one
  // node we own (a relocation, never a copy), so a header re-render can never
  // leave a duplicate strip behind.
  //
  // The three levels themselves, and when to walk up or down them, are
  // anchor.ts's decision, not this file's. These are only the hands.
  const anchor = createDockAnchor<Element>({
    findMarker: (selector) => document.querySelector(selector),
    parentOf: (node) => node.parentElement,
    findRow: () => headerRow(),
    isConnected: () => root.isConnected,
    isTrailingChildOf: (host) => host.lastElementChild === root,
    isFirstChildOf: (host) => host.firstElementChild === root,
    // To the FRONT of the cluster's children. `prepend` moves the one node we
    // own (a node already in the document is relocated, never copied), so a
    // header that re-renders under us can never leave a second strip behind.
    attachAsFirstChild: (host) => {
      root.dataset.dockAnchor = "before";
      host.prepend(root);
    },
    attachToRow: (host) => {
      root.dataset.dockAnchor = "row";
      host.appendChild(root);
    },
    // The home route renders no <header> at all. Rather than vanish, the strip
    // drops into the same 48px band at the top right — still flat, still not a
    // pill — and moves back into the row the instant one appears.
    attachFixed: () => {
      root.dataset.dockAnchor = "fixed";
      document.body.appendChild(root);
    },
  });

  /** Re-place the strip, and fold a popover that is now pointing at where the
   * strip used to be. */
  function syncAnchor(): void {
    if (disposed) return;
    if (!anchor.sync()) return;
    apply({ type: "reanchored" });
    render();
  }

  // ---- squeeze --------------------------------------------------------
  //
  // How many faces the strip draws, and how tightly, given how much room its
  // container has. Every judgement is squeeze.ts's — the tiers, the thresholds,
  // the dead band that keeps a divider parked on a boundary from strobing the
  // layout, and what an unmeasurable container means. These are the hands: a
  // measurement in, a `data-*` attribute and a repaint out.

  /**
   * The element `sizeObserver` is watching, so re-targeting is a node compare.
   *
   * It has to be re-targeted at all because bb's router REPLACES the header row
   * element on a route change: an observer left pointing at the old one is
   * watching a detached node — still alive, never firing again — and the strip
   * would then only re-measure on the 2s backstop for the rest of the
   * generation.
   */
  let observedRow: Element | null = null;

  /**
   * A ResizeObserver, and it is not redundant with the two drivers this file
   * already has. Dragging bb's pane divider changes the header row's width with
   * no window `resize` event, and it need not mutate the DOM either — so a
   * strip riding only the mutation pass and the 2s poll would sit at the wrong
   * tier for up to two seconds of a drag it is being watched through.
   *
   * The callback does no work. It goes through the SAME coalescing everything
   * else here goes through, because a drag delivers a width every frame for as
   * long as the pointer is down, and the pass it schedules is idempotent.
   *
   * On the fixed placement there is no row and nothing is observed, so a window
   * resize reaches the strip through the drivers this file already has — any
   * DOM mutation, and the 2s tick — i.e. within a poll interval rather than
   * within a frame. That is the same backstop the anchor itself rides, and a
   * second instrument for the one route where the strip is a corner overlay is
   * more machinery than that route is worth.
   */
  const sizeObserver = new ResizeObserver(() => {
    scheduleAnchorSync();
  });

  /** Re-point the observer at the row that exists now, re-measure, and repaint
   * only if the answer moved. */
  function syncSqueeze(): void {
    if (disposed) return;
    const row = headerRow();
    if (row !== observedRow) {
      if (observedRow !== null) sizeObserver.unobserve(observedRow);
      if (row !== null) sizeObserver.observe(row);
      observedRow = row;
    }
    const next = nextSqueeze(squeeze, measureContainer(row));
    // A measurement that agrees with what is already drawn must NOT repaint.
    // This runs on every DOM mutation bb makes anywhere and on every frame of a
    // resize, and `render` reconciles live <video> elements (see
    // `renderBubbles`) — repainting per observation would put that reconcile on
    // the drag path for nothing.
    //
    // It is also what stops the observer feeding itself: the pass writes into
    // the strip, which is inside the row the observer is watching. The row's
    // width is not a consequence of the strip's (it is a flex line that fills
    // its container and shrinks its title — the reasoning squeeze.ts's header
    // records), so a repaint should not resize the row at all; and if it ever
    // did, the second observation would land here with an unchanged tier and
    // stop.
    if (next === squeeze) return;
    squeeze = next;
    root.dataset.dockSqueeze = next;
    render();
  }

  // ---- putting the popover somewhere ----------------------------------
  //
  // The popover is `position: fixed` on <body> (canvas/dock/styles.ts), so it
  // has no resting position at all: the two custom properties written below ARE
  // where it is. Both come out of `placePopoverBox` — right-aligned to the
  // strip and hung below it, flipped above when below will not fit, clamped
  // inside the viewport's margins, with a stated rule for which edge loses when
  // both cannot be honoured and a safe on-screen corner for a read that failed.
  // Every one of those judgements is popover-place.ts's, with
  // tests/dock-popover-place.test.ts on all of them. This is the measuring and
  // the writing.

  /**
   * Measure the anchor and the box, and write where the box goes.
   *
   * THERE IS DELIBERATELY NO `if (expanded)` HERE, and the reason survived the
   * move intact: a folded popover is `hidden`, which the stylesheet turns into
   * `display: none`, so it measures 0 by 0 — and `placePopoverBox` answers a
   * 0 width by keeping the right-aligned resting position and a 0 height by
   * hanging below unclamped, both of which are cases its tests state outright.
   * Guarding the fold here would move a judgement into the one file no test in
   * this project can reach, to reproduce an answer the tested module gives.
   *
   * WHAT THE READS COST. Three layout reads (the rect, and the two offset
   * dimensions — `offsetWidth` and `offsetHeight` are one layout each in the
   * sense that matters: the first flushes, the rest are free until something
   * dirties layout again, and nothing between them writes). On the coalesced
   * pass that flush is usually already paid: `syncSqueeze` measured the header
   * row a moment earlier, and the two steps between them only write when
   * something actually moved. The flush this does reliably force is the one at
   * the end of `render`, and a render is a click or a state change rather than
   * a frame of a drag.
   */
  function syncPopoverPlacement(): void {
    if (disposed) return;
    // THE ROOT'S rect, not the strip button's — one read, all four edges. The
    // two boxes coincide today (the root has no padding and no border, and the
    // strip is its only child), but the root's `gap: 4px` is kept precisely so
    // something can one day sit beside the strip, and on that day the strip's
    // edges would be the wrong numbers while the root's would still be right.
    const anchor = root.getBoundingClientRect();
    const box = placePopoverBox({
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      // `offsetWidth`/`offsetHeight` rather than the popover's own rect, and it
      // is the same choice as the transform in the stylesheet: these are LAYOUT
      // dimensions, which a transform cannot affect by definition. So the
      // numbers read here can never be a consequence of the offsets the
      // previous pass wrote — a rect WOULD include the translation and close
      // that loop. `popover` is a div we created, so the offset properties are
      // available on it, unlike the header row which arrives as a bare
      // `Element`.
      popoverWidth: popover.offsetWidth,
      popoverHeight: popover.offsetHeight,
      // `documentElement.clientWidth`/`clientHeight` and NOT `window.innerWidth`
      // /`innerHeight`, which is the one place in this file the two differ
      // enough to matter: the inner* pair include the classic scrollbar gutter,
      // so on a document that scrolls they would let the clamp park an edge of
      // the popover UNDER the scrollbar. The margin popover-place.ts keeps is
      // 8px and a classic gutter is ~15px, so the margin cannot absorb the
      // difference — the edges the popover must stay inside are the viewport's
      // CONTENT edges. A read that fails answers 0, which the module treats as
      // not-a-measurement.
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    });
    // Written every pass rather than only when they change, and onto the
    // POPOVER rather than the root — the two are no longer in the same tree, so
    // a property set on the root would never reach the rule that consumes it.
    // Nothing lays out from these — the transform that reads them is outside
    // layout — so there is no repaint to spare, and a change guard would be a
    // branch about behaviour in the file that is not allowed to hold one.
    popover.style.setProperty("--dock-popover-x", `${box.left}px`);
    popover.style.setProperty("--dock-popover-y", `${box.top}px`);
  }

  // Coalesced to one answer per frame, with the 2s roster tick as a backstop
  // for the frame that never comes. WHICH of those runs a pass, and how a late
  // frame is stopped from running a second one, is sync-latch.ts's decision —
  // the flag used to live here, raised outside the frame and lowered only
  // inside it, and one dropped rAF wedged anchor re-sync for the life of the
  // generation. These are only the hands.
  const scheduler = createSyncScheduler({
    requestFrame: (callback) => requestAnimationFrame(callback),
    run: () => {
      if (disposed) return;
      // Free-riding on the coalesced pass the observer already drives: a bb
      // route change is a client-side DOM swap, so it always lands here, and
      // the check itself is a string compare.
      checkRoute();
      syncAnchor();
      // AFTER the anchor, deliberately: a strip that just moved between the
      // header row and the fixed corner has to be measured against the
      // container it is in now, not the one it was in when the pass started.
      syncSqueeze();
      // The sidebar re-renders, scrolls and re-orders under exactly the same
      // mutations that move the strip, so the rows ride the same coalesced
      // pass rather than growing a second scheduler. rAF cannot be trusted
      // (see sync-latch.ts), and the 2s poll drives this too.
      syncRowDecorations();
      // LAST, and it has to be here rather than only in `render`. A window
      // resize or a pane drag that does not cross a squeeze boundary changes
      // neither the tier nor the anchor, so neither `syncSqueeze` nor
      // `syncAnchor` repaints — an open popover would then hold a position
      // computed for a viewport that no longer exists. Riding this pass gets it
      // the ResizeObserver for free (that is what re-measures the row during a
      // drag), and the 2s tick as the backstop on the fixed placement, where
      // there is no row to observe.
      //
      // THE SAME PASS AND THE SAME OBSERVER AS BEFORE THE POPOVER MOVED. The
      // move changed WHERE the answer is written, not what makes the answer go
      // stale: the anchor is still the strip, and the strip still moves only
      // when the header row it sits in relays out, which is what the observer
      // watches.
      //
      // NO SCROLL LISTENER, AND THIS IS THE ONE THING THE MOVE GENUINELY
      // CHANGED. An absolutely-positioned popover travelled with its anchor for
      // free; a fixed one does not, so if the strip could be scrolled the
      // popover would stay behind. It is not added because there is nothing
      // established for it to listen to: all three of anchor.ts's placements
      // put the strip in a HEADER — a thread header's action cluster, the
      // header row itself, or a fixed corner overlay — and a header is the part
      // of an app shell that does not scroll with its content. The backstops
      // that do exist are cheap and general: any DOM mutation anywhere schedules
      // this pass, and the 2s roster tick runs it regardless.
      //
      // WHAT THAT ARGUMENT DOES NOT COVER, stated rather than glossed: it is
      // reasoned from anchor.ts and bb's layout as described, NOT observed —
      // there is no browser in this spike. If bb ever translates a header on
      // scroll, or the strip lands somewhere scrollable, the visible symptom is
      // a popover left behind for up to two seconds, and a `scroll` listener in
      // the capture phase on `document` is the fix. Adding one now would be a
      // listener on every scroll in the app, on every route, for a case nobody
      // has seen.
      //
      // Nothing above it in this pass is affected by what it writes: the two
      // properties feed a transform, and a transform is not layout. That is
      // also why they cannot feed the ResizeObserver this rides on.
      syncPopoverPlacement();
    },
  });
  function scheduleAnchorSync(): void {
    scheduler.mutation();
  }

  /**
   * Is this node inside the widget itself — the strip, or the popover?
   *
   * TWO ROOTS, NOT ONE, and asking about only the first is the mistake this
   * function exists to make impossible to repeat. The popover used to be a
   * child of `root`, so `root.contains` answered for both; it is a child of
   * <body> now, and every caller below was written when one check was enough.
   */
  function insideWidget(node: Node): boolean {
    return node === root || root.contains(node) || node === popover || popover.contains(node);
  }

  /**
   * Is this node ours — the widget, or one of our row decorations?
   *
   * Both halves matter. The widget is ours by containment; a decoration is ours
   * by its own attribute, including after it has been detached (a removed node
   * still matches itself), which is what makes "we took a decoration off a row"
   * recognisable.
   *
   * THE POPOVER HALF IS NOT COSMETIC HERE. This is the MutationObserver's loop
   * guard, and its contract is that a batch whose every record is ours
   * schedules nothing. The observer watches `document.body` with `subtree`, so
   * since the popover moved there every face `render` draws inside it is a
   * mutation the observer sees. Left unrecognised, each popover render would
   * schedule a coalesced pass. That pass would not loop — it only re-renders
   * when the tier or the anchor actually changed — but "does not hang" is a
   * weaker property than the guard is supposed to provide.
   */
  function isOurNode(node: Node): boolean {
    if (!(node instanceof Element)) return false;
    if (insideWidget(node)) return true;
    return node.closest(ROW_DECORATION) !== null;
  }

  /** One MutationRecord, reduced to what the loop guard reads. */
  function shapeOf(record: MutationRecord): MutationShape {
    const nodes: boolean[] = [];
    // Index loops: this project's `lib` is ES2022 + DOM without DOM.Iterable,
    // so a NodeList is an ArrayLike and not an iterable.
    for (let i = 0; i < record.addedNodes.length; i += 1) {
      nodes.push(isOurNode(record.addedNodes[i]!));
    }
    for (let i = 0; i < record.removedNodes.length; i += 1) {
      nodes.push(isOurNode(record.removedNodes[i]!));
    }
    return { targetIsOurs: isOurNode(record.target), nodes };
  }

  // document.body rather than [data-testid="app-layout-root"]: the layout root
  // is itself a React node and a remount of it would take the observer's target
  // with it, which is the failure this observer exists to survive.
  //
  // THE LOOP GUARD. Until the rows were decorated, this observer only ever
  // watched DOM somebody else owned. It now watches a subtree the pass it
  // schedules WRITES INTO, which is the single most likely way to hang the
  // app: every decoration written raises the latch, which runs the pass, which
  // writes. `shouldScheduleSync` breaks it at the source — a batch whose every
  // record is ours schedules nothing at all — so the cascade is not merely
  // convergent (the plan is idempotent, so the second pass would write
  // nothing), it never starts. `data-dock-row-writes` on the strip is how that
  // is checked from outside the app.
  const observer = new MutationObserver((records) => {
    if (!shouldScheduleSync(records.map(shapeOf))) return;
    scheduleAnchorSync();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ---- fold / unfold --------------------------------------------------

  function apply(event: ExpandEvent): void {
    const next = nextExpanded(expanded, event);
    if (next === expanded) return;
    expanded = next;
    render();
  }

  strip.addEventListener("click", () => apply({ type: "strip-click" }));
  popover.addEventListener("click", () => apply({ type: "popover-click" }));

  // The transcript button. Both halves are transcript-door.ts's decision — what
  // the host's boolean MEANS (`interpretOpen`, so the boolean is read and never
  // assumed) and what a click therefore does to the status line and the fold
  // (`decideTranscriptClick`). Neither is decided here, because "only the
  // accepted open folds" is the one thing about this control that must not be
  // got wrong — a refusal is a sentence on the status line, the status line is
  // inside the popover, and folding on a decline would hide the only
  // explanation the user gets. `nextExpanded`'s "status" case then forces the
  // popover back open to report it. Written as a branch in this file that rule
  // was untestable, and a fold wired onto every outcome left the whole suite
  // green; as a pure function it has a test that fails.
  scribe.addEventListener("click", (event) => {
    // It used to mean "not the strip's gesture, do not toggle the popover".
    // Inside the popover it means something narrower: the popover's own click
    // listener applies `popover-click` — a deliberate non-dismissal — and it
    // runs AFTER this one on the way up. As `popover-click` is written today
    // it reads `expanded` and would simply agree with the fold below, so this
    // is a guard rather than a live fix; but the fold is this gesture's own
    // decision, and letting a second handler re-decide it afterwards is how
    // the next edit to `popover-click` silently becomes a bug here — and on
    // the refusal path, where nothing folds, `popover-click` would be the
    // handler deciding the popover's fate instead of the status line.
    event.stopPropagation();
    const { status: text, fold } = decideTranscriptClick(transcriptDoor.open());
    setStatus(text);
    if (fold) apply({ type: "transcript" });
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") apply({ type: "escape" });
  };
  document.addEventListener("keydown", onKeyDown);

  /**
   * Dismiss on a press that landed outside the whole widget.
   *
   * `insideWidget` AND NOT `root.contains`, and this is the change that would
   * otherwise have made the popover unusable rather than merely misplaced. The
   * popover is no longer a descendant of `root`, so a press on Join audio, on
   * Mute, on a face, on the Transcript button — every control this popover
   * exists to offer — would have read as "outside" and folded it on the way
   * DOWN, before the click that operates the control ever arrived. `pointerdown`
   * precedes `click`; the popover's own click listener, which is what says "a
   * click in here is a control and not a dismissal", would have been listening
   * from inside a box that was already hidden.
   *
   * NOTHING TESTS THIS. There is no jsdom in this project and none can be
   * added, so the wiring in this file is verified by reading; the fold policy it
   * feeds (`outside-click` closes) is expand.ts's and is tested there. Said
   * plainly because the failure it prevents is total and silent in the suite.
   */
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && insideWidget(target)) return;
    apply({ type: "outside-click" });
  };
  document.addEventListener("pointerdown", onPointerDown);

  // ---- behaviour ------------------------------------------------------

  function setStatus(text: string): void {
    status.textContent = text;
    const shown = text === "" ? "" : "shown";
    root.dataset.dockStatus = shown;
    // The SAME value on the popover, because that is where the stylesheet reads
    // it from now: the rule that hides an empty status line used to key on the
    // root and match a descendant, and the status line is no longer a
    // descendant of the root. The root's copy stays because it is a read-back
    // other things grep for, not because any rule still uses it.
    popover.dataset.dockStatus = shown;
    // "LiveKit is not configured" is the answer on every fresh install, and it
    // is reported INSIDE the popover. Unfold rather than report into a fold
    // nobody can see — the same auto-unfold the old dock did, now expressed as
    // a transition in expand.ts.
    apply({ type: "status", text });
    // The failure path reaches here AFTER the bus has already told us the join
    // ended, so the render that transition triggered has been and gone.
    render();
  }

  /** The strip's model and the popover's, from ONE read of the roster. */
  interface DockModels {
    /** What goes in bb's header row: squeezed to the tier's face count. */
    readonly strip: DockModel;
    /** What goes in the popover: the same room, with the tier taken out of it. */
    readonly popover: DockModel;
  }

  /**
   * TWO MODELS, BECAUSE THE TIER IS ABOUT THE HEADER ROW AND NOTHING ELSE.
   *
   * There was one, and both trees drew it. That was survivable while every tier
   * still drew SOME faces — the popover quietly showed three of them at
   * `cramped`, which is wrong but not obviously so — and it stops being
   * survivable at `bare`, where the tier's face count is zero: the strip would
   * drop the faces to save the row, and the popover it points at, a box we open
   * on demand and size ourselves, would then have nothing in it either. The
   * whole bargain of that tier is "nothing is lost, it moves".
   *
   * The popover's model is built with NO `limit`, which canvas/dock/model.ts
   * documents as MAX_DOCK_BUBBLES — i.e. exactly the behaviour this surface had
   * before the tiers existed, not "unlimited". A room bigger than the cap still
   * folds its tail into an overflow the popover does not currently draw; that
   * is untouched here and is a separate question from the tier.
   *
   * Built from one roster read, one `locateEveryone` and one speaking snapshot,
   * so the two can never disagree about who is present or where they are.
   */
  function currentModels(): DockModels {
    const { roster, av } = canvasBus.snapshot();
    const merged = mergeRoster(roster, polledRoster);
    // Decided ONCE per render, with the last decision in hand, and handed to
    // the faces — `syncThreadRowStatuses` deliberately asks a different
    // question of the same roster (the union of tabs, not one tab per person).
    const where = locateEveryone(merged, whereChoice);
    whereChoice = whereChoiceOf(where);
    const room = {
      roster: merged,
      where,
      speaking: repaint.current(),
      video: av.video,
      selfName: resolveSelfName(roster, av.self, selfIdentity),
    };
    return {
      strip: buildDockModel({
        ...room,
        // How many faces there is room for, as opposed to how many there are
        // people for. Whoever this drops is not lost — the model folds them
        // into the count the strip draws, and the popover below still has them.
        limit: maxBubblesFor(squeeze),
      }),
      popover: buildDockModel(room),
    };
  }

  function render(): void {
    if (disposed) return;
    const { av } = canvasBus.snapshot();
    const models = currentModels();

    root.dataset.dockExpanded = expanded ? "true" : "false";
    root.dataset.dockPhase = av.status;
    root.dataset.dockMic = av.muted ? "muted" : "live";
    popover.hidden = !expanded;
    strip.setAttribute("aria-expanded", String(expanded));
    // WHAT THE STRIP SAYS IT IS SHOWING IS `describeRoom`'s CALL, not this
    // file's. It used to be a ternary here — no bubbles meant "nobody here yet"
    // — and that inference died with the `bare` tier, where a full room draws
    // no faces. The sentence is built from the model the STRIP drew, so it
    // describes what is on screen rather than what the popover would show.
    strip.title = expanded
      ? "Hide the room controls"
      : `Canvas room — ${describeRoom(models.strip)}`;
    strip.setAttribute("aria-label", strip.title);

    // The sidebar rows, driven from the same roster as the faces so the two
    // can never disagree about who is where — and, since this change, drawn
    // with the same circles.
    syncRowDecorations();

    renderBubbles(models.strip, bubbles, stripNodes, {
      video: false,
      pan: false,
      jump: false,
      here,
    });
    // The popover's faces exist only while it is open, so exactly one <video>
    // per person is ever attached, and folding detaches them all rather than
    // leaving cameras decoding behind a `hidden`.
    //
    // `models.popover`, NOT `models.strip`: the squeeze tier is about bb's header
    // row, and this box is not in it. See `currentModels`.
    renderBubbles(expanded ? models.popover : EMPTY_MODEL, faces, popoverNodes, {
      video: true,
      pan: true,
      jump: true,
      here,
    });

    // "+N" while there are faces for it to be more than, a plain count when
    // there are not — `overflowLabel`'s call, for the same reason as the title
    // above. Empty means there is nothing to say, which is what the `hidden`
    // reads.
    const count = overflowLabel(models.strip);
    overflow.textContent = count;
    overflow.hidden = count === "";

    // Thread routes only, and only while a header is actually mounted to relay
    // the opener — anything else would be a button that cannot work.
    scribe.hidden = !decideDoorVisible({ hasOpener: transcriptDoor.hasOpener() });

    const live = av.status === "live";
    const connecting = av.status === "connecting";
    audioButton.textContent = live ? "Leave" : connecting ? "Joining…" : "Join audio";
    audioButton.disabled = connecting;
    audioButton.title = live
      ? "Leave the room audio"
      : "Join the room audio (the same call as the canvas page's Join audio)";
    audioButton.dataset.canvasDockAudio = live ? "leave" : "join";

    micButton.textContent = av.muted ? "Unmute" : "Mute";
    micButton.disabled = !live;
    micButton.setAttribute("aria-pressed", String(av.muted));
    micButton.dataset.canvasDockMic = av.muted ? "muted" : "live";
    micButton.title = av.muted ? "Unmute your microphone" : "Mute your microphone";
    micButton.setAttribute("aria-label", micButton.title);

    cameraButton.textContent = av.cameraOn ? "Camera off" : "Camera on";
    cameraButton.disabled = !live;
    cameraButton.setAttribute("aria-pressed", String(av.cameraOn));
    cameraButton.dataset.canvasDockCamera = av.cameraOn ? "on" : "off";
    cameraButton.title = av.cameraOn ? "Turn your camera off" : "Turn your camera on";
    cameraButton.setAttribute("aria-label", cameraButton.title);

    // THE LAST THING IN THE RENDER, and every word of that is load-bearing.
    // The popover is `width: max-content`, so BOTH its dimensions depend on the
    // faces `renderBubbles` just drew and on the button labels just written
    // above — the height doubly so, because `.dock-controls` and `.dock-faces`
    // both wrap, so a wider label can add a line. Measuring any earlier reads a
    // box that is about to change size. And it has to be measured after
    // `popover.hidden = !expanded` at the top, because a hidden popover is
    // `display: none` and measures 0 by 0.
    //
    // SYNCHRONOUS, not deferred to the coalesced pass, and the stakes went UP
    // when the popover became a fixed box on <body>. Opening it is a click, and
    // a click calls `render` directly. An absolutely-positioned popover that
    // was placed a frame late still spent that frame hanging off its strip;
    // this one has no resting position at all — the CSS fallback is the safe
    // corner at the top left of the viewport — so a deferred placement would
    // paint one frame of the popover sitting on bb's own chrome, somewhere with
    // no relationship to the control that opened it. The pass re-runs it for
    // the geometry changes a render never sees.
    syncPopoverPlacement();
  }

  // ---- roster ---------------------------------------------------------

  /**
   * What this tab tells the room about itself.
   *
   * It rides the roster poll rather than a channel of its own — one request per
   * tab per tick instead of two, and a location that can never be newer or
   * older than the membership it arrived with.
   *
   * The title is this tab's own `document.title`, which is how another client
   * can render "in “glossary measure”" without this plugin ever looking a
   * thread up. `where.ts` uses it to name a THREAD and — since the canvas
   * panel began writing its current page name there (canvas/pages/
   * page-title.ts, design doc D-5) — a canvas PAGE, which is the only route by
   * which a page name can reach another client at all: the path carries a page
   * id, never a name. So the blast radius of a client asserting a silly one is
   * a silly thread or page name.
   */
  function selfReport(): {
    clientId: string;
    name?: string;
    path?: string;
    title?: string;
    focused: boolean;
  } {
    const report: {
      clientId: string;
      name?: string;
      path?: string;
      title?: string;
      focused: boolean;
    } = {
      clientId: tabClientId(),
      // WHICH of this person's windows they are actually in. Recency cannot
      // answer that — every window polls on its own 2s timer, so "reported
      // last" flips between two live windows as their phases drift, which is
      // what made one person's whereabouts oscillate. Only one window in the
      // session holds the focus. Sent on every poll rather than on a focus
      // event, because it rides a request this tab was making anyway.
      focused: document.hasFocus(),
    };
    if (selfIdentity !== null) report.name = selfIdentity;
    const path = window.location.pathname;
    // A path the wire would reject (same cap, same rooted-path rule as the
    // schema in server.ts) costs this tab its location, never its whole poll.
    if (path.startsWith("/") && !path.startsWith("//") && path.length <= MAX_PATH_LENGTH) {
      report.path = path;
    }
    const title = document.title.trim();
    if (title.length > 0) report.title = title.slice(0, 200);
    return report;
  }

  async function refreshRoster(): Promise<void> {
    if (disposed) return;
    try {
      const result = await rpc.call("canvas_roster", selfReport());
      polledRoster = parseRoster(result);
      render();
    } catch {
      // Membership is an ornament on most pages: a failed poll keeps the last
      // answer rather than emptying the strip, and the next tick retries.
    }
  }

  /**
   * Notice that THIS tab has moved.
   *
   * Route changes in bb are client-side, so there is no load event to hang
   * this on; what there IS, already, is the rAF-coalesced callback the anchor
   * observer drives on every DOM mutation, plus popstate for back/forward. A
   * pathname compare is a string compare, so riding those costs nothing.
   *
   * It pushes IMMEDIATELY rather than waiting for the next 2s tick, because the
   * instant you change page is exactly the instant everybody else's answer
   * about you becomes wrong.
   */
  function checkRoute(): void {
    if (disposed) return;
    const path = window.location.pathname;
    if (path === herePath) return;
    herePath = path;
    here = parseLocation(path);
    void refreshRoster();
    render();
  }

  /**
   * Put the strip's own faces on the sidebar rows of threads people are
   * reading — and take them off the rows nobody is on.
   *
   * WHY THIS IS OUR DOM AND NOT THE HOST'S. It used to be
   * `experimental_setThreadRowStatus`, and the product owner reported the
   * defect that retired it: the host paints that status into the row's
   * draft-glyph slot, bb reclaims the same slot for the row's hover actions, so
   * hovering the row REPLACED the glyph — and its label, the only place "who"
   * could be said, could only be read by hovering. The payload could not carry
   * a colour either (`{icon, label, tone}`, icon being a name from bb's own
   * registry), so "the same coloured circle as in the header av dock" was not
   * sayable through that door at all. Decorating app-shell DOM from a content
   * script is what the SDK's own docs sanction for exactly this.
   *
   * FED FROM `locatedTabs`, NOT `locateEveryone`. A row asks "is anybody
   * reading this thread", so every located tab votes yes and none votes no —
   * the UNION. Collapsing each person to one tab first made a row go dark
   * because that person's OTHER window happened to poll last, which is a
   * decoration blinking on and off with nothing in the world changing
   * (measured: nine flips in forty-five seconds). `threadRowPresence`
   * deduplicates names, so the union costs nobody a second face.
   *
   * FED FROM THE TAB ROSTER, NOT THE STRIP'S BUBBLES: the strip draws six faces
   * and folds the rest into "+N", but a seventh person reading a thread must
   * still light that row up.
   *
   * YOUR OWN TABS COUNT TOO. The row you are reading carries your own circle,
   * labelled `you` and sorted first — the labelling is `threadRowPresence`'s
   * job, which is why the self name goes IN rather than a doctored list. THE
   * JUMP LINK IS UNCHANGED: `locateEveryone` still refuses to offer to fly you
   * to yourself.
   *
   * ONLY WHAT CHANGED IS WRITTEN. This runs on every render AND on every
   * coalesced DOM mutation bb makes anywhere; a row whose faces are already
   * right is not touched, which is both the cost argument and — since we are
   * mutating the subtree the observer watches — the termination argument.
   */
  function syncRowDecorations(): void {
    if (disposed) return;
    const { roster, av } = canvasBus.snapshot();
    const selfName = resolveSelfName(roster, av.self, selfIdentity);
    const presence = threadRowPresence(
      locatedTabs(mergeRoster(roster, polledRoster)).map((tab) => ({
        name: tab.name,
        location: parseLocation(tab.path),
      })),
      selfName,
    );

    let failed = false;
    let rows: { readonly threadId: string; readonly inset: HTMLElement }[] = [];
    try {
      // The row is the link's parent; the title span is where the faces go.
      // A link whose row has no title span is simply not decoratable — bb
      // restyled it, or it is some other kind of row — and is dropped rather
      // than guessed at. Nothing is written to the host row here: the join
      // between a plan step and a node is the array index, held in this
      // function, so the sidebar carries no bookkeeping of ours.
      rows = Array.from(document.querySelectorAll<HTMLElement>(THREAD_ROW_LINK))
        .map((link) => ({
          threadId: link.dataset.sidebarThreadId ?? "",
          inset: link.parentElement?.querySelector<HTMLElement>(ROW_TITLE_INSET) ?? null,
        }))
        .filter(
          (row): row is { threadId: string; inset: HTMLElement } =>
            row.threadId !== "" && row.inset !== null,
        );

      const slots: RowSlot[] = rows.map((row) => {
        const existing = decorationOf(row.inset);
        return {
          threadId: row.threadId,
          signature: existing === null ? null : (existing.dataset.canvasRowPresence ?? ""),
          leading: existing !== null && row.inset.firstChild === existing,
        };
      });

      for (const step of planRowDecorations(slots, presence)) {
        const inset = rows[step.index]!.inset;
        rowWrites += 1;
        if (step.action === "remove") {
          decorationOf(inset)?.remove();
          continue;
        }
        if (step.action === "move") {
          // A MOVE of a node already in the document, never a second mount —
          // the same guarantee anchor.ts relies on for the strip itself.
          inset.insertBefore(decorationOf(inset)!, inset.firstChild);
          continue;
        }
        // add / update. Painted BEFORE it is in the document on the add path,
        // so the insertion is one mutation record carrying one node that is
        // wholly ours — which is the shape the loop guard recognises.
        const node = decorationOf(inset) ?? createRowDecoration();
        paintRowDecoration(node, step.presence);
        if (inset.firstChild !== node) inset.insertBefore(node, inset.firstChild);
      }
    } catch {
      // A host restyle that breaks a selector must cost the rows, never the
      // strip: this runs inside the same pass that re-places the strip itself.
      failed = true;
    }

    root.dataset.dockRowDecor = rowDecorationState(rows.length, failed);
    root.dataset.dockRows = String(document.querySelectorAll(ROW_DECORATION).length);
    root.dataset.dockRowWrites = String(rowWrites);
  }

  /**
   * The one decoration on a row, and the guarantee that there is only one.
   *
   * Structurally there can never be two — a node is only ever CREATED when the
   * row reports no signature at all, and every other path moves the node it
   * found. This sweeps anyway, because the cost is a `querySelectorAll` on a
   * span with two children and the failure it covers (a generation whose
   * disposer did not run) is invisible otherwise.
   */
  function decorationOf(inset: HTMLElement): HTMLElement | null {
    const found = inset.querySelectorAll<HTMLElement>(ROW_DECORATION);
    for (let index = 1; index < found.length; index += 1) found[index]!.remove();
    return found[0] ?? null;
  }

  /** Drop every decoration this generation put on a row. The nodes live in the
   * host's DOM, so nothing else will: a disposer that left them behind would
   * decorate rows on behalf of a plugin that is no longer running, with faces
   * that stopped updating the moment it stopped. */
  function clearRowDecorations(): void {
    for (const node of Array.from(document.querySelectorAll(ROW_DECORATION))) {
      node.remove();
    }
  }

  /**
   * Clear anything the RETIRED host-status call path may have left set.
   *
   * A one-time sweep over the rows currently in the sidebar, because that is
   * the only enumeration available: the surface is a write with no read-back,
   * so a generation that crashed before its disposer ran left statuses this
   * generation cannot name. The host clears them on generation deactivate and
   * the old disposer cleared them too, so this is belt and braces — but a stale
   * eye sitting next to our circles would read as this feature being half
   * migrated. Passing null is the SDK's own clear operation.
   */
  function retireHostRowStatuses(): void {
    const clear = context.experimental_setThreadRowStatus;
    if (clear === undefined) return;
    try {
      const links = Array.from(document.querySelectorAll<HTMLElement>(THREAD_ROW_LINK));
      for (const link of links) {
        const threadId = link.dataset.sidebarThreadId;
        if (threadId !== undefined && threadId !== "") clear(threadId, null);
      }
    } catch {
      // A host that no longer accepts the call is a host with nothing to clear.
    }
  }

  /**
   * Go to where somebody is: try client-side, fall back to a real navigation.
   *
   * The attempt is a pushed history entry plus a `popstate`, which bb's router
   * answers — but that is an undocumented behaviour of somebody else's router,
   * so it is verified rather than assumed (canvas/dock/navigate.ts's
   * `clientSideTook`, and the tests that pin the fallback). Checked on the next
   * two frames and then once more after JUMP_VERIFY_MS.
   *
   * The fallback is `location.replace`, not `assign`: the pushState above
   * already added a history entry for this path, so replacing it leaves the
   * back button pointing at where the user actually came from rather than at a
   * page that never rendered.
   */
  function jumpTo(path: string): void {
    const before = { path: window.location.pathname, title: document.title };
    try {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    } catch {
      // A router that will not even take a pushed entry is not one to verify.
      window.location.assign(path);
      return;
    }

    let attempt = 0;
    const verify = (): void => {
      // The generation went away mid-jump; the page is being torn down and a
      // navigation now would fight the teardown.
      if (disposed) return;
      const after = { path: window.location.pathname, title: document.title };
      if (clientSideTook(before, after, path)) {
        checkRoute();
        return;
      }
      attempt += 1;
      if (attempt === 1) {
        requestAnimationFrame(verify);
        return;
      }
      if (attempt === 2) {
        window.setTimeout(verify, JUMP_VERIFY_MS);
        return;
      }
      window.location.replace(path);
    };
    requestAnimationFrame(verify);
  }

  // ---- controls -------------------------------------------------------

  audioButton.addEventListener("click", () => {
    if (canvasBus.snapshot().av.status === "live") {
      setStatus("");
      void leaveAudio();
      return;
    }
    setStatus("");
    // Read the self entry at CLICK time rather than closing over a render: the
    // canvas panel may have mounted since, and a token minted without a
    // clientId falls back to the server's own local name.
    const self = canvasBus.snapshot().roster.find((member) => member.isSelf);
    void joinAudio(async () =>
      avTokenFrom(
        await rpc.call(
          "canvas_av_token",
          self === undefined ? {} : { clientId: self.clientId },
        ),
      ),
    ).then((outcome) => {
      if (outcome.ok) {
        void refreshRoster();
        return;
      }
      // The unconfigured case is a setup step, not a failure, and it says which
      // knobs to turn. It is shown in the popover itself rather than as a
      // toast: the strip is on every page and its own status line is
      // guaranteed to be wherever the button the user just pressed is.
      setStatus(
        outcome.reason === "not_configured"
          ? `LiveKit not configured — ${outcome.detail}`
          : `Could not join audio: ${outcome.detail}`,
      );
    });
  });

  micButton.addEventListener("click", () => {
    void setMuted(!canvasBus.snapshot().av.muted);
  });

  cameraButton.addEventListener("click", () => {
    void setCameraEnabled(!canvasBus.snapshot().av.cameraOn);
  });

  /**
   * Fly the canvas camera to somebody.
   *
   * Inherited from the canvas page's own avatar stack, which this strip
   * replaced — it was the one behaviour that lived only there. `canvasBus.panTo`
   * is a no-op when no canvas panel is listening, which is most bb pages, so
   * this is safe to wire on every face everywhere.
   */
  faces.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const face = target.closest<HTMLElement>("[data-canvas-dock-pan]");
    const clientId = face?.dataset.canvasDockPan;
    if (clientId === undefined || clientId === "") return;
    canvasBus.panTo(clientId);
    apply({ type: "pan" });
  });

  /**
   * Jump to where somebody is — the SECOND affordance on a face, below the
   * video, and deliberately not the same gesture as the one above it: the face
   * flies the canvas camera to their cursor, this link moves bb.
   *
   * It is a real `<a href>`, so middle-click, ⌘-click, right-click → copy link
   * address and the browser's status bar all work by this handler declining to
   * act (`shouldTryClientSide`). Only a plain left click is intercepted, and
   * only to spare the user a full reload.
   */
  faces.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[data-canvas-dock-jump]");
    const path = link?.dataset.canvasDockJump;
    if (path === undefined || path === "") return;
    if (
      !shouldTryClientSide({
        button: event.button,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
      })
    ) {
      return; // The browser's gesture, untouched.
    }
    event.preventDefault();
    apply({ type: "jump" });
    jumpTo(path);
  });

  // ---- subscriptions --------------------------------------------------
  //
  // Deliberately after every node above exists: this renders, and the bus can
  // notify the instant we subscribe.

  // Everything that can make the strip out of date, in one place
  // (canvas/dock/repaint.ts): the bus — a mute, a camera, a join phase, the
  // roster, all of which this file reads straight out of `snapshot()` at render
  // time and none of which repaint themselves — and the speaking ring's clock.
  const repaint = createDockRepaint({ render: () => render() });

  // A thread header mounting or unmounting is the only thing that changes
  // whether the transcript button has anywhere to go, and it happens on route
  // changes this file otherwise has no reason to repaint for.
  const unsubscribeDoor = transcriptDoor.subscribe(() => {
    render();
  });

  const pollTimer = setInterval(() => {
    // A background window's strip is not being looked at, and every bb window
    // runs one of these.
    if (!document.hidden) void refreshRoster();
    // OUTSIDE that guard, deliberately. This is the backstop for everything
    // that rides the coalesced pass, and the surface most likely to drop the
    // frame it is standing in for is exactly a hidden one.
    //
    // WHAT THE PASS COSTS, since it is no longer the anchor alone it was when
    // this comment first claimed "a querySelector and three node reads". Five
    // steps run (see `scheduler` above): a string compare on the path, the
    // anchor's own queries, the squeeze tier, the sidebar decorations, and the
    // popover's placement. Between them that is a handful of `querySelector`
    // calls, one `querySelectorAll` over the sidebar's thread links — a
    // virtualised list, so the rows that exist are the rows on screen — and
    // AT MOST FOUR LAYOUT READS — which is all of them in `canvas/dock/`, so
    // this is a count rather than an estimate: the header row's
    // `getBoundingClientRect` for the tier, and the root's rect plus the
    // popover's `offsetWidth` and `offsetHeight` for the placement. Three on
    // the fixed placement, where there is no row to measure. It was three and
    // two before the popover became a fixed box that has to be positioned on
    // both axes rather than nudged on one.
    //
    // Layout reads are the expensive kind, and these are still cheap enough to
    // ride a 2s tick because of what is NOT between them. Only the last step
    // writes unconditionally, and what it writes is two custom properties
    // feeding a transform; every other step writes solely when its answer
    // changed. So a quiet pass forces layout at most once rather than thrashing
    // read/write,
    // and once every two seconds per window is not a cost worth a second timer
    // or a hidden-document guard. The frame-rate path — the same pass driven by
    // the ResizeObserver through a pane drag — is the one where this argument
    // has to be made carefully, and it is, at `syncSqueeze` and
    // `syncPopoverPlacement`.
    //
    // Its usual answer is still "nothing to do".
    scheduler.poll();
  }, ROSTER_POLL_MS);

  // The ring's heartbeat, in BOTH directions: it puts a ring out when the
  // talking stops rather than on the next unrelated bus event, and — because
  // the bus swallows a repeated identical speaker list — it is also the only
  // thing keeping a lone steady talker's ring alive. Unlike the bus, this
  // cadence repaints only when the ring actually changed: it runs four times a
  // second for the whole session, so a silent sweep costs one array read.
  const speakingTimer = setInterval(() => {
    repaint.tick();
  }, SPEAKING_TICK_MS);

  // Back/forward, and anything else that moves the URL without touching the
  // DOM first. Cheap, and it means a route change never waits for a mutation.
  const onPopState = (): void => {
    checkRoute();
  };
  window.addEventListener("popstate", onPopState);

  const onVisibility = (): void => {
    if (document.hidden) return;
    void refreshRoster();
    // requestAnimationFrame does not run in a hidden tab, so a route change
    // made in a background window lands here with the strip still pointing at
    // the old row.
    scheduleAnchorSync();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Who this browser is, from the same one door the canvas panel uses. It never
  // rejects (see fetchIdentity), so it cannot wedge the mount; until it lands,
  // the strip simply does not know which bubble is you.
  void fetchIdentity((input, init) =>
    fetch(input, { ...init, signal: context.signal }),
  ).then((identity) => {
    if (disposed) return;
    selfIdentity = identity.name;
    render();
    // Re-report immediately: the first poll went out unnamed, and a member the
    // room cannot name is a member nobody can see.
    void refreshRoster();
  });

  // Before the first render, so a status left behind by the retired call path
  // is gone by the time our own circles arrive.
  retireHostRowStatuses();
  syncAnchor();
  // Not for the tier — that was seeded from a measurement above — but for the
  // observer: without a first pass nothing is being watched until the next
  // mutation or the 2s tick, and a pane dragged in that window would move the
  // row silently.
  syncSqueeze();
  checkRoute();
  render();
  void refreshRoster();

  return () => {
    disposed = true;
    observer.disconnect();
    // `disconnect` and not `unobserve(observedRow)`: the row it is watching is
    // a node bb owns and outlives this generation, so an observer left on it
    // would keep firing into a strip that has been removed for as long as the
    // window is open.
    sizeObserver.disconnect();
    scheduler.stop();
    unsubscribeDoor();
    repaint.stop();
    clearInterval(pollTimer);
    clearInterval(speakingTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("popstate", onPopState);
    clearRowDecorations();
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown);
    // Detach every tile before the nodes go, so livekit-client is not left
    // holding elements that are no longer in a document.
    for (const [key, node] of popoverNodes) {
      if (node.video !== null) detachVideo(key, node.video);
    }
    popoverNodes.clear();
    stripNodes.clear();
    root.remove();
    // The popover is NOT inside `root` any more, so `root.remove()` no longer
    // takes it with it. Removed by reference AND swept for by attribute,
    // document-wide, which is the discipline the row decorations already carry
    // (see `clearRowDecorations`, and the README's note on why): these nodes
    // live in the host's DOM outside anything we hold, and a generation that
    // ended without getting to its reference would strand a dialog — with
    // LiveKit tiles attached to it — in the page for the life of the window.
    // The sweep is a superset of the `remove()` above and the two are kept
    // separate on purpose: the reference is the one that is certainly right,
    // the sweep is the one that catches what we no longer have a reference to.
    popover.remove();
    for (const node of Array.from(document.querySelectorAll(POPOVER_NODE))) {
      node.remove();
    }
    style.remove();
    // The LiveKit session is deliberately NOT torn down here. A plugin reload
    // must not drop the user out of a call they are in; av-room.ts is a module
    // singleton that outlives this generation, and the next strip picks the
    // live session straight back up from the bus.
  };
}

// ---------------------------------------------------------------------------
// The sidebar row decoration
// ---------------------------------------------------------------------------

/**
 * An empty decoration node, ready to be painted.
 *
 * `role="img"` plus an `aria-label` is what makes the accessible name readable
 * WITHOUT hovering, which is the defect being fixed: the retired host status
 * put the names in a label on a glyph that a hover replaced. The circles
 * themselves are `aria-hidden` — two initials read out one letter at a time
 * are noise next to "you, matt viewing".
 *
 * `pointer-events: none` (in the stylesheet) is not decoration: the row's
 * overlay `<a>` is `position:absolute; inset:0` and therefore paints ABOVE
 * this static span, so a click here already reaches the row (measured with
 * `elementFromPoint` on the running app — the hit at the face's centre is the
 * row's own link). Declining pointer events makes that a guarantee rather than
 * a consequence of paint order.
 */
function createRowDecoration(): HTMLElement {
  const node = document.createElement("span");
  node.className = "canvas-row-presence";
  node.setAttribute("role", "img");
  // Present but empty until painted, so a node that somehow reached the
  // document unpainted reads as a stale signature and gets rewritten rather
  // than being mistaken for an absent decoration.
  node.dataset.canvasRowPresence = "";
  return node;
}

/**
 * Paint one row's faces.
 *
 * Torn down and rebuilt rather than reconciled child-by-child, which is the
 * opposite of what `renderBubbles` does for the strip — and correct here for
 * the reason that forced it there: the strip's faces can hold a live `<video>`
 * that must never be re-inserted. These hold two initials. The reconciliation
 * that matters happens a level up, where a row whose faces have not changed is
 * not repainted at all.
 *
 * The signature is written LAST. It is the plugin's read-back, so it must not
 * claim to describe a decoration that is only half painted.
 */
function paintRowDecoration(node: HTMLElement, presence: RowPresence): void {
  node.textContent = "";
  for (const face of presence.faces) {
    const circle = document.createElement("span");
    circle.className = "canvas-row-face";
    circle.dataset.canvasRowFace = face.name;
    circle.dataset.canvasRowSelf = face.isSelf ? "true" : "false";
    // The same name-derived hue the strip's bubble and the canvas cursor use.
    // Inline, because it is per-person data and cannot be a class.
    circle.style.background = face.color;
    circle.textContent = face.initials;
    circle.setAttribute("aria-hidden", "true");
    node.appendChild(circle);
  }
  if (presence.overflow > 0) {
    const more = document.createElement("span");
    more.className = "canvas-row-more";
    more.textContent = `+${presence.overflow}`;
    more.setAttribute("aria-hidden", "true");
    node.appendChild(more);
  }
  // Both, deliberately. The aria-label is the one that works — the row's
  // overlay link is on top, so a native tooltip may never fire — but the title
  // costs nothing and is the first thing a person inspecting the DOM reads.
  node.title = presence.label;
  node.setAttribute("aria-label", presence.label);
  node.dataset.canvasRowPresence = presence.signature;
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

const EMPTY_MODEL: DockModel = { bubbles: [], overflow: 0 };

interface BubbleNode {
  readonly root: HTMLElement;
  readonly initials: HTMLSpanElement;
  video: HTMLVideoElement | null;
  /** The face plus the whereabouts line under it, when there is one. The
   * <video> must stay attached to `root`, so the two are separate nodes and
   * this is the one the row inserts. Null on the strip's own faces, which are
   * bare. */
  readonly wrapper: HTMLElement | null;
  /** "jump to them", when their location is known and they are not you. */
  readonly link: HTMLAnchorElement | null;
  /** The same sentence when it is NOT a link — you, or somebody whose location
   * is unknown or stale. Where they are is still worth reading. */
  readonly whereabouts: HTMLSpanElement | null;
}

interface BubbleOptions {
  /** Whether a camera publisher's face becomes a live tile here. Only the
   * popover's faces do — one attached <video> per person, ever. */
  readonly video: boolean;
  /** Whether a face is a button that flies the canvas camera to that person.
   * The strip's faces are not: they are inside the strip's own <button>. */
  readonly pan: boolean;
  /** Whether each face carries a whereabouts line BELOW it — per the ask, the
   * jump link is a separate affordance from the face, not the face itself. */
  readonly jump: boolean;
  /** The VIEWER's own location, which is what turns "in thread thr_x" into
   * "in this thread". */
  readonly here: BbLocation | null;
}

/**
 * Reconcile a bubble row against the model.
 *
 * Node-by-node rather than innerHTML, for one reason: a `<video>` removed from
 * the document and re-added loses its stream and flashes black. Someone else
 * starting to talk must not blink everyone's camera.
 */
function renderBubbles(
  model: DockModel,
  container: HTMLElement,
  nodes: Map<string, BubbleNode>,
  options: BubbleOptions,
): void {
  const wanted = new Set(model.bubbles.map((bubble) => bubble.key));
  for (const [key, node] of [...nodes]) {
    if (wanted.has(key)) continue;
    if (node.video !== null) detachVideo(key, node.video);
    (node.wrapper ?? node.root).remove();
    nodes.delete(key);
  }

  model.bubbles.forEach((bubble, index) => {
    let node = nodes.get(bubble.key);
    if (node === undefined) {
      node = createBubble(options);
      nodes.set(bubble.key, node);
    }
    updateBubble(node, bubble, options);
    // Only touch the DOM when the node is not already where the model wants
    // it. A `<video>` re-inserted into the tree — even into the same parent —
    // can drop a frame or pause, and the order is alphabetical and therefore
    // unchanged on the overwhelming majority of renders.
    const outer = node.wrapper ?? node.root;
    if (container.children[index] !== outer) {
      container.insertBefore(outer, container.children[index] ?? null);
    }
  });
}

function createBubble(options: BubbleOptions): BubbleNode {
  const root = document.createElement(options.pan ? "button" : "span");
  if (root instanceof HTMLButtonElement) root.type = "button";
  root.className = "dock-bubble";
  const initials = document.createElement("span");
  initials.className = "dock-initials";
  initials.setAttribute("aria-hidden", "true");
  root.appendChild(initials);
  if (!options.jump) {
    return { root, initials, video: null, wrapper: null, link: null, whereabouts: null };
  }

  const wrapper = document.createElement("div");
  wrapper.className = "dock-face";
  // A REAL LINK, with a real href. That is what makes middle-click, ⌘-click,
  // "copy link address" and the browser's status bar work — none of which a
  // <button> with a click handler can offer, however much script you write.
  const link = document.createElement("a");
  link.className = "dock-jump";
  const whereabouts = document.createElement("span");
  whereabouts.className = "dock-jump dock-jump-inert";
  wrapper.append(root, link, whereabouts);
  return { root, initials, video: null, wrapper, link, whereabouts };
}

function updateBubble(
  node: BubbleNode,
  bubble: DockBubble,
  options: BubbleOptions,
): void {
  node.root.dataset.canvasDockBubble = bubble.key;
  node.root.dataset.canvasDockSpeaking = bubble.isSpeaking ? "true" : "false";
  node.root.dataset.canvasDockSelf = bubble.isSelf ? "true" : "false";
  node.root.style.background = bubble.color;
  node.initials.textContent = bubble.initials;

  if (options.pan) {
    // Disabled when that person has no cursor on the canvas: they are
    // connected but have not moved a pointer, so there is nowhere honest to
    // jump to, and inventing a destination would teach the gesture to lie.
    const canPan = bubble.canPan && bubble.clientId !== null;
    if (canPan && bubble.clientId !== null) {
      node.root.dataset.canvasDockPan = bubble.clientId;
    } else {
      delete node.root.dataset.canvasDockPan;
    }
    if (node.root instanceof HTMLButtonElement) node.root.disabled = !canPan;
    node.root.title = canPan
      ? `${bubble.label} — jump to their cursor`
      : `${bubble.label} — no cursor on the canvas yet`;
  } else {
    node.root.title = bubble.label;
  }
  node.root.setAttribute("aria-label", bubble.label);

  if (node.link !== null && node.whereabouts !== null) {
    updateWhereabouts(node.link, node.whereabouts, bubble, options.here);
  }

  if (options.video && bubble.hasVideo && node.video === null) {
    const video = document.createElement("video");
    video.className = "dock-video";
    video.autoplay = true;
    video.playsInline = true;
    // Your own tile is your own camera: muting it is the difference between a
    // self-view and a feedback loop.
    video.muted = true;
    // attachVideo answers false when the track vanished between the bus update
    // and this frame — in which case we keep initials rather than showing a
    // black rectangle.
    if (attachVideo(bubble.key, video)) {
      node.root.appendChild(video);
      node.video = video;
    }
  } else if ((!options.video || !bubble.hasVideo) && node.video !== null) {
    detachVideo(bubble.key, node.video);
    node.video.remove();
    node.video = null;
  }
  node.root.dataset.canvasDockVideo = node.video === null ? "false" : "true";
}


/**
 * The line under a face: where that person is, as a link when it is somewhere
 * this browser can honestly be sent.
 *
 * NO LINK FOR YOU, and no link for somebody whose location is unknown or stale
 * — the server nulls a location past LOCATION_STALE_MS precisely so this can
 * decline rather than send a teammate to the page you were on a minute ago. In
 * both cases the SENTENCE still shows: where somebody is is worth reading even
 * when there is nowhere to click.
 *
 * `href` is set from `jumpHref`, which refuses anything that is not a rooted
 * same-origin path — this string came off the wire from another client.
 */
function updateWhereabouts(
  link: HTMLAnchorElement,
  inert: HTMLSpanElement,
  bubble: DockBubble,
  here: BbLocation | null,
): void {
  const there = bubble.path === null ? null : parseLocation(bubble.path);
  const label = locationLabel(there, here, bubble.title);
  const href = bubble.isSelf ? null : jumpHref(bubble.path);

  if (href === null) {
    link.hidden = true;
    link.removeAttribute("href");
    delete link.dataset.canvasDockJump;
    // And the sentence goes with them. The node is display:none and carries no
    // href, so only textContent scraping could ever see it — but a stale "in
    // \u201cUnread thread\u201d" left lying inside the DOM is a wrong answer to
    // anyone who reads the DOM, which is exactly what a test harness does.
    link.textContent = "";
    link.removeAttribute("title");
    inert.hidden = false;
    inert.textContent = label;
    inert.title = bubble.isSelf ? `You are ${label}` : `${bubble.label} — ${label}`;
    return;
  }

  inert.hidden = true;
  inert.textContent = "";
  link.hidden = false;
  link.href = href;
  // The path is carried in a data attribute as well as the href so the click
  // handler reads exactly what was rendered, not the absolute URL the DOM
  // resolves `.href` to.
  link.dataset.canvasDockJump = href;
  link.textContent = label;
  link.title = `${bubble.label} — ${label}. Click to go there.`;
  link.setAttribute("aria-label", `Go to ${bubble.name} — ${label}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** bb's page-header row, on the routes that render one. */
function headerRow(): Element | null {
  return document.querySelector(HEADER_ROW_SELECTOR);
}

/**
 * How wide the container the strip is drawing into is right now.
 *
 * Hands only: the read, and nothing about what the number means — which of the
 * two containers counts, and what an unmeasurable row is allowed to do to the
 * layout, are `containerWidth`'s (canvas/dock/squeeze.ts).
 *
 * `getBoundingClientRect().width` rather than `offsetWidth`: the row arrives as
 * an `Element`, which is what `querySelector` returns and all this file ever
 * knows about it, and `offsetWidth` is only on `HTMLElement`. It is also the
 * unrounded width, so a pane dragged slowly past a threshold does not report
 * the same rounded integer for several frames.
 */
function measureContainer(row: Element | null): number {
  return containerWidth(
    row?.getBoundingClientRect().width ?? null,
    // The fixed placement is pinned to the corner of the window, so the window
    // is not a stand-in for a container there — it IS the container.
    window.innerWidth,
  );
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.title = title;
  return element;
}

/** The strip's mic glyph: the quiet "you are in a call" tell, and the thing
 * left to click when the room is empty. Drawn rather than an emoji, because an
 * emoji in bb's title bar is a different font at a different baseline on every
 * platform. */
function micGlyph(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [
    "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
    "M5 11a7 7 0 0 0 14 0",
    "M12 18v3",
  ]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/* WHAT THE STRIP SAYS ABOUT THE ROOM USED TO BE HERE — a private `describe()`
   plus a "no bubbles means nobody is here" ternary in `render`. It is
   `describeRoom` in canvas/dock/model.ts now, with tests/dock.test.ts on it,
   because the `bare` tier made that second half false: a strip drawing no faces
   for a room full of people announced "nobody here yet" to all of them. */

/** The `canvas_av_token` result, narrowed. A shape we cannot read is a genuine
 * fault (not the unconfigured case), so it throws and av-room turns it into a
 * `failed` outcome the status line can show. */
function avTokenFrom(value: unknown): AvTokenResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("canvas_av_token returned something that is not a result");
  }
  const ok = Reflect.get(value, "ok");
  if (ok === false) {
    const detail = Reflect.get(value, "detail");
    return {
      ok: false,
      error: "not_configured",
      detail: typeof detail === "string" ? detail : "LiveKit is not configured.",
    };
  }
  const url = Reflect.get(value, "url");
  const token = Reflect.get(value, "token");
  const room = Reflect.get(value, "room");
  const identity = Reflect.get(value, "identity");
  if (
    ok !== true ||
    typeof url !== "string" ||
    typeof token !== "string" ||
    typeof room !== "string" ||
    typeof identity !== "string"
  ) {
    throw new Error("canvas_av_token returned a token this client cannot read");
  }
  return { ok: true, url, token, room, identity };
}

/** Drop the floating pill's persisted state. The dock used to remember where it
 * had been dragged to and whether it was collapsed; the strip is furniture in
 * bb's bar, has nowhere to be dragged to, and starts folded on every page load
 * by construction (canvas/dock/expand.ts). */
function forgetRetiredPreferences(): void {
  try {
    for (const key of RETIRED_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Private mode, a blocked origin, a quota — none of which should cost the
    // user their strip.
  }
}

// ---------------------------------------------------------------------------
// THE TRANSCRIPT BUTTON, AND WHY IT TOOK A RELAY
//
// mockups/transcript-sidebar.html shows a fourth door to the room transcript on
// this widget. It exists now — the `.dock-transcript` button in the POPOVER's
// controls row, beside Join audio / Mute / Camera on — and the shape of it is
// dictated by two facts that were measured on the running app (bb 0.40.0,
// SDK 0.4.21) on 2026-09-01.
//
// ITS HOME IS NOT WHERE IT STARTED. It spent its first life as a bare 📜 glyph
// of our own in bb's header row, next to the strip. That row is the scarce
// surface — on a narrow screen it holds the page title and every action bb
// itself wants — and a second control of ours there costs horizontal space on
// every route. The popover costs none: it is opened on demand and already has
// a row of controls. Nothing below changed with the move; the relay is the
// same relay, and it is the part worth reading.
//
// FIRST, THIS FILE STILL CANNOT OPEN A PANEL BY ITSELF. `PluginContentScriptContext`
// carries `pluginId`, `generation`, `signal` and `experimental_setThreadRowStatus`
// and nothing else (confirmed against the running bundle, not just the .d.ts),
// and `globalThis.__bbPluginRuntime` exposes React, Radix, sonner and the SDK's
// hooks — no imperative navigate. A content script has no fiber, so it cannot
// call a hook.
//
// SECOND, THE NEWLY SANCTIONED CLIENT-SIDE NAVIGATION DOES NOT REACH IT EITHER.
// navigate.ts may now push history and fall back to a reload — but the thread
// panel is not in the URL. Opening the transcript the two sanctioned ways
// leaves path, query, hash, `history.state` and `history.length` untouched; the
// open tab lives in localStorage (`bb.thread.fixedPanelTabsState-<id>-1`). There
// is nothing to push at. `toPluginPanel` is a real navigate, but for NAV panels.
//
// SO IT IS A RELAY, and the seam is canvas/dock/transcript-door.ts: a
// `experimental_threadHeaderAction` component that renders nothing publishes
// `useBbNavigate().openThreadPanel` into a module singleton this file calls.
// The slot renders into the same header action row this strip is prepended
// into, which fiber-walking on the live app proved is inside the provider that
// hook reads — and, decisively, the plugin's always-mounted sidebar accessory
// is NOT. Thread routes only, therefore, which is the truth about the object
// rather than a limitation of the trick: there is no transcript panel on the
// canvas page, on settings or on home, and the button hides itself there.
//
// The full evidence, including the palette-synthesis route that works and is
// refused, is in README.md under "The 📜 button — how it was ruled out, and how
// it got built anyway".
// ---------------------------------------------------------------------------
