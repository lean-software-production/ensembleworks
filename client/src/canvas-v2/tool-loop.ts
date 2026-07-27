/**
 * The v1 tool-switching model + the abandonment-cancel policy — pulled out
 * of CanvasV2App.tsx so both are plain, DOM-free, house-testable functions
 * (script.ts's `run()`-style dispatch semantics, applied by hand here since
 * CanvasV2App drives a LIVE event stream rather than a pre-built array).
 *
 * TOOL-SWITCHING MODEL (decided here, v1 — documented rather than left
 * implicit): one `ToolId` is "active" at a time, chosen by the toolbar.
 * Every tool OTHER than 'select' just gets every InputEvent handed straight
 * to its own Tool<S> instance — hand/note/text/geo/frame/arrow all already
 * encapsulate their own complete FSM.
 *
 * 'select' is special: canvas-editor ships `select` and `transform` as TWO
 * INDEPENDENT tool FSMs (tools/select.ts, tools/transform.ts) — transform
 * operates on the EXISTING selection and never touches it itself (its own
 * module header: "a pointerdown that misses every handle is a no-op here").
 * tldraw's product behavior a dogfood user expects from "the select tool" is
 * really the UNION of both: click/drag/marquee-select (select.ts) AND
 * drag a resize/rotate handle when something is already selected
 * (transform.ts). The select+transform composite now lives in canvas-editor
 * (`tools/select-and-transform.ts`) and is re-exported below for the
 * client's existing importers.
 *
 * No V1 SUPPORT for switching TO the transform tool explicitly via a toolbar
 * button (there is no such button — see CanvasV2App.tsx's toolbar) — it is
 * reachable ONLY through the select composite, matching tldraw's own product
 * (there is no "transform tool" button there either; handles just appear on
 * a selection made via the select tool).
 */
import type { Editor, Intent, Tool, ToolContext } from '@ensembleworks/canvas-editor'
import {
	createArrowTool,
	createCreateTool,
	createDrawTool,
	createHandTool,
	createLineTool,
	createSelectAndTransformTool,
	type ArrowState,
	type CreateKind,
	type CreateState,
	type DrawState,
	type HandState,
	type LineState,
	type SelectAndTransformState,
	type SelectState,
} from '@ensembleworks/canvas-editor'
import type { SnapResult } from '@ensembleworks/canvas-model'

export { createSelectAndTransformTool, type SelectAndTransformState } from '@ensembleworks/canvas-editor'

/** The toolbar's tool identifiers — see CanvasV2App.tsx's toolbar for the
 * button list. 'transform' is deliberately ABSENT (see module header). */
export type ToolId = 'select' | 'hand' | 'note' | 'text' | 'geo' | 'frame' | 'arrow' | 'draw' | 'line'

/** One `Tool<unknown>` instance per `ToolId`, built ONCE per `ToolContext` —
 * mirrors every tool factory's own "call once per Editor/ToolContext"
 * contract (tool-context.ts's own doc comment says the same about itself).
 * `unknown` state (not a discriminated union across all seven) because the
 * caller (CanvasV2App) only ever looks up ONE tool by the currently-active
 * `ToolId` and threads that specific tool's own state through — see
 * `ToolLoop` below. */
export interface ToolSet {
	readonly select: Tool<SelectAndTransformState>
	readonly hand: Tool<HandState>
	readonly note: Tool<CreateState>
	readonly text: Tool<CreateState>
	readonly geo: Tool<CreateState>
	readonly frame: Tool<CreateState>
	readonly arrow: Tool<ArrowState>
	readonly draw: Tool<DrawState>
	readonly line: Tool<LineState>
}

export function createToolSet(ctx: ToolContext): ToolSet {
	const createKindTool = (kind: CreateKind) => createCreateTool(ctx, kind)
	return {
		select: createSelectAndTransformTool(ctx),
		hand: createHandTool(ctx),
		note: createKindTool('note'),
		text: createKindTool('text'),
		geo: createKindTool('geo'),
		frame: createKindTool('frame'),
		arrow: createArrowTool(ctx),
		draw: createDrawTool(ctx),
		line: createLineTool(ctx),
	}
}

