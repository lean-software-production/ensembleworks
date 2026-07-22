// Run: bun src/canvas-v2/StylePanel.test.ts
// Task P2 (docs/plans/2026-07-21-canvas-v2-styling.md) — component test for
// the contextual style panel's RENDERING (which controls show, which value is
// marked current/mixed). renderToStaticMarkup (this house's usual rig for a
// pure-render component, no DOM emulator needed — see DevOverlay.test.ts's
// own header) with props-injected selection + snapshot + a stubbed
// `onStyleChange`, per the plan's Step 1: don't boot the whole CanvasV2App.
// StylePanel itself only ever calls the injected `onStyleChange` prop — it
// still never imports the editor's apply/SetStyle machinery (see
// StylePanel.tsx's own module header). The actual DISPATCH wiring (Task P4:
// CanvasV2App.tsx's `onStyleChange`/`buildSetStyleIntent`, mounted at
// CanvasV2Session's `<StylePanel>` call) is proven end-to-end by
// CanvasV2App.test.ts's case (i), which boots a real session and clicks
// real DOM swatches.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Camera } from '@ensembleworks/canvas-editor'
import { StylePanel } from './StylePanel.js'

const CAMERA: Camera = { x: 0, y: 0, z: 1 }
const VIEWPORT = { width: 1024, height: 768 }

function shape(overrides: Partial<Shape> & Pick<Shape, 'id' | 'kind'>): Shape {
	return {
		parentId: 'page:p',
		index: 'a1',
		x: 100,
		y: 100,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
		...overrides,
	} as Shape
}

function docOf(...shapes: readonly Shape[]): CanvasDocument {
	return makeDocument({ pages: [{ id: 'page:p', name: 'Canvas' }], shapes, bindings: [] })
}

const noop = () => {}

