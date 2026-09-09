// W4's TWO GESTURES, as chrome over the canvas: "Add a goal" and "Add a
// blocker under this node".
//
// WHERE THIS SITS, AND WHY IT IS THE SAME PLACE `AgentLayer` SITS. An
// absolutely-positioned div over the drawing surface, `pointer-events: none`
// on the layer and `auto` on the controls, a LATER DOM SIBLING than
// <Viewport> (its documented stacking contract — no z-index needed), with
// everything anchored by `screenBoxFor`: `worldBounds(doc, shape)` ->
// `worldToScreen(camera, corner)`. That is agents-ui.tsx's posture verbatim,
// and the reasons carry over unchanged — the affordance is bb chrome, not a
// canvas shape; it must not steal a gesture from the canvas underneath; and it
// tracks its node through pan, zoom, drag and remote edits without
// subscribing to anything, because it re-derives from the same `snapshot` and
// `camera` the shapes render from.
//
// The one difference from AgentLayer: the GOAL control is not anchored to a
// shape at all. A goal has no parent and no subject, so it is pinned to the
// drawing surface's top-left corner — clear of the tool dock (bottom centre)
// and of the agent badges (shape corners).
//
// HANDS ONLY. Which shape a gesture acts on, whether the arm is enabled, what
// a disabled arm says, whether a typed title is worth sending and which
// composer is open are all canvas/tree/gestures.ts, tested without a DOM. This
// file is paint and hands, which is the only shape a component can have in a
// project with no jsdom (canvas/agent-arms.ts's header states the rule).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Camera } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { screenBoxFor } from "../agents-view.js";
import {
  CHROME_FIELD,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_MUTED,
  CHROME_PAPER,
  CHROME_POPOVER_SHADOW,
} from "../pages/chrome-dock.js";
import {
  discussArmFor,
  type ComposerDestination,
} from "../tree/discuss.js";
import {
  MAX_GESTURE_TITLE,
  blockerArmFor,
  nextTreeComposer,
  treeGestureTargetFor,
  treeTitleSubmission,
  type TreeComposerEvent,
  type TreeComposerState,
} from "../tree/gestures.js";

export interface TreeGestureLayerProps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  /** The editor's live selection. A single tree node in it gets the blocker
   * arm; anything else gets it greyed, with the reason. */
  readonly selection: ReadonlySet<string>;
  /** The page the human is looking at — the treeId a new goal lands on, and
   * the page a node's chrome must be suppressed on when it is not this one
   * (agents-view.ts's `currentPageId` note). */
  readonly currentPageId: string;
  /** Which gesture's write is in flight, if any. */
  readonly pending: "goal" | "blocker" | null;
  readonly onAddGoal: (treeId: string, title: string) => void;
  readonly onAddBlocker: (parentId: string, title: string) => void;
  /** W8: where a node reference would land, or the reason there is nowhere —
   * the arm is greyed with it, never hidden. */
  readonly discussDestination: ComposerDestination;
  /** W8: put a reference to this node in that composer. */
  readonly onDiscuss: (treeId: string, nodeId: string) => void;
}

const GAP_PX = 8;

const buttonStyle = (enabled: boolean): CSSProperties => ({
  pointerEvents: "auto",
  padding: "4px 8px",
  borderRadius: 6,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: enabled ? CHROME_INK : CHROME_MUTED,
  font: CHROME_FONT,
  cursor: enabled ? "pointer" : "default",
  boxShadow: CHROME_POPOVER_SHADOW,
});

const composerStyle: CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  gap: 4,
  marginTop: 4,
  padding: 6,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
  // In-layer rather than portalled, like the arms menu in agents-ui.tsx: it is
  // a short field anchored to a control this layer already positions on every
  // camera frame.
  width: 260,
};

const fieldStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: 4,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_FIELD,
  color: CHROME_INK,
  font: CHROME_FONT,
};