/** A `{ [id]: currentState }` map, one entry per `ToolId`, all starting at
 * their tool's own `initialState`. Kept OUTSIDE any single tool's closure so
 * switching the active tool and switching back preserves whatever
 * mid-gesture-or-not state each tool was left in (in practice always idle
 * after `cancelActiveTool` runs — see below — but this map is what makes
 * "preserve" even possible in principle). */
export type ToolStates = { [K in ToolId]: unknown }

export function createInitialToolStates(tools: ToolSet): ToolStates {
	return {
		select: tools.select.initialState,
		hand: tools.hand.initialState,
		note: tools.note.initialState,
		text: tools.text.initialState,
		geo: tools.geo.initialState,
		frame: tools.frame.initialState,
		arrow: tools.arrow.initialState,
		draw: tools.draw.initialState,
		line: tools.line.initialState,
	}
}

/** Dispatch one InputEvent to the CURRENTLY ACTIVE tool, apply its intents
 * via `editor.applyAll` (script.ts's `run()`-per-event granularity — one
 * commit/notify per event, never per gesture), and return the updated
 * per-tool state map (a fresh object; `states` itself is never mutated). */
/**
 * The select tool's current SnapResult, if any — the accessor that finally
 * makes canvas-react's Overlay.tsx `snapResult` prop non-`undefined` (see
 * that module's "PRODUCER DOES NOT EXIST YET" note, now stale — canvas-
 * editor's select tool (tools/select.ts, Unit 13) computes and carries a
 * SnapResult on its 'dragging' state; this is the one place that state gets
 * read back out for the renderer). Returns undefined whenever there is
 * nothing to show: the active tool isn't 'select', the select composite's
 * active leg is 'transform' (not select's own FSM), or select's own FSM
 * isn't currently in 'dragging' (no drag in flight, or a drag that hasn't
 * computed its first snap yet — select.ts's Dragging.snapResult starts
 * `null` until the first move commits one).
 */
export function currentSnapResult(toolStates: ToolStates, active: ToolId): SnapResult | undefined {
	if (active !== 'select') return undefined
	const composite = toolStates.select as SelectAndTransformState
	if (composite.active !== 'select') return undefined
	const selectState = composite.select as SelectState
	if (selectState.mode !== 'dragging') return undefined
	return selectState.snapResult ?? undefined
}

export function dispatchToActiveTool(
	tools: ToolSet,
	states: ToolStates,
	active: ToolId,
	editor: Editor,
	event: Parameters<Tool<unknown>['onEvent']>[1],
): ToolStates {
	const tool = tools[active] as Tool<unknown>
	const result = tool.onEvent(states[active], event)
	if (result.intents.length > 0) editor.applyAll(result.intents)
	return { ...states, [active]: result.state }
}

