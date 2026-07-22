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
			onStyleChange: noop,
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
// 2. Empty selection: the panel renders nothing (returns null).
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set<string>(),
			snapshot: docOf(),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			onStyleChange: noop,
		}),
	)
	assert.equal(html, '', `empty selection renders nothing — html: ${html}`)
	console.log('ok: empty selection — panel renders nothing')
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
			onStyleChange: noop,
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
			onStyleChange: noop,
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
			onStyleChange: noop,
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
			onStyleChange: noop,
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
			onStyleChange: noop,
		}),
	)
	assert.equal(html, '', `mid-gesture panel renders nothing — html: ${html}`)
	console.log('ok: isGesturing — panel hidden mid-gesture')
}

console.log('ok: StylePanel (P2) — renders per-selection styles from a props-injected snapshot/selection (component-level, `onStyleChange` stubbed here; the real dispatch wiring is CanvasV2App.test.ts case (i), Task P4)')
