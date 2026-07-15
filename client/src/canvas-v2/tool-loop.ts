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
 * (transform.ts). `createSelectAndTransformTool` below is the composite that
 * delivers that union with the SIMPLEST correct rule: on every pointerdown
 * while composite-idle, give transform.ts FIRST CRACK (it only reacts to a
 * pointerdown that lands on a handle — everything else is a no-op returning
 * its own unchanged idle state); if transform grabbed a handle (its
 * returned state left 'idle'), the composite's active leg becomes
 * 'transform' for every subsequent event until transform's own FSM returns
 * to idle (pointerup) — otherwise the event is forwarded to select.ts as
 * normal. This is exactly "transform handles work when a selection exists"
 * without either tool needing to know the other exists: composed at the
 * dispatch layer, not inside either FSM.
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
	createHandTool,
	createSelectTool,
	createTransformTool,
	type ArrowState,
	type CreateKind,
	type CreateState,
	type HandState,
	type SelectState,
	type TransformState,
} from '@ensembleworks/canvas-editor'
import type { SnapResult } from '@ensembleworks/canvas-model'

/** The toolbar's tool identifiers — see CanvasV2App.tsx's toolbar for the
 * button list. 'transform' is deliberately ABSENT (see module header). */
export type ToolId = 'select' | 'hand' | 'note' | 'text' | 'geo' | 'frame' | 'arrow'

export interface SelectAndTransformState {
	readonly active: 'select' | 'transform'
	readonly select: SelectState
	readonly transform: TransformState
}

/** The composite described in the module header. A `Tool<SelectAndTransformState>`
 * in its own right, so it slots into the exact same `Tool<S>` machinery every
 * other tool uses (script.ts's `run()` semantics, this file's `createToolSet`
 * below) with no special-casing at the call site. */
export function createSelectAndTransformTool(ctx: ToolContext): Tool<SelectAndTransformState> {
	const select = createSelectTool(ctx)
	const transform = createTransformTool(ctx)
	const initialState: SelectAndTransformState = { active: 'select', select: select.initialState, transform: transform.initialState }

	return {
		initialState,
		onEvent(state, event): { state: SelectAndTransformState; intents: Intent[] } {
			if (state.active === 'transform') {
				const r = transform.onEvent(state.transform, event)
				const active = r.state.mode === 'idle' ? 'select' : 'transform'
				return { state: { ...state, active, transform: r.state }, intents: r.intents }
			}
			// active === 'select': give transform first crack at a pointerdown
			// ONLY (its onIdle is a no-op for every other event type anyway, so
			// trying it on every event would be wasted work, not wrong — but
			// pointerdown is the only event where it can possibly transition).
			if (event.type === 'pointerdown') {
				const rt = transform.onEvent(state.transform, event)
				if (rt.state.mode !== 'idle') {
					// HANDOFF RESETS THE SELECT LEG (quality-review fix — the
					// reviewer reproduced the bug this prevents): select's Idle
					// state carries `lastClick`, its double-click memory
					// (select.ts's DOUBLE-CLICK-TO-EDIT section), and an entire
					// resize/rotate gesture routes EXCLUSIVELY through the
					// transform leg — select's FSM never sees any of it — so
					// without this reset that memory would survive the whole
					// gesture: click A, resize A via a handle, click A again
					// within DOUBLE_CLICK_MS of the FIRST click -> spurious
					// BeginEdit. A handle-grab is a NEW gesture, not the second
					// half of a click pair, so the select leg goes back to its
					// own initialState ({mode:'idle', lastClick:null}) at the
					// handoff. Pinned by tool-loop.test.ts's click-resize-click
					// probe (with its plain-double-click control case).
					return { state: { active: 'transform', select: select.initialState, transform: rt.state }, intents: rt.intents }
				}
			}
			const rs = select.onEvent(state.select, event)
			return { state: { ...state, select: rs.state }, intents: rs.intents }
		},
	}
}

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
 *    transform.ts's COMMIT CADENCE note). Reset to idle only; the v1 policy
 *    does NOT revert a partially-completed resize/rotate back to its
 *    pre-gesture size/angle — the shape is simply left at whatever the last
 *    delivered pointermove committed. Full undo-to-gesture-start is a
 *    documented Phase-4 parity item, not this unit's scope (canvas-editor
 *    has no undo stack yet at all).
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

export function cancelActiveTool(tools: ToolSet, states: ToolStates, active: ToolId): { states: ToolStates; intents: Intent[] } {
	const intents: Intent[] = []

	if (active === 'arrow') {
		const s = states.arrow as ArrowState
		if (s.mode === 'drawing') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	} else if (active === 'note' || active === 'text' || active === 'geo' || active === 'frame') {
		const s = states[active] as CreateState
		if (s.mode === 'dragging') intents.push({ type: 'DeleteShapes', ids: [s.id] })
	}
	// select/hand/transform (reached via the select composite): no created
	// shape to delete — see the coverage note above.

	return { states: createInitialToolStates(tools), intents }
}