// ============================================================================
// 1. Single blue note selected: a color-swatch row renders, the blue swatch
//    is marked current, and the panel's stable test hook is present.
// ============================================================================
{
	const s = shape({ id: 'shape:n1', kind: 'note', props: { color: 'blue' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([s.id]),
			snapshot: docOf(s),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.ok(html.includes('data-testid="ew-style-panel"'), `panel test hook renders — html: ${html}`)
	assert.ok(html.includes('data-style-control="color"'), `color control renders — html: ${html}`)
	assert.ok(
		/data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/.test(html),
		`blue swatch marked current — html: ${html}`,
	)
	console.log('ok: single blue note — color row renders with blue marked current')
}

// ============================================================================
// 2. Empty selection AND no armed style-bearing tool (the 'select' tool is
//    active): the panel renders nothing (returns null). This is now the
//    CONJUNCTION of two conditions (Task AS3 added the second) — see case 11
//    below for "empty selection but a style tool IS armed", which renders.
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set<string>(),
			snapshot: docOf(),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'select',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.equal(html, '', `empty selection, no armed style tool — renders nothing — html: ${html}`)
	console.log('ok: empty selection, select tool active — panel renders nothing')
}

// ============================================================================
// 3. A geo selection renders fill AND dash AND geo-variant controls
//    (mutant: a relevance table missing geo's own axes).
// ============================================================================
{
	const s = shape({ id: 'shape:g1', kind: 'geo', props: { geo: 'rectangle', fill: 'solid', dash: 'draw' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([s.id]),
			snapshot: docOf(s),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.ok(html.includes('data-style-control="fill"'), `fill control renders for geo — html: ${html}`)
	assert.ok(html.includes('data-style-control="dash"'), `dash control renders for geo — html: ${html}`)
	assert.ok(html.includes('data-style-control="geo"'), `geo-variant control renders for geo — html: ${html}`)
	console.log('ok: geo selection — fill/dash/geo controls all render')
}

// ============================================================================
// 4. A note selection does NOT render the geo-variant control (relevance is
//    per-kind, not "show everything" — mutant: relevantAxes returning the
//    full axis list regardless of selected kind).
// ============================================================================
{
	const s = shape({ id: 'shape:n2', kind: 'note', props: { color: 'red' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([s.id]),
			snapshot: docOf(s),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.ok(!html.includes('data-style-control="geo"'), `note selection has NO geo-variant control — html: ${html}`)
	assert.ok(!html.includes('data-style-control="fill"'), `note selection has NO fill control — html: ${html}`)
	assert.ok(!html.includes('data-style-control="dash"'), `note selection has NO dash control — html: ${html}`)
	console.log('ok: note selection — no geo/fill/dash controls (relevance is per-kind)')
}

// ============================================================================
// 5. A disagreeing (mixed) selection shows the mixed state distinctly — NOT
//    a wrong single value marked current (mutant: currentValue's disagreement
//    branch collapsing to the first shape's value instead of 'mixed', or the
//    panel ignoring 'mixed' and marking some swatch current anyway).
// ============================================================================
{
	const a = shape({ id: 'shape:n3', kind: 'note', props: { color: 'blue' } })
	const b = shape({ id: 'shape:n4', kind: 'note', props: { color: 'red' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([a.id, b.id]),
			snapshot: docOf(a, b),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	const colorControlMatch = html.match(/<div[^>]*data-style-control="color"[\s\S]*?<\/div>\s*<\/div>/)
	assert.ok(colorControlMatch, `color control block found — html: ${html}`)
	const colorBlock = colorControlMatch![0]
	assert.ok(colorBlock.includes('data-style-mixed="true"'), `color control flagged mixed — block: ${colorBlock}`)
	assert.ok(!colorBlock.includes('data-current="true"'), `no swatch wrongly marked current on a mixed axis — block: ${colorBlock}`)
	console.log('ok: mixed selection — color control shows mixed state, no swatch wrongly marked current')
}

// ============================================================================
// 6. Every relevant axis for a note (color/size/font/align/opacity) gets a
//    control — not just color.
// ============================================================================
{
	const s = shape({ id: 'shape:n5', kind: 'note', props: { color: 'green' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([s.id]),
			snapshot: docOf(s),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	for (const axis of ['color', 'size', 'font', 'align', 'opacity']) {
		assert.ok(html.includes(`data-style-control="${axis}"`), `note renders a "${axis}" control — html: ${html}`)
	}
	console.log('ok: note selection — every relevant axis (color/size/font/align/opacity) has a control')
}

// ============================================================================
// 7. Mid-gesture, the panel is hidden entirely, even with a live selection.
// ============================================================================
{
	const s = shape({ id: 'shape:n6', kind: 'note', props: { color: 'blue' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set([s.id]),
			snapshot: docOf(s),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: true,
			activeToolId: 'note',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.equal(html, '', `mid-gesture panel renders nothing — html: ${html}`)
	console.log('ok: isGesturing — panel hidden mid-gesture')
}

// ============================================================================
// Task AS3 — armed mode (empty selection, a style-bearing tool armed).
//
// `renderToStaticMarkup` drops event handlers entirely (server rendering has
// no interactivity), so it's enough for the RENDER-shape cases (8, 11, 12)
// below, same as cases 1-7 above — but NOT for "clicking X calls Y, not Z"
// (cases 9, 10). For those, `findStyleValueOnClick` walks StylePanel's
// RETURNED REACT ELEMENT TREE directly (StylePanel/AxisRow are both plain
// functions with no hooks, so calling them and walking the result is
// equivalent to what a renderer would do — no DOM/jsdom/happy-dom needed),
// expanding nested function components (AxisRow) along the way until it
// finds the `<button data-style-value="...">` and returns its real
// `onClick`.
// ============================================================================

interface ElementLike {
	readonly type?: unknown
	readonly props?: Record<string, unknown>
}

function isElementLike(x: unknown): x is ElementLike {
	return x !== null && typeof x === 'object'
}

/** Expand a React element down to a host element (`type` is a string, e.g.
 * `'button'`/`'div'`) by repeatedly calling any function-component `type` —
 * StylePanel/AxisRow never use hooks, so calling them directly outside a
 * renderer is safe and deterministic. */
function expand(node: unknown): unknown {
	if (!isElementLike(node)) return node
	if (typeof node.type === 'function') {
		const render = node.type as (props: Record<string, unknown>) => unknown
		return expand(render(node.props ?? {}))
	}
	return node
}

function findStyleValueOnClick(node: unknown, styleValue: string): (() => void) | undefined {
	const el = expand(node)
	if (!isElementLike(el)) return undefined
	if (el.type === 'button' && el.props?.['data-style-value'] === styleValue) {
		return el.props['onClick'] as (() => void) | undefined
	}
	const children = el.props?.['children']
	if (Array.isArray(children)) {
		for (const child of children) {
			const found = findStyleValueOnClick(child, styleValue)
			if (found) return found
		}
		return undefined
	}
	return findStyleValueOnClick(children, styleValue)
}

// ============================================================================
// 8. Armed geo tool, empty selection: the panel RENDERS in armed mode
//    (`data-style-panel-mode="armed"`), showing geo-relevant axes
//    (color/fill/dash/size/font/align/geo — same relevance table as a real
//    geo shape). Mutant: armed mode never renders / renders the wrong axes.
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set<string>(),
			snapshot: docOf(),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'geo',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.ok(html.includes('data-style-panel-mode="armed"'), `armed geo tool — panel renders in armed mode — html: ${html}`)
	assert.ok(html.includes('data-style-control="color"'), `armed geo — color control renders — html: ${html}`)
	assert.ok(html.includes('data-style-control="fill"'), `armed geo — fill control renders — html: ${html}`)
	assert.ok(html.includes('data-style-control="dash"'), `armed geo — dash control renders — html: ${html}`)
	assert.ok(html.includes('data-style-control="geo"'), `armed geo — geo-variant control renders — html: ${html}`)
	console.log('ok: armed geo tool, empty selection — armed panel renders geo-relevant axes')
}

// ============================================================================
// 9. Armed mode's blue color swatch click calls `onArmStyle('color', 'blue')`
//    — NOT `onStyleChange` (mutant: armed mode wired to dispatch `SetStyle`,
//    which would be a no-op over the empty selection this mode requires).
// ============================================================================
{
	const armCalls: Array<{ axis: string; value: unknown }> = []
	const styleChangeCalls: Array<{ axis: string; value: unknown }> = []
	const tree = StylePanel({
		selection: new Set<string>(),
		snapshot: docOf(),
		camera: CAMERA,
		viewportSize: VIEWPORT,
		isGesturing: false,
		activeToolId: 'geo',
		nextShapeStyle: {},
		onStyleChange: (axis, value) => styleChangeCalls.push({ axis, value }),
		onArmStyle: (axis, value) => armCalls.push({ axis, value }),
	})
	const onClick = findStyleValueOnClick(tree, 'blue')
	assert.ok(onClick, `armed panel's blue color swatch has an onClick handler`)
	onClick!()
	assert.deepEqual(armCalls, [{ axis: 'color', value: 'blue' }], `armed click calls onArmStyle with the color/blue pair — armCalls: ${JSON.stringify(armCalls)}`)
	assert.equal(styleChangeCalls.length, 0, `armed click never calls onStyleChange (SetStyle) — styleChangeCalls: ${JSON.stringify(styleChangeCalls)}`)
	console.log('ok: armed mode click calls onArmStyle (SetNextStyle), never onStyleChange (SetStyle)')
}

// ============================================================================
// 10. A LIVE SELECTION plus an armed tool: selection wins. The panel renders
//     in selection mode (not armed), and clicking a swatch calls
//     `onStyleChange` — arming never overrides styling what's actually
//     selected (mutant: a mode check that arms whenever a style tool is
//     active, ignoring a non-empty selection).
// ============================================================================
{
	const s = shape({ id: 'shape:n7', kind: 'note', props: { color: 'blue' } })
	const armCalls: Array<{ axis: string; value: unknown }> = []
	const styleChangeCalls: Array<{ axis: string; value: unknown }> = []
	const props = {
		selection: new Set([s.id]),
		snapshot: docOf(s),
		camera: CAMERA,
		viewportSize: VIEWPORT,
		isGesturing: false,
		activeToolId: 'geo' as const, // armed, but a selection exists — selection must win
		nextShapeStyle: { color: 'red' },
		onStyleChange: (axis: string, value: unknown) => styleChangeCalls.push({ axis, value }),
		onArmStyle: (axis: string, value: unknown) => armCalls.push({ axis, value }),
	}
	const html = renderToStaticMarkup(createElement(StylePanel, props))
	assert.ok(html.includes('data-style-panel-mode="selection"'), `selection wins over an armed tool — html: ${html}`)
	assert.ok(!html.includes('data-style-panel-mode="armed"'), `armed mode does NOT render when a selection exists — html: ${html}`)
	const tree = StylePanel(props)
	const onClick = findStyleValueOnClick(tree, 'red')
	assert.ok(onClick, `selection panel's red color swatch has an onClick handler`)
	onClick!()
	assert.deepEqual(styleChangeCalls, [{ axis: 'color', value: 'red' }], `selection-mode click calls onStyleChange — styleChangeCalls: ${JSON.stringify(styleChangeCalls)}`)
	assert.equal(armCalls.length, 0, `an armed tool never overrides an existing selection — onArmStyle must not be called — armCalls: ${JSON.stringify(armCalls)}`)
	console.log('ok: selection + armed tool — selection wins (SetStyle); arming does not override')
}

// ============================================================================
// 11. Empty selection AND a non-style tool ('select') armed: the panel
//     renders nothing, same as before AS3 (case 2 above pins this too — this
//     case is the explicit "AS3 didn't relax that" regression pin).
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set<string>(),
			snapshot: docOf(),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'hand',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.equal(html, '', `empty selection, hand tool active — renders nothing — html: ${html}`)
	console.log('ok: empty selection, hand tool active — panel renders nothing')
}

// ============================================================================
// 12. The armed panel reflects `nextShapeStyle`'s CURRENT values, not always
//     the defaults (mutant: armed mode ignores `nextShapeStyle` and shows
//     nothing as current, or always shows the first value as current
//     regardless of what's actually armed).
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set<string>(),
			snapshot: docOf(),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'geo',
			nextShapeStyle: { color: 'red' },
			onStyleChange: noop,
			onArmStyle: noop,
		}),
	)
	assert.ok(
		/data-style-value="red"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="red"/.test(html),
		`armed nextShapeStyle.color:'red' is marked current — html: ${html}`,
	)
	assert.ok(
		!/data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/.test(html),
		`armed panel does not ALSO mark blue current — html: ${html}`,
	)
	console.log('ok: armed panel — nextShapeStyle.color:red is marked current, not a default')
}

console.log('ok: StylePanel (P2/AS3) — renders per-selection styles from a props-injected snapshot/selection, and armed-tool next-shape styles when nothing is selected (component-level, `onStyleChange`/`onArmStyle` stubbed here; the real dispatch wiring is CanvasV2App.test.ts case (i)/AS3\'s onArmStyle, Task P4/AS3)')
