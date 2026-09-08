// The agent-sticky UI: a floating "Run as agent" button on a selected note and
// a status badge on every note that has a thread.
//
// THERE IS NO THREAD PANEL HERE ANY MORE. Owner request, 2026-09-08: "when we
// choose to 'open thread' it opens the thread in the sidebar rather than in the
// main thread window. remove the 'fake' thread opening in the sidebar of the
// canvas." A <ThreadChat> mounted beside the canvas is a second, lesser copy of
// a surface bb already owns — it looked like the thread window without being
// it. Opening now leaves the plugin entirely, through
// `useBbNavigate().toThread`; this file's `onOpen` port is unchanged and the
// panel supplies that navigation.
//
// ALL PLUGIN CHROME, ANCHORED TO THE CANVAS. Nothing here is a canvas shape and
// nothing here touches @ensembleworks/canvas-react — this spike consumes those
// packages without modifying them, and "a note has an agent" is a bb concept
// the canvas document knows nothing about. So the badges live in an ordinary
// absolutely-positioned div layered over the viewport, positioned with exactly
// the transform the collaborator cursors already use:
//
//   worldBounds(doc, shape)  ->  worldToScreen(camera, corner)
//
// which is why a badge tracks its note through pan, zoom, drag and remote
// edits without this layer subscribing to anything of its own: it re-renders
// with the same `camera` and `snapshot` the shapes do.
//
// POINTER EVENTS. The layer is `pointer-events: none` and only its controls
// take `pointer-events: auto`, so the canvas underneath keeps every gesture.
// The layer is also a LATER DOM SIBLING than <Viewport>, which is what puts it
// on top (Viewport's documented stacking contract) — no z-index needed.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Camera } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { agentArmsFor, agentTargetFor, type AgentTarget } from "./agent-arms.js";
import {
  nextAgentMenu,
  type AgentMenuEvent,
  type AgentMenuState,
} from "./agent-menu.js";
import {
  badgeAnchorVisible,
  screenBoxFor,
  type ScreenBox,
} from "./agents-view.js";
import {
  NO_POPOVER_ANCHOR,
  POPOVER_EDGE_MARGIN_PX,
  POPOVER_Z_INDEX,
  placePopoverBox,
  type PopoverAnchor,
  type PopoverRect,
} from "./dock/popover-place.js";
import {
  CHROME_FIELD,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_MUTED,
  CHROME_PAPER,
  CHROME_POPOVER_SHADOW,
} from "./pages/chrome-dock.js";
import {
  filterThreadOptions,
  threadOptionNote,
  threadOptionSelectable,
  threadPickerEnterTarget,
  type ThreadOption,
} from "./thread-picker.js";
import type { CanvasAgentLink, CanvasAgentStatus } from "./wire.js";

/**
 * Badge dot styling per status. `bg-destructive` is a host token (failure is a
 * concept bb's theme already has an opinion about); running and idle are
 * default-palette utilities because "in progress" and "done" are not host
 * tokens and inventing a `@theme` colour for them is exactly what the plugin
 * styling rules forbid.
 */
const STATUS_DOT: Record<CanvasAgentStatus, string> = {
  running: "bg-amber-500 animate-pulse",
  idle: "bg-emerald-500",
  failed: "bg-destructive",
};

const STATUS_LABEL: Record<CanvasAgentStatus, string> = {
  running: "Agent running",
  idle: "Agent finished",
  failed: "Agent failed",
};

export interface AgentLayerProps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  /** The editor's live selection. A single shape in it gets the affordance. */
  readonly selection: ReadonlySet<string>;
  /** Every known link, keyed by shape id. */
  readonly links: Readonly<Record<string, CanvasAgentLink>>;
  /** The page the user is looking at. Chrome anchored to a shape on any OTHER
   * page must not be drawn — see `screenBoxFor`. */
  readonly currentPageId: string;
  /** Non-null while a spawn is in flight for that shape. */
  readonly pendingShapeId: string | null;
  readonly onRun: (shapeId: string) => void;
  readonly onOpen: (threadId: string) => void;
  /** Break this note's link to its thread. The thread itself is untouched. */
  readonly onUnlink: (shapeId: string) => void;
  /** Bind this shape to a thread that already exists in bb. */
  readonly onAttach: (shapeId: string, threadId: string) => void;
  /** The threads the picker may offer, fetched on open. Async because only the
   * backend has a bb SDK — the frontend has none. */
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
}

