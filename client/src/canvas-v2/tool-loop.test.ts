// Run: bun src/canvas-v2/tool-loop.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor, createToolContext, duplicateSelectionIntents, type ArrowState, type CreateState, type ToolContext } from '@ensembleworks/canvas-editor'
import {
	cancelActiveTool,
	createInitialToolStates,
	createSelectAndTransformTool,
	createToolSet,
	currentSnapResult,
	deleteSelectionIntents,
	dispatchToActiveTool,
	pruneDanglingSelectionIntents,
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

	const cancelled = cancelActiveTool(tools, states, 'arrow', editor)
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

	const cancelled = cancelActiveTool(tools, states, 'geo', editor)
	assert.deepEqual(cancelled.intents, [{ type: 'DeleteShapes', ids: [previewId] }], "cancelling a mid-drag create tool emits DeleteShapes for its preview id")
	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape(previewId), undefined, 'the drag-to-size preview is actually gone after applying the cancel intents')
	console.log('ok: tool-loop — cancelActiveTool covers the create drag-to-size preview (DeleteShapes)')
}

// ============================================================================
// 3b. cancelActiveTool COVERAGE — create (note): same 'dragging'-state
//    DeleteShapes coverage as case 3, on the OTHER create kind the B3 task
//    text names explicitly ("note tool in dragging mode carrying an id") —
//    tool-loop.ts's dispatch/cancel code is parameterized by ToolId, not by
//    CreateKind, so this is the same code path as case 3's 'geo', proven a
//    second time on the literal kind the task calls out.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)

	states = dispatchToActiveTool(tools, states, 'note', editor, { type: 'pointerdown', x: 500, y: 500, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'note', editor, { type: 'pointermove', x: 560, y: 560, buttons: 1, modifiers: MODS, t: 16 })
	const noteState = states.note as CreateState
	assert.equal(noteState.mode, 'dragging', 'precondition: the note drag-to-size gesture crossed the threshold')
	const notePreviewId = (noteState as { id: string }).id
	assert.ok(editor.doc.getShape(notePreviewId), 'precondition: the in-flight note preview already exists in the doc')

	const cancelledNote = cancelActiveTool(tools, states, 'note', editor)
	assert.deepEqual(cancelledNote.intents, [{ type: 'DeleteShapes', ids: [notePreviewId] }], 'cancelling a mid-drag note create emits DeleteShapes for its preview id')
	editor.applyAll(cancelledNote.intents)
	assert.equal(editor.doc.getShape(notePreviewId), undefined, 'the note preview is actually gone after applying the cancel intents')
	assert.deepEqual(cancelledNote.states, createInitialToolStates(tools), 'the full ToolStates map resets, not just the note tool')
	console.log('ok: tool-loop — cancelActiveTool covers the note create-drag preview (DeleteShapes)')
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
	const cancelledSelect = cancelActiveTool(tools, states, 'select', editor)
	assert.deepEqual(cancelledSelect.intents, [], 'select has nothing to delete on cancel — reset to idle only')

	// hand: mid-pan (no shape created).
	states = dispatchToActiveTool(tools, createInitialToolStates(tools), 'hand', editor, { type: 'pointerdown', x: 0, y: 0, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'hand', editor, { type: 'pointermove', x: 20, y: 20, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.hand as { mode: string }).mode, 'panning', 'precondition: hand is mid-pan')
	const cancelledHand = cancelActiveTool(tools, states, 'hand', editor)
	assert.deepEqual(cancelledHand.intents, [], 'hand has nothing to delete on cancel — reset to idle only')

	console.log('ok: tool-loop — cancelActiveTool honestly emits zero intents for select/hand (nothing created)')
}

// ============================================================================
// 4b. cancelActiveTool COVERAGE — transform, REVERT (Task B5, supersedes the
//    old "reset to idle only" behavior): reached ONLY via the select
//    composite (no dedicated toolbar button — see tool-loop.ts's module
//    header), so the ACTIVE ToolId `cancelActiveTool` sees is still 'select'
//    even mid-resize; the composite's OWN internal `active` leg is
//    'transform'. Resizing never CREATES a shape, but it DOES mutate shape:a
//    IN PLACE across MULTIPLE incremental commits (two pointermoves here, no
//    pointerup — transform.ts's COMMIT CADENCE note) before cancel runs.
//    cancelActiveTool must now emit a CreateShape reverting shape:a to its
//    EXACT gesture-start geometry (transform.ts's startShapes snapshot),
//    undoing BOTH incremental commits in one intent, and still fully reset
//    the composite (both legs) back to its pristine initialState. A FRESH
//    setup() (not the shared editor from case 4 above, which left shape:a
//    mid-drag at an uncommitted pointerup-less position) so the handle sits
//    at the expected (100,100) corner.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)
	const before = editor.doc.getShape('shape:a')!
	assert.deepEqual({ x: before.x, y: before.y, w: (before.props as { w: number }).w, h: (before.props as { h: number }).h }, { x: 0, y: 0, w: 100, h: 100 }, 'precondition: shape:a starts at its geoShape defaults')

	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 50, y: 50, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerup', x: 50, y: 50, buttons: 0, modifiers: MODS, t: 16 })
	assert.deepEqual([...editor.get().selection], ['shape:a'], 'precondition: shape:a is selected (transform only reacts to a handle on an existing selection)')
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 100, y: 100, buttons: 1, modifiers: MODS, t: 32 })
	assert.equal((states.select as SelectAndTransformState).active, 'transform', 'precondition: the handle grab routed to the transform leg')
	// TWO incremental moves (two separate ResizeShapes commits), no
	// pointerup — proving the revert undoes BOTH, not just the last one.
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 150, y: 150, buttons: 1, modifiers: MODS, t: 48 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 400, y: 300, buttons: 1, modifiers: MODS, t: 64 })
	assert.equal((states.select as SelectAndTransformState).transform.mode, 'resizing', 'precondition: transform is mid-resize')
	const midGesture = editor.doc.getShape('shape:a')!
	assert.notEqual((midGesture.props as { w: number }).w, 100, 'precondition: the resize actually mutated shape:a mid-gesture (two commits deep)')

	const cancelledTransform = cancelActiveTool(tools, states, 'select', editor)
	assert.deepEqual(cancelledTransform.intents, [{ type: 'CreateShape', shape: before }], 'cancelling mid-resize emits ONE CreateShape restoring shape:a to its exact gesture-start snapshot')
	assert.deepEqual(cancelledTransform.states, createInitialToolStates(tools), 'a transform-mid-resize cancel resets the WHOLE composite (both legs) back to its pristine initialState, not just transform\'s own idle')

	editor.applyAll(cancelledTransform.intents)
	const reverted = editor.doc.getShape('shape:a')!
	assert.equal(reverted.x, 0)
	assert.equal(reverted.y, 0)
	assert.equal((reverted.props as { w: number }).w, 100, 'w reverted to its pre-gesture value despite two incremental resize commits')
	assert.equal((reverted.props as { h: number }).h, 100)

	console.log('ok: tool-loop — cancelActiveTool reverts a mid-resize transform gesture to its gesture-start geometry (Task B5)')
}

