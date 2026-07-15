// Run: bun src/canvas-v2/tool-loop.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor, createToolContext, type ArrowState, type CreateState, type ToolContext } from '@ensembleworks/canvas-editor'
import {
	cancelActiveTool,
	createInitialToolStates,
	createSelectAndTransformTool,
	createToolSet,
	currentSnapResult,
	deleteSelectionIntents,
	dispatchToActiveTool,
	type SelectAndTransformState,
} from './tool-loop.js'

const FIXED_RANDOM = () => 0.5
const MODS = { shift: false, alt: false, ctrl: false, meta: false }

function geoShape(id: string, x: number, y: number, w = 100, h = 100): Shape {
	return { id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w, h } } as Shape
}

function setup() {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape(geoShape('shape:a', 0, 0, 100, 100))
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
	const ctx: ToolContext = createToolContext(editor)
	return { editor, ctx }
}

// ============================================================================
// 1. THE v1 TOOL-SWITCHING MODEL: createSelectAndTransformTool composes
//    select.ts + transform.ts. Click-select shape:a (routes through the
//    select leg), then grab its SE resize handle (routes through the
//    transform leg the moment a pointerdown lands on a handle) and drag it —
//    the shape actually resizes, proving the composite delivers "transform
//    handles work when a selection exists" with no button dedicated to a
//    'transform' tool.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tool = createSelectAndTransformTool(ctx)
	let state: SelectAndTransformState = tool.initialState

	function send(event: Parameters<typeof tool.onEvent>[1]) {
		const r = tool.onEvent(state, event)
		state = r.state
		if (r.intents.length > 0) editor.applyAll(r.intents)
	}

	// Click-select shape:a (inside its 0..100 x 0..100 box) — the SELECT leg.
	send({ type: 'pointerdown', x: 50, y: 50, buttons: 1, modifiers: MODS, t: 0 })
	send({ type: 'pointerup', x: 50, y: 50, buttons: 0, modifiers: MODS, t: 16 })
	assert.deepEqual([...editor.get().selection], ['shape:a'], 'click-select routed through the select leg')
	assert.equal(state.active, 'select', 'composite stays on the select leg after a plain click')

	// Grab the SE handle at (100,100) (selectionHandles' corner, exactly at the
	// shape's own bottom-right corner since camera is identity) — the
	// TRANSFORM leg takes over the moment this pointerdown lands on a handle.
	send({ type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 32 })
	assert.equal(state.active, 'transform', 'a pointerdown on a handle switches the composite to the transform leg')

	// Drag the handle out to (150,150) — anchor is the OPPOSITE (nw) corner at
	// (0,0), so this is a 1.5x scale (100 -> 150 relative to the anchor).
	send({ type: 'pointermove', x: 150, y: 150, buttons: 1, modifiers: MODS, t: 48 })
	const resized = editor.doc.getShape('shape:a')!
	assert.equal((resized.props as { w: number }).w, 150, 'the handle drag actually resized the shape (1.5x)')
	assert.equal((resized.props as { h: number }).h, 150)

	send({ type: 'pointerup', x: 150, y: 150, buttons: 0, modifiers: MODS, t: 64 })
	assert.equal(state.active, 'select', 'releasing the handle returns the composite to the select leg')
	console.log('ok: tool-loop — select+transform composite (click-select, then drag a handle to resize)')
}

// ============================================================================
// 2. cancelActiveTool COVERAGE — arrow: an in-flight 'drawing' state carries
//    the preview shape's id; cancel must emit DeleteShapes for it and reset
//    to idle.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)

	states = dispatchToActiveTool(tools, states, 'arrow', editor, { type: 'pointerdown', x: 500, y: 500, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'arrow', editor, { type: 'pointermove', x: 520, y: 520, buttons: 1, modifiers: MODS, t: 16 })
	const arrowState = states.arrow as ArrowState
	assert.equal(arrowState.mode, 'drawing', 'precondition: the arrow gesture crossed the threshold and is mid-draw')
	const arrowId = (arrowState as { id: string }).id
	assert.ok(editor.doc.getShape(arrowId), 'precondition: the in-flight arrow preview already exists in the doc')

	const cancelled = cancelActiveTool(tools, states, 'arrow')
	assert.deepEqual(cancelled.intents, [{ type: 'DeleteShapes', ids: [arrowId] }], 'cancelling a mid-draw arrow emits DeleteShapes for its preview id')
	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape(arrowId), undefined, 'the preview arrow is actually gone after applying the cancel intents')
	assert.equal((cancelled.states.arrow as ArrowState).mode, 'idle', 'the arrow tool itself resets to idle')
	console.log('ok: tool-loop — cancelActiveTool covers the arrow drag preview (DeleteShapes)')
}

