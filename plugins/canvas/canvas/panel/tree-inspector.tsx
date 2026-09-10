// W18's INSPECTOR: a node's state, whether it has been approached, and its
// context note — visible to the human who drew the tree, and editable by them.
//
// WHERE THIS SITS, AND WHY IT IS **NOT** ANCHORED CHROME. Every other piece of
// tree chrome in this plugin hangs off the node it is about (AgentLayer,
// TreeGestureLayer, the quarantine marker), and this one deliberately does
// not: it is a fixed column down the right-hand side of the canvas route.
// Three reasons, in the order they decided it:
//
//  1. A CONTEXT NOTE IS UP TO 8000 CHARACTERS (`MAX_CONTEXT_LENGTH`). An
//     anchored popover big enough to read and edit that would cover most of
//     the tree it is anchored in — and the tree is the thing the human is
//     reading the note against.
//  2. AN ANCHORED EDITOR MOVES WHILE YOU TYPE. The anchor is the node's screen
//     box, which changes on every pan, zoom and drag, including drags of the
//     node itself and remote edits by other people. A text field that walks
//     out from under the cursor mid-sentence is not an editor.
//  3. THE CANVAS STAYS VISIBLE. A column takes width from the drawing surface
//     rather than covering it, so the tree — and the state marks W18 puts on
//     every node — can still be read while the note is open.
//
// The COMPACT half of this node is the anchored one: `TreeStateLayer` draws
// state on every node, so "what is done" is answerable by looking, and this
// panel is for the long-form field that a mark cannot carry.
//
// HANDS ONLY, the rule canvas/agent-arms.ts states: what is being inspected,
// what the controls say, whether a save is worth sending, and every case of
// "the document moved under an open editor" are canvas/tree/inspector.ts,
// tested without a DOM.
import { useEffect, useReducer, type CSSProperties } from "react";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { LiveText } from "../shape-text.js";
import {
  CHROME_ACCENT,
  CHROME_FAINT,
  CHROME_FIELD,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_PAPER,
} from "../pages/chrome-dock.js";
import type { NodeState } from "../tree/encoding.js";
import { treeGestureTargetFor } from "../tree/gestures.js";
import {
  NO_CONTEXT_EDITOR,
  approachedArmFor,
  conflictNoticeFor,
  inspectorSubjectFor,
  nextContextEditor,
  saveArmFor,
  stateArmsFor,
  subjectFor,
  waitingNoticeFor,
  type ContextEditor,
  type ContextEditorEvent,
} from "../tree/inspector.js";
import type { InspectorEdit } from "./tree-inspector-sync.js";

export interface TreeInspectorProps {
  readonly doc: CanvasDocument;
  readonly selection: ReadonlySet<string>;
  readonly textOf: LiveText;
  readonly pending: InspectorEdit | null;
  readonly onSetState: (nodeId: string, state: NodeState) => void;
  readonly onSetApproached: (nodeId: string, approached: boolean) => void;
  readonly onWriteContext: (
    nodeId: string,
    context: string,
    expected: string,
  ) => Promise<boolean>;
}

const COLUMN_WIDTH = 320;

const columnStyle: CSSProperties = {
  width: COLUMN_WIDTH,
  flex: `0 0 ${COLUMN_WIDTH}px`,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  overflowY: "auto",
  borderLeft: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
};

const buttonStyle = (enabled: boolean, on = false): CSSProperties => ({
  padding: "4px 8px",
  borderRadius: 6,
  border: `1px solid ${on ? CHROME_ACCENT : CHROME_HAIRLINE}`,
  background: on ? CHROME_FAINT : CHROME_FIELD,
  color: CHROME_INK,
  font: CHROME_FONT,
  cursor: enabled ? "pointer" : "default",
});

const noticeStyle: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: `1px solid ${CHROME_ACCENT}`,
  background: CHROME_FIELD,
};