// ============================================================================
// 4c. cancelActiveTool COVERAGE — transform, REVERT (rotate): same B5
//    mechanism, driven via the rotate handle instead of a corner handle —
//    proves the revert covers ROTATION (not just w/h/x/y from a resize).
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)
	const before = editor.doc.getShape('shape:a')!
	assert.equal(before.rotation, 0, 'precondition: shape:a starts unrotated')

	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 50, y: 50, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerup', x: 50, y: 50, buttons: 0, modifiers: MODS, t: 16 })
	// Rotate handle sits 32 units above the top-edge midpoint (50, -32) for
	// shape:a's [0,100]x[0,100] box (see selectionHandles/transform.test.ts).
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 50, y: -32, buttons: 1, modifiers: MODS, t: 32 })
	assert.equal((states.select as SelectAndTransformState).active, 'transform', 'precondition: the rotate-handle grab routed to the transform leg')
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 150, y: 50, buttons: 1, modifiers: MODS, t: 48 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 50, y: 150, buttons: 1, modifiers: MODS, t: 64 })
	assert.equal((states.select as SelectAndTransformState).transform.mode, 'rotating', 'precondition: transform is mid-rotate')
	const midGesture = editor.doc.getShape('shape:a')!
	assert.notEqual(midGesture.rotation, 0, 'precondition: the rotate actually mutated shape:a mid-gesture')

	const cancelledTransform = cancelActiveTool(tools, states, 'select', editor)
	assert.deepEqual(cancelledTransform.intents, [{ type: 'CreateShape', shape: before }], 'cancelling mid-rotate emits ONE CreateShape restoring shape:a to its exact gesture-start snapshot')
	editor.applyAll(cancelledTransform.intents)
	const reverted = editor.doc.getShape('shape:a')!
	assert.equal(reverted.rotation, 0, 'rotation reverted to its pre-gesture value')
	assert.equal(reverted.x, 0)
	assert.equal(reverted.y, 0)

	console.log('ok: tool-loop — cancelActiveTool reverts a mid-rotate transform gesture to its gesture-start rotation (Task B5)')
}