/**
 * The abandonment-gap cancel policy (canvas-editor's tools/arrow.ts +
 * tools/create.ts both document the same gap: once a drag threshold is
 * crossed, the in-flight PREVIEW shape is committed to the doc on every
 * pointermove, so a gesture that never reaches pointerup — tool switched
 * mid-drag, the viewport loses focus, the component unmounts — leaves that
 * preview shape permanently visible to every peer unless something deletes
 * it). This package (canvas-editor) explicitly leaves that cancel wiring to
 * "the Seam D/G3 wiring that owns those lifecycle events" — this function
 * IS that wiring's policy half (CanvasV2App.tsx calls it from
 * `onViewportBlur` AND from the toolbar's tool-switch handler, both of which
 * abandon whatever gesture was in flight on the tool being left).
 *
 * COVERAGE, STATED HONESTLY PER TOOL (not every tool's in-flight state
 * carries a shape id to delete):
 *  - arrow ('drawing' state): carries `id` — the arrow shape already exists
 *    in the doc mid-draw. COVERED: emits DeleteShapes([id]).
 *  - note/text/geo/frame create ('dragging' state): carries `id` — the
 *    drag-to-size preview shape already exists in the doc. COVERED: emits
 *    DeleteShapes([id]).
 *  - select ('dragging'/'marquee'/'pointing' states): NEVER creates a shape
 *    (translate moves EXISTING shapes; marquee only selects) — nothing to
 *    delete. Reset to idle only.
 *  - hand ('pointing'/'panning' states): never creates a shape (pans the
 *    camera). Reset to idle only.
 *  - transform ('resizing'/'rotating' states, reached only via the select
 *    composite): never creates a shape (resizes/rotates EXISTING shapes IN
 *    PLACE, already committed incrementally by the time cancel runs — see
 *    transform.ts's COMMIT CADENCE note) — but DOES emit a revert (Task B5).
 *    transform.ts's Resizing/Rotating states carry `startShapes`: a verbatim
 *    snapshot of every affected shape taken at GESTURE START (the first
 *    threshold-crossing move, before its own first Resize/RotateShapes
 *    intent — see transform.ts's captureStartShapes). Cancelling mid-gesture
 *    replays each snapshot back via CreateShape ("upsert full shape
 *    verbatim", editor.ts's applyOne) — one intent per shape, which restores
 *    it exactly regardless of how many incremental Resize/RotateShapes
 *    commits happened since gesture start; no need to count or unwind them
 *    individually. TOLERANT: a shape that vanished mid-gesture (e.g. a
 *    concurrent remote delete) is dropped from the revert, never
 *    resurrected — checked against the LIVE doc at cancel time, not the
 *    snapshot itself. NOTE (carried finding, not this unit's scope): the
 *    incremental per-move commits PLUS this revert still leave a messy undo
 *    history behind (the revert doesn't retroactively erase those commits'
 *    own undo entries) — gesture-atomic undo (one undo step per whole drag)
 *    remains a documented Phase-4 parity item.
 *    SECOND carried finding (over-revert): CreateShape restores the FULL
 *    gesture-start shape (a whole-shape putShape overwrite), not a
 *    geometry-only inverse — so a concurrent REMOTE edit to a NON-geometry
 *    field (color/opacity/isLocked/meta/parentId/frame name) of a shape
 *    being transformed-then-cancelled is stomped back to its gesture-start
 *    value. This is the SAME whole-shape-overwrite convention B1's undo
 *    inverses use (fixing only cancel would make cancel/undo inconsistent);
 *    text is safe (a separate Loro container). Deferred to the undo-quality /
 *    gesture-atomic-undo family — see the plan's carried-finding B5 bullet.
 *
 * Returns the full RESET `ToolStates` (every tool goes back to its own
 * `initialState` — not just the active one — since an abandonment trigger
 * means the whole viewport lost its input context, not just one tool) plus
 * whatever cleanup Intents the active tool's in-flight state demands.
 */
/**
 * The user emitter for `DeleteShapes` (Task B2) — until now the ONLY emitter
 * was `cancelActiveTool`'s abandonment-gap cleanup above, and that always
 * targets an in-flight PREVIEW shape a tool is mid-creating, never a user's
 * standing selection. This is the "press Delete/Backspace" path: reads
 * `editor.get().selection` directly (there is no tool gesture involved — a
 * keyboard delete isn't a tool FSM's concern, so it doesn't route through
 * `dispatchToActiveTool` at all) and, for a non-empty selection, emits
 * `DeleteShapes` for every selected id followed by `SetSelection([])` so the
 * selection doesn't keep referencing ids that no longer resolve (mirrors
 * DeleteShapes's own doc comment: it does NOT implicitly clear selection —
 * that's the emitting caller's job, and this is that caller). An EMPTY
 * selection returns `[]` — no no-op DeleteShapes([]) and no redundant
 * SetSelection([]) when the selection is already empty. Stays in this
 * DOM-free module (CanvasV2App.tsx's keydown listener is the only DOM-facing
 * half of this wiring) per the module boundary this file's header states.
 */
export function deleteSelectionIntents(editor: Editor): Intent[] {
	const ids = [...editor.get().selection]
	if (ids.length === 0) return []
	return [
		{ type: 'DeleteShapes', ids },
		{ type: 'SetSelection', ids: [] },
	]
}