export function TreeInspector({
  doc,
  selection,
  textOf,
  pending,
  onSetState,
  onSetApproached,
  onWriteContext,
}: TreeInspectorProps) {
  const target = treeGestureTargetFor({ selection, shapeOf: (id) => doc.byId.get(id) });
  const selected = inspectorSubjectFor({ target, shapeOf: (id) => doc.byId.get(id), textOf });
  const [editor, dispatch] = useReducer(
    (state: ContextEditor, event: ContextEditorEvent) => nextContextEditor(state, event),
    NO_CONTEXT_EDITOR,
  );

  // WHAT THE DOCUMENT SAYS, EVERY RENDER — one event, not two. A selection
  // change and a peer's rewrite are the same fact from here ("the node and
  // note in front of this human are now X"), and `nextContextEditor` is what
  // tells them apart. Sending two events would put that rule in this file,
  // where no test can drive it.
  const subjectId = selected?.nodeId ?? null;
  const subjectContext = selected?.context ?? "";
  useEffect(() => {
    dispatch({ type: "subject", nodeId: subjectId, context: subjectContext });
  }, [subjectId, subjectContext]);

  // The node being EDITED, which is not always the node SELECTED: a dirty
  // draft holds the panel on its own node until the human resolves it, so the
  // controls always act on the note that is on screen.
  const heldId = editor.waiting !== null ? editor.nodeId : null;
  const shown =
    heldId !== null ? subjectFor(heldId, (id) => doc.byId.get(id), textOf) : selected;

  // NOTHING TO INSPECT, NOTHING DRAWN. The column is not a permanent fixture
  // that shrinks the canvas to say "select a node", and the sentence for a
  // shape that is not a tree node is already on W4's greyed arm, anchored to
  // that very shape — see inspector.ts's `subjectFor`.
  if (shown === null) return null;

  const save = saveArmFor(editor);
  const conflict = conflictNoticeFor(editor);
  const waiting = waitingNoticeFor(editor);
  const approached = approachedArmFor(shown);

  return (
    <aside data-canvas-tree-inspector={shown.nodeId} style={columnStyle}>
      <div style={{ fontWeight: 600 }} data-tree-inspector-title>
        {shown.title === "" ? "(untitled)" : shown.title}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        {stateArmsFor(shown).map((arm) => (
          <button
            key={arm.state}
            type="button"
            data-tree-inspector-state={arm.state}
            aria-pressed={arm.selected}
            disabled={pending !== null}
            onClick={() => onSetState(shown.nodeId, arm.state)}
            style={buttonStyle(pending === null, arm.selected)}
          >
            {arm.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-tree-inspector-approached={approached.pressed ? "yes" : "no"}
        aria-pressed={approached.pressed}
        title={approached.hint}
        disabled={pending !== null}
        onClick={() => onSetApproached(shown.nodeId, !approached.pressed)}
        style={buttonStyle(pending === null, approached.pressed)}
      >
        {approached.label}
      </button>

      {waiting === null ? null : (
        <div role="status" data-tree-inspector-waiting style={noticeStyle}>
          {waiting}
        </div>
      )}
      {conflict === null ? null : (
        <div role="alert" data-tree-inspector-conflict style={noticeStyle}>
          <div>{conflict}</div>
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            <button
              type="button"
              data-tree-inspector-keep="mine"
              onClick={() => dispatch({ type: "keep-mine" })}
              style={buttonStyle(true)}
            >
              Keep mine
            </button>
            <button
              type="button"
              data-tree-inspector-keep="theirs"
              onClick={() => dispatch({ type: "take-theirs" })}
              style={buttonStyle(true)}
            >
              Take theirs
            </button>
          </div>
        </div>
      )}

      <textarea
        data-tree-inspector-context
        value={editor.draft}
        placeholder="What is this work for? What is done? What is known, and what is not?"
        onChange={(event) => dispatch({ type: "typed", draft: event.target.value })}
        onKeyDown={(event) => {
          // The canvas listens for Delete/Backspace and every tool key on the
          // window; a keystroke meant for this field must not also be a canvas
          // gesture (W4's composer learned the same thing).
          event.stopPropagation();
        }}
        rows={14}
        style={{
          resize: "vertical",
          padding: 6,
          borderRadius: 6,
          border: `1px solid ${CHROME_HAIRLINE}`,
          background: CHROME_FIELD,
          color: CHROME_INK,
          font: CHROME_FONT,
        }}
      />

      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          type="button"
          data-tree-inspector-save
          disabled={!save.enabled || pending !== null}
          title={save.enabled ? undefined : save.reason}
          onClick={() => {
            const nodeId = editor.nodeId;
            if (nodeId === null) return;
            const context = editor.draft;
            void onWriteContext(nodeId, context, editor.base).then((landed) => {
              // ONLY on a landed write. A refused save (`stale-write`) must
              // leave the draft exactly where it is — adopting it here would
              // tell the human their note was stored when it was not.
              if (landed) dispatch({ type: "saved", context });
            });
          }}
          style={buttonStyle(save.enabled && pending === null)}
        >
          {pending === "context" ? "Saving…" : save.label}
        </button>
        <button
          type="button"
          data-tree-inspector-discard
          disabled={editor.draft === editor.base}
          onClick={() => dispatch({ type: "discarded" })}
          style={buttonStyle(editor.draft !== editor.base)}
        >
          Discard
        </button>
      </div>
    </aside>
  );
}