// ============================================================================
// 4d. cancelActiveTool COVERAGE — transform, REVERT (multi-select): TWO
//    shapes selected and resized together via one composite handle drag —
//    cancel must restore BOTH affected shapes, not just the first.
// ============================================================================
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape(geoShape('shape:m1', 0, 0, 100, 100))
	doc.putShape(geoShape('shape:m2', 200, 0, 100, 100))
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
	const ctx: ToolContext = createToolContext(editor)
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)
	const before1 = editor.doc.getShape('shape:m1')!
	const before2 = editor.doc.getShape('shape:m2')!

	editor.apply({ type: 'SetSelection', ids: ['shape:m1', 'shape:m2'] })
	// Combined world bounds: [0,0]x[300,100] -> SE corner handle at (300,100),
	// opposite (anchor) NW at (0,0).
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 300, y: 100, buttons: 1, modifiers: MODS, t: 0 })
	assert.equal((states.select as SelectAndTransformState).active, 'transform', 'precondition: the handle grab routed to the transform leg for the multi-select')
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 600, y: 200, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.select as SelectAndTransformState).transform.mode, 'resizing', 'precondition: transform is mid-resize')
	assert.notEqual((editor.doc.getShape('shape:m1')!.props as { w: number }).w, 100, 'precondition: shape:m1 was mutated mid-gesture')
	assert.notEqual((editor.doc.getShape('shape:m2')!.props as { w: number }).w, 100, 'precondition: shape:m2 was mutated mid-gesture')

	const cancelled = cancelActiveTool(tools, states, 'select', editor)
	assert.deepEqual(new Set(cancelled.intents.map((i) => (i as { shape: Shape }).shape.id)), new Set(['shape:m1', 'shape:m2']), 'the revert covers BOTH affected shapes')
	editor.applyAll(cancelled.intents)
	const reverted1 = editor.doc.getShape('shape:m1')!
	const reverted2 = editor.doc.getShape('shape:m2')!
	assert.equal((reverted1.props as { w: number }).w, 100)
	assert.equal(reverted1.x, before1.x)
	assert.equal((reverted2.props as { w: number }).w, 100)
	assert.equal(reverted2.x, before2.x)

	console.log('ok: tool-loop — cancelActiveTool reverts a mid-resize MULTI-SELECT transform gesture, restoring every affected shape (Task B5)')
}

// ============================================================================
// 4e. cancelActiveTool COVERAGE — transform, REVERT tolerance (Task B5): a
//    shape that VANISHES mid-gesture (a concurrent remote delete, mirroring
//    select.test.ts's "mid-drag remote deletion of the target" pattern) must
//    NOT be resurrected by the cancel-revert — cancelActiveTool checks each
//    startShapes entry against the LIVE doc and skips a vanished id (see
//    tool-loop.ts's `if (editor.doc.getShape(shape.id))` branch). A
//    multi-select gesture proves the SURVIVING shape is still restored while
//    the deleted one is skipped, not an all-or-nothing bail.
// ============================================================================
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape(geoShape('shape:v1', 0, 0, 100, 100))
	doc.putShape(geoShape('shape:v2', 200, 0, 100, 100))
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
	const ctx: ToolContext = createToolContext(editor)
	const tools = createToolSet(ctx)
	let states = createInitialToolStates(tools)
	const before2 = editor.doc.getShape('shape:v2')!

	editor.apply({ type: 'SetSelection', ids: ['shape:v1', 'shape:v2'] })
	// Combined world bounds [0,0]x[300,100] -> SE handle at (300,100).
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointerdown', x: 300, y: 100, buttons: 1, modifiers: MODS, t: 0 })
	states = dispatchToActiveTool(tools, states, 'select', editor, { type: 'pointermove', x: 600, y: 200, buttons: 1, modifiers: MODS, t: 16 })
	assert.equal((states.select as SelectAndTransformState).transform.mode, 'resizing', 'precondition: transform is mid-resize with a two-shape startShapes snapshot')

	// A concurrent remote delete removes shape:v1 out from under the gesture,
	// AFTER its gesture-start snapshot was already captured.
	editor.apply({ type: 'DeleteShapes', ids: ['shape:v1'] })
	assert.equal(editor.doc.getShape('shape:v1'), undefined, 'precondition: shape:v1 has vanished mid-gesture')

	const cancelled = cancelActiveTool(tools, states, 'select', editor)
	const revertedIds = cancelled.intents.map((i) => (i as { shape: Shape }).shape.id)
	assert.deepEqual(revertedIds, ['shape:v2'], 'the vanished shape:v1 is skipped (not resurrected); only the surviving shape:v2 is reverted')

	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape('shape:v1'), undefined, 'shape:v1 stays deleted after applying the cancel intents — never resurrected')
	const reverted2 = editor.doc.getShape('shape:v2')!
	assert.equal((reverted2.props as { w: number }).w, 100, 'the surviving shape:v2 is still restored to its gesture-start size')
	assert.equal(reverted2.x, before2.x)

	console.log('ok: tool-loop — cancelActiveTool skips a shape that vanished mid-gesture, still restoring the survivors (Task B5 tolerance)')
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