// ============================================================================
// 3. cancelActiveTool COVERAGE — create (geo): an in-flight 'dragging' state
//    ALSO carries a preview shape id (create.ts's drag-to-size gesture) —
//    same DeleteShapes coverage as arrow.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)

	states = dispatchToActiveTool(tools, states, 'geo', editor, { type: 'pointerdown', x: 500, y: 500, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'geo', editor, { type: 'pointermove', x: 560, y: 560, buttons: 1, modifiers: MODS, t: 16 })
	const createState = states.geo as CreateState
	assert.equal(createState.mode, 'dragging', 'precondition: the drag-to-size gesture crossed the threshold')
	const previewId = (createState as { id: string }).id
	assert.ok(editor.doc.getShape(previewId), 'precondition: the in-flight drag-to-size preview already exists in the doc')

	const cancelled = cancelActiveTool(tools, states, 'geo')
	assert.deepEqual(cancelled.intents, [{ type: 'DeleteShapes', ids: [previewId] }], "cancelling a mid-drag create tool emits DeleteShapes for its preview id")
	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape(previewId), undefined, 'the drag-to-size preview is actually gone after applying the cancel intents')
	console.log('ok: tool-loop — cancelActiveTool covers the create drag-to-size preview (DeleteShapes)')
}

// ============================================================================
// 4. cancelActiveTool COVERAGE, HONEST NEGATIVE CASES — select/hand/transform
//    never create a shape, so cancelling mid-gesture emits NO intents, only a
//    reset to idle (see tool-loop.ts's cancelActiveTool doc comment).
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)

	// select: mid-drag translate of shape:a (no shape created).
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 50, y: 50, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 60, y: 60, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.select as SelectAndTransformState).select.mode, 'dragging', 'precondition: select is mid-drag')
	const cancelledSelect = cancelActiveTool(tools, states, 'select')
	assert.deepEqual(cancelledSelect.intents, [], 'select has nothing to delete on cancel — reset to idle only')

	// hand: mid-pan (no shape created).
	states = dispatchToActiveTool(tools, createInitialToolStates(tools), 'hand', editor, { type: 'pointerdown', x: 0, y: 0, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'hand', editor, { type: 'pointermove', x: 20, y: 20, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.hand as { mode: string }).mode, 'panning', 'precondition: hand is mid-pan')
	const cancelledHand = cancelActiveTool(tools, states, 'hand')
	assert.deepEqual(cancelledHand.intents, [], 'hand has nothing to delete on cancel — reset to idle only')

	console.log('ok: tool-loop — cancelActiveTool honestly emits zero intents for select/hand (nothing created)')
}

// ============================================================================
// 5. NO stale double-click memory across a transform gesture (quality-review
//    fix round): click A -> resize A via its SE handle (the whole gesture
//    routes to the TRANSFORM leg, so select's own FSM never sees any of it)
//    -> click A again, still within DOUBLE_CLICK_MS (450) of the FIRST
//    click. Without the composite resetting the select leg on the transform
//    handoff, select's Idle.lastClick survives the resize and the
//    post-resize click reads as the "second" click of a double-click ->
//    spurious BeginEdit. The fixture shape is a 'note' (text-capable, per
//    canvas-model's isTextCapableKind) so the spurious edit REALLY fires if
//    the bug is present -- not vacuously null.
// ============================================================================
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as Shape)
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
	const ctx: ToolContext = createToolContext(editor)
	const tool = createSelectAndTransformTool(ctx)
	let state: SelectAndTransformState = tool.initialState

	function send(event: Parameters<typeof tool.onEvent>[1]) {
		const r = tool.onEvent(state, event)
		state = r.state
		if (r.intents.length > 0) editor.applyAll(r.intents)
	}

	// Click the note (a note's kind-default local box is 200x200 -- see
	// canvas-model geometry.ts's size(): notes render 200*scale square).
	send({ type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 0 })
	send({ type: 'pointerup', x: 100, y: 100, buttons: 0, modifiers: MODS, t: 16 })
	assert.deepEqual([...editor.get().selection], ['shape:n'], 'precondition: the note is selected')

	// Resize via the SE handle at (200,200): the ENTIRE gesture routes to the
	// transform leg -- select's FSM never sees these three events.
	send({ type: 'pointerdown', x: 200, y: 200, buttons: 1, modifiers: MODS, t: 32 })
	assert.equal(state.active, 'transform', 'precondition: the handle grab routed to the transform leg')
	send({ type: 'pointermove', x: 220, y: 220, buttons: 1, modifiers: MODS, t: 48 })
	send({ type: 'pointerup', x: 220, y: 220, buttons: 0, modifiers: MODS, t: 64 })
	assert.equal(state.active, 'select', 'precondition: the resize ended, control returned to the select leg')

	// The reviewer's probe: click the note again, still within DOUBLE_CLICK_MS
	// (450) of the FIRST click (t=0/16).
	send({ type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 80 })
	send({ type: 'pointerup', x: 100, y: 100, buttons: 0, modifiers: MODS, t: 96 })
	assert.equal(editor.get().editingId, null, 'click -> handle-resize -> click must NEVER read as a double-click (stale lastClick across the transform gesture)')

	// Control case: a PLAIN double-click (no intervening transform gesture)
	// still begins editing -- the reset must not have broken the feature.
	send({ type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 600 })
	send({ type: 'pointerup', x: 100, y: 100, buttons: 0, modifiers: MODS, t: 616 })
	send({ type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 632 })
	send({ type: 'pointerup', x: 100, y: 100, buttons: 0, modifiers: MODS, t: 648 })
	assert.equal(editor.get().editingId, 'shape:n', 'control: a plain double-click still begins editing')

	console.log('ok: tool-loop — no stale double-click memory across a transform gesture')
}

