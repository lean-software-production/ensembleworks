// The tool-switching model + the abandonment-cancel policy, kept DOM-free so
// the React mount stays a thin adapter. A trimmed port of the EnsembleWorks
// client's own canvas-v2 tool loop: this spike ships only select/hand plus the
// four create kinds (note/frame/text/geo) — no arrow, draw, or line — because
// those are what T2 needs and every extra tool is another FSM to cancel.
//
// 'select' is special: canvas-editor ships select and transform as two
// independent FSMs (select owns click/drag/marquee selection; transform owns
// the resize/rotate handles and never touches the selection itself). What a
// user means by "the select tool" is the union, which canvas-editor already
// packages as `createSelectAndTransformTool`. There is deliberately no
// toolbar button for transform — it is reachable only through the composite.
import type { Editor, Intent, Tool, ToolContext } from "@ensembleworks/canvas-editor";
import {
  createCreateTool,
  createHandTool,
  createSelectAndTransformTool,
  type CreateKind,
  type CreateState,
  type HandState,
  type SelectAndTransformState,
} from "@ensembleworks/canvas-editor";

export type ToolId = "select" | "hand" | "note" | "frame" | "text" | "geo";

/** One Tool instance per ToolId, built ONCE per ToolContext (every tool
 * factory documents that contract for itself). */
export interface ToolSet {
  readonly select: Tool<SelectAndTransformState>;
  readonly hand: Tool<HandState>;
  readonly note: Tool<CreateState>;
  readonly frame: Tool<CreateState>;
  readonly text: Tool<CreateState>;
  readonly geo: Tool<CreateState>;
}

export function createToolSet(ctx: ToolContext): ToolSet {
  const create = (kind: CreateKind) => createCreateTool(ctx, kind);
  return {
    select: createSelectAndTransformTool(ctx),
    hand: createHandTool(ctx),
    note: create("note"),
    frame: create("frame"),
    text: create("text"),
    geo: create("geo"),
  };
}

/** Per-tool current state, held outside any single tool's closure so switching
 * away and back preserves whatever each tool was left in. */
export type ToolStates = { [K in ToolId]: unknown };

export function createInitialToolStates(tools: ToolSet): ToolStates {
  return {
    select: tools.select.initialState,
    hand: tools.hand.initialState,
    note: tools.note.initialState,
    frame: tools.frame.initialState,
    text: tools.text.initialState,
    geo: tools.geo.initialState,
  };
}

/** Dispatch one InputEvent to the active tool, apply its intents, and return
 * the updated state map (fresh object; `states` is never mutated). */
export function dispatchToActiveTool(
  tools: ToolSet,
  states: ToolStates,
  active: ToolId,
  editor: Editor,
  event: Parameters<Tool<unknown>["onEvent"]>[1],
): ToolStates {
  const tool = tools[active] as Tool<unknown>;
  const result = tool.onEvent(states[active], event);
  if (result.intents.length > 0) editor.applyAll(result.intents);
  return { ...states, [active]: result.state };
}

/** The Delete/Backspace path. Reads the live selection (a keyboard delete is
 * not a tool gesture, so it never routes through dispatchToActiveTool) and
 * clears the selection afterwards — DeleteShapes deliberately does not do that
 * itself. An empty selection returns [] rather than a no-op pair. */
export function deleteSelectionIntents(editor: Editor): Intent[] {
  const ids = [...editor.get().selection];
  if (ids.length === 0) return [];
  return [
    { type: "DeleteShapes", ids },
    { type: "SetSelection", ids: [] },
  ];
}

/** SetSelection is a view intent with no inverse, so an undo that removes the
 * shapes a previous batch selected leaves the selection naming ids that no
 * longer resolve. Drop those. Emits nothing when nothing dangled — a same-value
 * SetSelection still notifies subscribers. */
export function pruneDanglingSelectionIntents(editor: Editor): Intent[] {
  const current = [...editor.get().selection];
  const pruned = current.filter((id) => editor.doc.getShape(id) !== undefined);
  if (pruned.length === current.length) return [];
  return [{ type: "SetSelection", ids: pruned }];
}

/**
 * The abandonment-gap cancel policy. Both create and transform commit to the
 * doc on every pointermove, so a gesture that never reaches pointerup — tool
 * switched mid-drag, viewport blurred, pointercancel, Escape — must be cleaned
 * up explicitly or it leaves a half-made shape visible to every peer.
 *
 * Coverage, per tool:
 *  - note/frame/text/geo ('dragging'): the preview shape already exists in the
 *    doc, so delete it.
 *  - select's transform leg ('resizing'/'rotating'): carries `startShapes`, a
 *    verbatim snapshot taken at gesture start; replaying each back through
 *    CreateShape (an upsert) restores it regardless of how many incremental
 *    commits happened since. Tolerant: an id the live doc no longer resolves is
 *    skipped rather than resurrected.
 *  - select's own FSM and hand: never create or mutate a shape. Reset only.
 *
 * Returns the FULL reset state map — an abandonment means the viewport lost its
 * input context, not just one tool.
 */
export function cancelActiveTool(
  tools: ToolSet,
  states: ToolStates,
  active: ToolId,
  editor: Editor,
): { states: ToolStates; intents: Intent[] } {
  const intents: Intent[] = [];

  if (active === "note" || active === "frame" || active === "text" || active === "geo") {
    const state = states[active] as CreateState;
    if (state.mode === "dragging") {
      intents.push({ type: "DeleteShapes", ids: [state.id] });
    }
  } else if (active === "select") {
    const transform = (states.select as SelectAndTransformState).transform;
    if (transform.mode === "resizing" || transform.mode === "rotating") {
      for (const shape of transform.startShapes) {
        if (editor.doc.getShape(shape.id)) intents.push({ type: "CreateShape", shape });
      }
    }
  }

  return { states: createInitialToolStates(tools), intents };
}