// ============================================================================
// 8. pruneDanglingSelectionIntents (Task D1's undo-selection-cleanup carry-
//    forward) — SetSelection has no inverse (editor.ts's undo() doc comment),
//    so undoing a duplicate/paste batch removes the newly-created shapes but
//    leaves `editor.get().selection` pointing at their now-gone ids. This is
//    the general fix: prune the CURRENT selection down to ids that still
//    resolve, emitting SetSelection only when something was actually
//    dropped.
// ============================================================================
{
	const { editor } = setup()
	editor.doc.putShape(geoShape('shape:b', 200, 200))
	editor.doc.commit()

	// A selection with nothing dangling -> no intents at all (no redundant
	// same-value SetSelection).
	editor.apply({ type: 'SetSelection', ids: ['shape:a', 'shape:b'] })
	assert.deepEqual(pruneDanglingSelectionIntents(editor), [], 'a fully-resolving selection yields no intents')

	// An empty selection -> also no intents (nothing to prune).
	editor.apply({ type: 'SetSelection', ids: [] })
	assert.deepEqual(pruneDanglingSelectionIntents(editor), [], 'an empty selection yields no intents')

	// The duplicate/undo scenario itself: duplicate shape:a (selection moves
	// to the clone's root id), then undo the duplicate's CreateShape — the
	// clone is gone but selection still names it.
	const before = new Set<string>(editor.doc.listShapes().map((s) => s.id))
	editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
	editor.applyAll(duplicateSelectionIntents(editor))
	const cloneId = [...editor.get().selection][0]!
	assert.ok(!before.has(cloneId), 'precondition: the duplicate minted a brand-new id')
	assert.ok(editor.doc.getShape(cloneId), 'precondition: the clone exists in the doc before undo')

	editor.undo()
	assert.equal(editor.doc.getShape(cloneId), undefined, 'precondition: undo actually removed the clone')
	assert.deepEqual([...editor.get().selection], [cloneId], 'precondition: editor.undo() does NOT touch selection on its own — it still names the deleted clone')

	assert.deepEqual(
		pruneDanglingSelectionIntents(editor),
		[{ type: 'SetSelection', ids: [] }],
		'pruneDanglingSelectionIntents drops the dangling clone id, leaving the (now-empty) valid remainder',
	)
	editor.applyAll(pruneDanglingSelectionIntents(editor))
	assert.deepEqual([...editor.get().selection], [], 'applying the pruned SetSelection actually clears the dangling reference')

	// A MIXED selection (one live id, one dangling) prunes down to just the
	// live one, order preserved.
	editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
	editor.applyAll(duplicateSelectionIntents(editor))
	const cloneId2 = [...editor.get().selection][0]!
	editor.apply({ type: 'SetSelection', ids: ['shape:b', cloneId2] })
	editor.undo() // removes the clone; selection still names ['shape:b', cloneId2]
	assert.deepEqual(
		pruneDanglingSelectionIntents(editor),
		[{ type: 'SetSelection', ids: ['shape:b'] }],
		'a mixed live+dangling selection prunes down to just the surviving live id',
	)

	console.log('ok: tool-loop — pruneDanglingSelectionIntents (no-op when nothing dangles, drops dangling ids after an undo)')
}