/**
 * D1's carry-forward from the clipboard-intents (E1) review: `SetSelection`
 * is a view intent with no inverse (editor.ts's `undo()`/`redo()` doc
 * comment says so explicitly — "Does NOT touch EditorState ... a caller that
 * wants 'select the shapes an undo just restored' does so itself via a
 * follow-up SetSelection"), so undoing a `duplicateSelectionIntents`/
 * `pasteIntents` batch (CreateShape x N + PutBinding x M + SetSelection over
 * the new root ids) removes the shapes those root ids named but leaves
 * `editor.get().selection` still holding them — dangling references to ids
 * that no longer resolve in the doc.
 *
 * Delete's own path (`deleteSelectionIntents` above) never hits this: its
 * forward SetSelection always lands on `[]`, and `[]` stays valid no matter
 * what an undo/redo does to the doc afterward. Duplicate/paste's forward
 * SetSelection lands on the NEW ids instead, which an undo of that same
 * batch invalidates — so, unlike Delete, they need an ACTIVE fix.
 *
 * Rather than special-case "was the last undone/redone batch a
 * paste/duplicate" (the undo/redo call sites don't know what kind of batch
 * they just replayed, only that they replayed one), this is a general
 * hygiene pass: read the CURRENT selection, keep only ids that still
 * resolve via `editor.doc.getShape` (a live read — see editor.ts's own
 * "read live, not off a snapshot" convention), and emit a `SetSelection`
 * ONLY when that actually drops something (mirrors deleteSelectionIntents's
 * own "no redundant SetSelection" discipline — calling this after every
 * undo/redo when nothing dangled would otherwise emit a same-value
 * SetSelection every time, and editor.ts's own state-change note says
 * SetSelection notifies even when the ids are identical). Call this right
 * after `editor.undo()`/`editor.redo()` in CanvasV2App's shared shortcut
 * policy — applying the result (if non-empty) is a pure state-only intent
 * (`docMutated` stays false), so it never pushes a new undo entry or clears
 * the redo stack (editor.ts's applyAll: the undo/redo stacks only move on
 * `docMutated`).
 */
export function pruneDanglingSelectionIntents(editor: Editor): Intent[] {
	const current = [...editor.get().selection]
	const pruned = current.filter((id) => editor.doc.getShape(id) !== undefined)
	if (pruned.length === current.length) return []
	return [{ type: 'SetSelection', ids: pruned }]
}

export function cancelActiveTool(tools: ToolSet, states: ToolStates, active: ToolId, editor: Editor): { states: ToolStates; intents: Intent[] } {
	const intents: Intent[] = []

	if (active === 'arrow') {
		const s = states.arrow as ArrowState
		if (s.mode === 'drawing') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	} else if (active === 'draw') {
		// The pen tool's in-flight 'drawing' state carries `id` — like
		// arrow/create, the preview stroke is already committed to the doc on
		// every pointermove (and even on the bare pointerdown — draw.ts has no
		// threshold gate), so an abandoned mid-stroke shape must be deleted the
		// same way (Task W1, D-5).
		const s = states.draw as DrawState
		if (s.mode === 'drawing') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	} else if (active === 'line') {
		// The line tool's in-flight 'drawing' state carries `id` — like
		// arrow, the preview line is already committed to the doc once the
		// drag crosses its threshold (line.ts has the same threshold gate as
		// arrow.ts, unlike draw.ts's bare-pointerdown commit), so an abandoned
		// mid-drag line must be deleted the same way (Task W1, D-5).
		const s = states.line as LineState
		if (s.mode === 'drawing') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	} else if (active === 'note' || active === 'text' || active === 'geo' || active === 'frame') {
		const s = states[active] as CreateState
		if (s.mode === 'dragging') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	} else if (active === 'select') {
		// The composite's TRANSFORM leg (reached only through 'select' — see
		// the module header). B5: restore every affected shape to its
		// gesture-start snapshot — see the coverage note above for why one
		// CreateShape per shape suffices regardless of the incremental commit
		// count. TOLERANT: skip an id the live doc no longer resolves rather
		// than resurrecting it.
		const transform = (states.select as SelectAndTransformState).transform
		if (transform.mode === 'resizing' || transform.mode === 'rotating') {
			for (const shape of transform.startShapes) {
				if (editor.doc.getShape(shape.id)) intents.push({ type: 'CreateShape', shape })
			}
		}
	}
	// hand: never creates OR mutates a shape (pans the camera only) —
	// nothing to revert.

	return { states: createInitialToolStates(tools), intents }
}