// ============================================================================
// 6. currentSnapResult — the Overlay.snapResult accessor (Unit 13). undefined
//    whenever there's nothing to show; the select tool's carried SnapResult
//    once a drag near another shape is in flight.
// ============================================================================
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape(geoShape('shape:a', 0, 0, 100, 100))
	doc.putShape(geoShape('shape:b', 103, 0, 100, 100)) // 3-unit gap: within the 5-unit snap threshold
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
	const ctx: ToolContext = createToolContext(editor)
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)

	assert.equal(currentSnapResult(states, 'select'), undefined, 'idle select tool: nothing to show')
	assert.equal(currentSnapResult(states, 'hand'), undefined, 'a non-select active tool: nothing to show, regardless of select\'s own state')

	// Drag shape:a (which sits 3 units from shape:b -- within the snap
	// threshold) far enough to cross the drag threshold.
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 50, y: 50, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 55, y: 50, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.select as SelectAndTransformState).select.mode, 'dragging', 'precondition: select is mid-drag')
	const snap = currentSnapResult(states, 'select')
	assert.ok(snap, 'a SnapResult is surfaced once the select tool is mid-drag')
	assert.ok(snap.guides.length > 0, 'the nearby shape produces at least one guide')
	console.log('ok: tool-loop — currentSnapResult surfaces the select tool\'s carried SnapResult')
}

// ============================================================================
// 7. deleteSelectionIntents (Task B2) — the pure user-emitter for
//    DeleteShapes. A two-shape selection yields DeleteShapes for both ids
//    followed by SetSelection([]); an empty selection yields [] (no no-op
//    DeleteShapes([]), no redundant SetSelection([])).
// ============================================================================
{
	const { editor } = setup()
	editor.doc.putShape(geoShape('shape:b', 200, 200))
	editor.doc.commit()

	assert.deepEqual(deleteSelectionIntents(editor), [], 'an empty selection yields no intents at all')

	editor.apply({ type: 'SetSelection', ids: ['shape:a', 'shape:b'] })
	assert.deepEqual(
		deleteSelectionIntents(editor),
		[
			{ type: 'DeleteShapes', ids: ['shape:a', 'shape:b'] },
			{ type: 'SetSelection', ids: [] },
		],
		'a two-shape selection yields DeleteShapes for both ids, then SetSelection([])',
	)

	// Applying those intents actually deletes both shapes and clears the
	// selection — not just the right-shaped Intent[], the right EFFECT too.
	editor.applyAll(deleteSelectionIntents(editor))
	assert.equal(editor.doc.getShape('shape:a'), undefined, 'shape:a is actually gone after applying the intents')
	assert.equal(editor.doc.getShape('shape:b'), undefined, 'shape:b is actually gone after applying the intents')
	assert.deepEqual([...editor.get().selection], [], 'selection is cleared after applying the intents')

	console.log('ok: tool-loop — deleteSelectionIntents (two-shape selection, and the empty-selection no-op)')
}

console.log('ok: tool-loop.test.ts — all cases passed')