// ============================================================================
// 8. Task W1 — the 'draw' tool is wired into the ToolSet/ToolStates/dispatch
//    machinery exactly like arrow/create: createToolSet builds it,
//    createInitialToolStates seeds its idle state, dispatchToActiveTool
//    routes a pointerdown to it and applies the resulting CreateShape (the
//    pen tool commits a one-point "dot" draw shape on pointerdown alone — no
//    drag threshold, per draw.ts's own doc comment), and cancelActiveTool
//    covers its in-flight 'drawing' state (which carries `id`, like
//    arrow/create) so an abandoned mid-stroke shape doesn't leak.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)

	assert.ok(tools.draw, 'createToolSet must build a `draw` tool (Task W1 — createDrawTool wired in)')

	const states = createInitialToolStates(tools)
	assert.equal(states.draw, tools.draw.initialState, 'createInitialToolStates must seed a `draw` entry at the draw tool\'s own initialState')

	const before = new Set<string>(editor.doc.listShapes().map((s) => s.id))
	const afterDown = dispatchToActiveTool(tools, states, 'draw', editor, { type: 'pointerdown', x: 700, y: 700, buttons: 1, modifiers: MODS, t: 0 })
	const createdId = editor.doc.listShapes().map((s) => s.id).find((id) => !before.has(id))
	assert.ok(createdId, `dispatching a pointerdown to the 'draw' active tool must create a shape — shapes: ${JSON.stringify(editor.doc.listShapes())}`)
	assert.equal(editor.doc.getShape(createdId!)?.kind, 'draw', 'the created shape must be a `draw`-kind shape')

	// Mid-stroke (pointerdown landed, no pointerup yet): cancelActiveTool must
	// delete the in-flight preview, same DeleteShapes coverage as arrow/create.
	const drawState = afterDown.draw as { mode: string; id: string }
	assert.equal(drawState.mode, 'drawing', 'precondition: the draw tool is mid-stroke after a bare pointerdown (no threshold gate)')
	const cancelled = cancelActiveTool(tools, afterDown, 'draw', editor)
	assert.deepEqual(cancelled.intents, [{ type: 'DeleteShapes', ids: [drawState.id] }], 'cancelling a mid-stroke draw gesture emits DeleteShapes for its in-flight id')
	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape(drawState.id), undefined, 'the in-flight draw preview is actually gone after applying the cancel intent')

	console.log('ok: tool-loop — the draw tool is wired into createToolSet/createInitialToolStates/dispatchToActiveTool/cancelActiveTool (Task W1)')
}

// ============================================================================
// 9. Task W1 (line sub-cycle) — the 'line' tool is wired into the
//    ToolSet/ToolStates/dispatch machinery exactly like arrow: createToolSet
//    builds it, createInitialToolStates seeds its idle state,
//    dispatchToActiveTool routes a down->move(threshold-crossing) to it and
//    applies the resulting line-kind CreateShape (line.ts has a threshold
//    gate like arrow — a bare pointerdown writes nothing), and
//    cancelActiveTool covers its in-flight 'drawing' state (which carries
//    `id`, like arrow/draw) so an abandoned mid-drag line doesn't leak.
// ============================================================================
{
	const { editor, ctx } = setup()
	const tools = createToolSet(ctx)

	assert.ok(tools.line, 'createToolSet must build a `line` tool (Task W1 — createLineTool wired in)')

	const states = createInitialToolStates(tools)
	assert.equal(states.line, tools.line.initialState, 'createInitialToolStates must seed a `line` entry at the line tool\'s own initialState')

	const before = new Set<string>(editor.doc.listShapes().map((s) => s.id))
	let s = dispatchToActiveTool(tools, states, 'line', editor, { type: 'pointerdown', x: 500, y: 500, buttons: 1, modifiers: MODS, t: 0 })
	s = dispatchToActiveTool(tools, s, 'line', editor, { type: 'pointermove', x: 520, y: 520, buttons: 1, modifiers: MODS, t: 16 })
	const createdId = editor.doc.listShapes().map((sh) => sh.id).find((id) => !before.has(id))
	assert.ok(createdId, `dispatching a threshold-crossing drag to the 'line' active tool must create a shape — shapes: ${JSON.stringify(editor.doc.listShapes())}`)
	assert.equal(editor.doc.getShape(createdId!)?.kind, 'line', 'the created shape must be a `line`-kind shape')

	// Mid-drag (threshold crossed, no pointerup yet): cancelActiveTool must
	// delete the in-flight preview, same DeleteShapes coverage as arrow/draw.
	const lineState = s.line as { mode: string; id: string }
	assert.equal(lineState.mode, 'drawing', 'precondition: the line gesture crossed the threshold and is mid-draw')
	const cancelled = cancelActiveTool(tools, s, 'line', editor)
	assert.deepEqual(cancelled.intents, [{ type: 'DeleteShapes', ids: [lineState.id] }], 'cancelling a mid-draw line emits DeleteShapes for its in-flight id')
	editor.applyAll(cancelled.intents)
	assert.equal(editor.doc.getShape(lineState.id), undefined, 'the in-flight line preview is actually gone after applying the cancel intent')
	assert.equal((cancelled.states.line as { mode: string }).mode, 'idle', 'the line tool itself resets to idle')

	console.log('ok: tool-loop — the line tool is wired into createToolSet/createInitialToolStates/dispatchToActiveTool/cancelActiveTool (Task W1)')
}

console.log('ok: tool-loop.test.ts — all cases passed')