export function AgentLayer({
  doc,
  camera,
  viewportSize,
  selection,
  links,
  currentPageId,
  pendingShapeId,
  onRun,
  onOpen,
  onUnlink,
  onAttach,
  loadThreadOptions,
}: AgentLayerProps): ReactNode {
  // WHICH SHAPE, and it is deliberately no longer "a note": attach needs no
  // prompt, so the affordance is offered on anything and only the LAUNCH arm
  // is kind-gated. The whole rule is canvas/agent-arms.ts's.
  const target = agentTargetFor({
    selection,
    kindOf: (shapeId) => doc.byId.get(shapeId)?.kind,
  });
  const targetBox =
    target === null
      ? null
      : screenBoxFor(doc, camera, viewportSize, target.shapeId, currentPageId);

  return (
    <div
      data-canvas-layer="agents"
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      {Object.values(links).map((link) => {
        const box = screenBoxFor(doc, camera, viewportSize, link.shapeId, currentPageId);
        if (box === null) return null;
        // The dot straddles the corner it marks, and this layer is not clipped
        // — so a corner within a badge-radius of an edge puts the dot outside
        // the drawing surface, on the page tabs above it. See
        // `badgeAnchorVisible`.
        if (!badgeAnchorVisible(box, viewportSize)) return null;
        return (
          <AgentBadge
            key={link.shapeId}
            link={link}
            box={box}
            onOpen={onOpen}
            onUnlink={onUnlink}
          />
        );
      })}

      {target === null || targetBox === null ? null : (
        <AgentAffordance
          target={target}
          box={targetBox}
          linked={links[target.shapeId] !== undefined}
          pendingShapeId={pendingShapeId}
          onRun={onRun}
          onAttach={onAttach}
          loadThreadOptions={loadThreadOptions}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE ONE AFFORDANCE, ITS TWO ARMS, AND THE PICKER BEHIND THE SECOND.
//
// Owner ask, 2026-09-06: "Currently we have a button to 'run a thread'. Lets
// rather have the option to launch/attach a specific note/shape to a real BB
// thread that also appears in the regular BB sidebar." Clarified to: keep both
// paths, behind one affordance.
//
// EVERY DECISION IS SOMEWHERE ELSE. Which arms exist and which are enabled is
// canvas/agent-arms.ts; which of the three surfaces is showing is
// canvas/agent-menu.ts; which threads are offered, in what order, and how the
// query narrows them is canvas/thread-picker.ts; whether a chosen thread may be
// bound at all is canvas/agent-attach.ts (server-side, and re-checked there —
// this file's disabled rows are the affordance half, not the guarantee). What
// is left here is paint and hands, which is the only shape a component can have
// in a project with no jsdom.

/** The arms menu's panel. In-layer rather than portalled, like the badge menu
 * above it: two short items anchored to a button that is itself already
 * positioned by `screenBoxFor` on every camera frame. */
const armsMenuClassName =
  "w-56 rounded-md border border-border bg-card p-1 text-xs shadow-md";

const pickerStyle: CSSProperties = {
  position: "fixed",
  // The shared layer, for the reason canvas/dock/popover-place.ts's
  // POPOVER_Z_INDEX gives in full: under bb's dialogs and command palette,
  // over this plugin's own chrome. Portalling to <body> is what makes the
  // number mean anything — only in the root stacking context is it compared
  // against bb's layers rather than against whatever context an ancestor
  // happened to open.
  zIndex: POPOVER_Z_INDEX,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  // `min()` rather than a media query: portalled to <body>, so the only width
  // this box can honestly reason about is the window's.
  width: "min(360px, 80vw)",
  maxHeight: "min(60vh, 420px)",
  overflowY: "auto",
  padding: 6,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
};

const pickerFilterStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: 4,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_FIELD,
  color: CHROME_INK,
  font: CHROME_FONT,
};

const pickerNoteStyle: CSSProperties = {
  padding: "6px 8px",
  color: CHROME_MUTED,
  font: CHROME_FONT,
};

/** One thread row. A style FUNCTION of `enabled`, not a behavioural branch —
 * the same shape PageSwitcher's `microButtonStyle(enabled)` has. */
function pickerRowStyle(enabled: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "5px 8px",
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: enabled ? CHROME_INK : CHROME_MUTED,
    font: CHROME_FONT,
    cursor: enabled ? "pointer" : "default",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

/** An element's rect as a popover anchor, or the module's anchorless value.
 * The same two lines PageSwitcher.tsx's `anchorOf` is, and for the same
 * reason: an absent anchor routes into popover-place.ts's own tested fallback
 * (the safe corner) instead of an `if (!anchor) return;` written here, which no
 * test in this jsdom-free project could read. */
function anchorOf(element: Element | null): PopoverAnchor {
  if (element === null) return NO_POPOVER_ANCHOR;
  const anchor = element.getBoundingClientRect();
  return {
    anchorLeft: anchor.left,
    anchorRight: anchor.right,
    anchorTop: anchor.top,
    anchorBottom: anchor.bottom,
  };
}

interface AgentAffordanceProps {
  readonly target: AgentTarget;
  readonly box: ScreenBox;
  /** Does this shape already have a thread? Renames the launch arm only. */
  readonly linked: boolean;
  readonly pendingShapeId: string | null;
  readonly onRun: (shapeId: string) => void;
  readonly onAttach: (shapeId: string, threadId: string) => void;
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
}

function AgentAffordance({
  target,
  box,
  linked,
  pendingShapeId,
  onRun,
  onAttach,
  loadThreadOptions,
}: AgentAffordanceProps): ReactNode {
  const [state, setState] = useState<AgentMenuState>("closed");
  const [query, setQuery] = useState("");
  /** null while the fetch is in flight — a distinct state from "no threads". */
  const [options, setOptions] = useState<ThreadOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const dispatch = useCallback((event: AgentMenuEvent) => {
    setState((previous) => nextAgentMenu(previous, event));
  }, []);

  // THE ANCHOR MOVING IS AN EVENT, not a remount. Keying this component on the
  // shape id would close the menu too, but it would do it by throwing the whole
  // subtree away — and then "what happens when the selection moves" would be a
  // fact about React's reconciler rather than a rule canvas/agent-menu.ts
  // states and tests/agent-menu.test.ts drives.
  useEffect(() => {
    dispatch({ type: "target-changed" });
  }, [dispatch, target.shapeId]);

  // Dismissal. `pointerdown`, not `click`: the canvas begins a gesture on
  // pointerdown, so a menu still on screen at that moment is a menu overlapping
  // a drag that has already started. `insideWidget` is computed over BOTH roots
  // because the picker is portalled to <body> and is therefore not a descendant
  // of the button — the lesson canvas/dock/dock.ts records.
  useEffect(() => {
    if (state === "closed") return;
    const onPointerDown = (event: Event): void => {
      const node = event.target;
      const insideWidget =
        node instanceof Node &&
        (rootRef.current?.contains(node) === true ||
          pickerRef.current?.contains(node) === true);
      dispatch({ type: "pointerdown", insideWidget });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dispatch({ type: "escape" });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [state, dispatch]);

  // The picker's contents, fetched once per open. `cancelled` rather than an
  // AbortController: the rpc client has no signal to hand one to, and the only
  // thing that must not happen is a late answer writing state into a picker
  // that has since closed or moved to another shape.
  useEffect(() => {
    if (state !== "picker") return;
    let cancelled = false;
    setOptions(null);
    setLoadError(null);
    setQuery("");
    loadThreadOptions()
      .then((loaded) => {
        if (!cancelled) setOptions(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setOptions([]);
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [state, loadThreadOptions, target.shapeId]);

  // The caret goes in the filter box, which is what makes "type the thread's
  // name" the fast path the arm's label promises.
  useLayoutEffect(() => {
    if (state !== "picker") return;
    filterRef.current?.focus();
  }, [state]);

  // ---- the picker's placement ---------------------------------------------

  const [pickerBox, setPickerBox] = useState<PopoverRect>({
    left: POPOVER_EDGE_MARGIN_PX,
    top: POPOVER_EDGE_MARGIN_PX,
  });

  useLayoutEffect(() => {
    if (state !== "picker") return;
    const place = (): void => {
      const popover = pickerRef.current?.getBoundingClientRect();
      if (!popover) return;
      setPickerBox(
        placePopoverBox({
          ...anchorOf(buttonRef.current),
          popoverWidth: popover.width,
          popoverHeight: popover.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    window.addEventListener("resize", place);
    // Capture, so a scroll in any ancestor container is seen: a fixed box does
    // not move with its anchor, and a picker left behind by a scrolled panel is
    // worse than one that is merely misplaced.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // The box's own height changes as the filter narrows the list, so a
    // re-place is owed on every change to what it draws.
  }, [state, options, query]);

  const arms = agentArmsFor(target, linked);
  const visibleRows = filterThreadOptions(options ?? [], query);
  const attach = useCallback(
    (option: ThreadOption): void => {
      if (!threadOptionSelectable(option, target.shapeId)) return;
      dispatch({ type: "attached" });
      onAttach(target.shapeId, option.threadId);
    },
    [dispatch, onAttach, target.shapeId],
  );

  const picker =
    state !== "picker"
      ? null
      : createPortal(
          // PORTALLED TO <body> so the box escapes every ancestor's overflow
          // and any transformed ancestor in bb's shell (a transform makes
          // `position: fixed` resolve against that ancestor instead of the
          // viewport, which would trap this box inside the pane it is trying to
          // hang out of). Both of this plugin's other popovers live on <body>
          // for the same reason.
          <div
            ref={pickerRef}
            data-canvas-thread-picker={target.shapeId}
            role="dialog"
            aria-label="Attach to an existing thread"
            style={{ ...pickerStyle, left: pickerBox.left, top: pickerBox.top }}
          >
            <input
              ref={filterRef}
              type="text"
              value={query}
              aria-label="Filter threads"
              placeholder="Filter threads…"
              data-canvas-thread-filter
              style={pickerFilterStyle}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const top = threadPickerEnterTarget(visibleRows);
                if (top !== null) attach(top);
              }}
            />
            {options === null ? (
              <div style={pickerNoteStyle}>Loading threads…</div>
            ) : loadError !== null ? (
              <div style={pickerNoteStyle}>{loadError}</div>
            ) : visibleRows.length === 0 ? (
              <div style={pickerNoteStyle}>
                {query.trim().length === 0
                  ? "No threads in this project yet."
                  : `No thread matches \u201c${query.trim()}\u201d.`}
              </div>
            ) : (
              visibleRows.map((option) => {
                const selectable = threadOptionSelectable(option, target.shapeId);
                const note = threadOptionNote(option, target.shapeId);
                return (
                  <button
                    key={option.threadId}
                    type="button"
                    data-canvas-thread-option={option.threadId}
                    disabled={!selectable}
                    title={option.threadId}
                    onClick={() => attach(option)}
                    style={pickerRowStyle(selectable)}
                  >
                    {note === null ? option.label : `${option.label} \u2014 ${note}`}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        );

  return (
    <div
      ref={rootRef}
      // Centred just below the shape, out of the way of the selection handles
      // the overlay draws on its corners and edges. The wrapper carries the
      // position so the arms menu is anchored to the button rather than to the
      // viewport, and therefore travels with the shape under pan and zoom like
      // everything else in this layer.
      style={{
        position: "absolute",
        left: (box.left + box.right) / 2,
        top: box.bottom + 10,
        transform: "translateX(-50%)",
        pointerEvents: "none",
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-canvas-agent-affordance={target.shapeId}
        aria-haspopup="menu"
        aria-expanded={state !== "closed"}
        disabled={pendingShapeId !== null}
        onClick={() => dispatch({ type: "button-click" })}
        style={{ pointerEvents: "auto" }}
        className="whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
      >
        {pendingShapeId === target.shapeId ? "Starting\u2026" : "Agent \u25be"}
      </button>

      {state !== "arms" ? null : (
        <div
          role="menu"
          data-canvas-agent-arms={target.shapeId}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "auto",
          }}
          className={armsMenuClassName}
        >
          {arms.map((arm) => (
            <button
              key={arm.id}
              type="button"
              role="menuitem"
              data-canvas-agent-arm={arm.id}
              disabled={!arm.enabled}
              // Disabled-not-hidden needs to say WHY, or a greyed row is just
              // a broken one. Only the launch arm can be disabled.
              title={arm.enabled ? undefined : "Only a note carries a prompt to run."}
              onClick={() => {
                dispatch({ type: "arm", id: arm.id });
                if (arm.id === "launch") onRun(target.shapeId);
              }}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:hover:bg-transparent"
            >
              {arm.label}
            </button>
          ))}
        </div>
      )}

      {picker}
    </div>
  );
}

interface AgentBadgeProps {
  readonly link: CanvasAgentLink;
  readonly box: ScreenBox;
  readonly onOpen: (threadId: string) => void;
  readonly onUnlink: (shapeId: string) => void;
}

/**
 * One note's status badge and the little menu behind it.
 *
 * WHY A MENU RATHER THAN A DIRECT OPEN. The badge used to open the thread on a
 * plain click, which left "this note's agent is finished with, get the dot off
 * it" with nowhere to live: the link is bb state, not canvas state, so deleting
 * the note is not the answer and neither is anything in the canvas tool bar.
 * A badge now has two things to say — which thread this is, and the two things
 * you can do about it — so it opens a menu whose FIRST item is the open it used
 * to do directly.
 *
 * Hand-rolled rather than a Radix Popover: this layer is a `pointer-events:
 * none` sheet over the canvas whose children are positioned by `screenBoxFor`
 * on every camera frame, and a portalled popover with its own positioning would
 * have to be re-anchored against that same transform anyway — at which point it
 * is a div with a dismiss handler, which is what this is.
 */
function AgentBadge({
  link,
  box,
  onOpen,
  onUnlink,
}: AgentBadgeProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target) === true) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    // `pointerdown`, not `click`: the canvas begins a gesture on pointerdown,
    // so a menu still on screen at that moment is a menu overlapping a drag
    // that has already started.
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div
      ref={rootRef}
      // Straddles the note's top-right corner, the one place a badge does not
      // cover the text a user is reading. The wrapper carries the position so
      // the menu is anchored to the badge rather than to the viewport, and
      // therefore travels with the note under pan and zoom like everything
      // else in this layer.
      style={{
        position: "absolute",
        left: box.right,
        top: box.top,
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
      }}
    >
      <button
        type="button"
        data-canvas-agent-badge={link.shapeId}
        data-canvas-agent-status={link.status}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`${STATUS_LABEL[link.status]} — thread actions`}
        aria-label={`${STATUS_LABEL[link.status]} for this note — thread actions`}
        onClick={() => setMenuOpen((previous) => !previous)}
        style={{ pointerEvents: "auto" }}
        className={
          menuOpen
            ? "flex size-5 items-center justify-center rounded-full border border-primary bg-card shadow-sm"
            : "flex size-5 items-center justify-center rounded-full border border-border bg-card shadow-sm hover:border-primary"
        }
      >
        <span aria-hidden className={`size-2 rounded-full ${STATUS_DOT[link.status]}`} />
      </button>

      {!menuOpen ? null : (
        <div
          role="menu"
          data-canvas-agent-menu={link.shapeId}
          // Hung below-left of the badge, which sits on the note's top-RIGHT
          // corner: opening rightwards would put the menu off the note and,
          // for a note near the edge, off the viewport.
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            pointerEvents: "auto",
          }}
          className="w-52 rounded-md border border-border bg-card p-1 text-xs shadow-md"
        >
          <div className="px-2 py-1.5 text-muted-foreground">
            <div className="font-medium text-foreground">
              {STATUS_LABEL[link.status]}
            </div>
            <div className="truncate font-mono" title={link.threadId}>
              {link.threadId}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            data-canvas-agent-open={link.shapeId}
            onClick={() => {
              setMenuOpen(false);
              onOpen(link.threadId);
            }}
            className="block w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Open thread
          </button>
          <button
            type="button"
            role="menuitem"
            data-canvas-agent-unlink={link.shapeId}
            // Says what it does NOT do, because "unlink" next to a thread is
            // one misread away from "delete my conversation".
            title="Remove this badge. The thread keeps its history in bb."
            onClick={() => {
              setMenuOpen(false);
              onUnlink(link.shapeId);
            }}
            className="block w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Unlink thread
          </button>
        </div>
      )}
    </div>
  );
}