export function TreeGestureLayer({
  doc,
  camera,
  viewportSize,
  selection,
  currentPageId,
  pending,
  onAddGoal,
  onAddBlocker,
  discussDestination,
  onDiscuss,
}: TreeGestureLayerProps): ReactNode {
  const target = treeGestureTargetFor({
    selection,
    shapeOf: (shapeId) => doc.byId.get(shapeId),
  });
  const targetBox =
    target === null
      ? null
      : screenBoxFor(doc, camera, viewportSize, target.shapeId, currentPageId);

  const [composer, setComposer] = useState<TreeComposerState>("closed");
  const [title, setTitle] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dispatch = useCallback((event: TreeComposerEvent) => {
    setComposer((previous) => nextTreeComposer(previous, event));
  }, []);

  // THE ANCHOR MOVING IS AN EVENT, not a remount — agent-menu.ts's call, and
  // the same reason: keying this on the shape id would close the composer by
  // throwing the subtree away, making "what happens when the selection moves"
  // a fact about React's reconciler rather than a rule a test can drive.
  const anchorId = target?.shapeId ?? null;
  useEffect(() => {
    dispatch({ type: "target-changed" });
  }, [anchorId, dispatch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "escape" });
    };
    const onPointerDown = (event: PointerEvent) => {
      dispatch({
        type: "pointerdown",
        insideWidget: rootRef.current?.contains(event.target as Node) === true,
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [dispatch]);

  const submit = useCallback(() => {
    const verdict = treeTitleSubmission(title);
    // Refused titles simply do not send. The field keeps what was typed and
    // the disabled button is the explanation — a toast for "you have not
    // typed anything yet" would be nagging, not news.
    if (!verdict.ok) return;
    if (composer === "goal") onAddGoal(currentPageId, verdict.title);
    else if (target?.treeId !== null && target !== null) {
      onAddBlocker(target.shapeId, verdict.title);
    }
    setTitle("");
    dispatch({ type: "submitted" });
  }, [composer, currentPageId, dispatch, onAddBlocker, onAddGoal, target, title]);

  const arm = target === null ? null : blockerArmFor(target);
  const discussArm = discussArmFor(target, discussDestination);
  const sendable = treeTitleSubmission(title).ok;

  return (
    <div
      ref={rootRef}
      data-canvas-layer="tree-gestures"
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      <div style={{ position: "absolute", left: GAP_PX, top: GAP_PX }}>
        <button
          type="button"
          data-tree-gesture="add-goal"
          disabled={pending !== null}
          onClick={() => dispatch({ type: "open", gesture: "add-goal" })}
          style={buttonStyle(pending === null)}
        >
          {pending === "goal" ? "Adding a goal…" : "Add a goal"}
        </button>
        {composer !== "goal" ? null : (
          <Composer
            placeholder="What is the goal?"
            title={title}
            sendable={sendable}
            onChange={setTitle}
            onSubmit={submit}
            onCancel={() => dispatch({ type: "escape" })}
          />
        )}
      </div>

      {target === null || targetBox === null || arm === null ? null : (
        <div
          style={{
            position: "absolute",
            // The BOTTOM-left corner of the node: the top-right one already
            // carries the agent badge, and a control that covered it would
            // hide a link the human put there.
            left: targetBox.left,
            top: targetBox.bottom + GAP_PX,
          }}
        >
          <button
            type="button"
            data-tree-gesture="add-blocker"
            disabled={!arm.enabled || pending !== null}
            title={arm.enabled ? undefined : arm.reason}
            onClick={() => dispatch({ type: "open", gesture: "add-blocker" })}
            style={buttonStyle(arm.enabled && pending === null)}
          >
            {pending === "blocker" ? "Adding a blocker…" : arm.label}
          </button>
          {discussArm === null ? null : (
            <button
              type="button"
              data-tree-discuss="node"
              disabled={!discussArm.enabled}
              title={discussArm.enabled ? undefined : discussArm.reason}
              onClick={() => {
                // Guarded by `target.treeId` rather than by the arm alone, so
                // the call site cannot pass a null tree id even if the arm's
                // rule and this button ever drift apart.
                if (target.treeId !== null) onDiscuss(target.treeId, target.shapeId);
              }}
              style={{ ...buttonStyle(discussArm.enabled), marginLeft: 4 }}
            >
              {discussArm.label}
            </button>
          )}
          {composer !== "blocker" ? null : (
            <Composer
              placeholder="What blocks this?"
              title={title}
              sendable={sendable}
              onChange={setTitle}
              onSubmit={submit}
              onCancel={() => dispatch({ type: "escape" })}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  readonly placeholder: string;
  readonly title: string;
  readonly sendable: boolean;
  readonly onChange: (title: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

/** The one field both gestures use. `autoFocus` because the composer only
 * exists in response to a press that asked for it, and Enter submits because
 * the field holds one short line. */
function Composer({ placeholder, title, sendable, onChange, onSubmit, onCancel }: ComposerProps) {
  return (
    <div style={composerStyle}>
      <input
        autoFocus
        value={title}
        placeholder={placeholder}
        maxLength={MAX_GESTURE_TITLE}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onCancel();
          // The canvas listens for Delete/Backspace and every tool key on the
          // window; a keystroke meant for this field must not also be a canvas
          // gesture.
          event.stopPropagation();
        }}
        style={fieldStyle}
      />
      <button
        type="button"
        data-tree-gesture="submit"
        disabled={!sendable}
        onClick={onSubmit}
        style={buttonStyle(sendable)}
      >
        Add
      </button>
    </div>
  );
}
