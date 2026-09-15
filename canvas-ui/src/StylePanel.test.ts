// Run: bun src/StylePanel.test.ts
// Component test for the style panel's RENDERING: the selection toolbar's
// triggers and popover, and the armed-tool panel. renderToStaticMarkup (this
// house's usual rig for a pure-render component, no DOM emulator needed) with
// props-injected selection + snapshot and stubbed callbacks. StylePanel only
// ever calls the injected props; the real dispatch wiring is proven by
// CanvasV2App.test.ts.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Camera, ToolbarSlotId } from '@ensembleworks/canvas-editor'
import { GEO_COLORS } from '@ensembleworks/canvas-react'
import { StylePanel } from './StylePanel.js'
import { colorSwatchHex } from './style-controls.js'

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

/** Props shared by every case; override per case. */
function baseProps() {
	return {
		selection: new Set<string>(),
		snapshot: docOf(),
		camera: CAMERA,
		viewportSize: VIEWPORT,
		isGesturing: false,
		activeToolId: 'select' as const,
		nextShapeStyle: {},
		onStyleChange: noop,
		onArmStyle: noop,
		openSlot: null as ToolbarSlotId | null,
		onOpenSlotChange: noop,
	}
}

function renderSelection(shapes: readonly Shape[], openSlot: ToolbarSlotId | null = null) {
	return renderToStaticMarkup(
		createElement(StylePanel, {
			...baseProps(),
			selection: new Set(shapes.map((s) => s.id)),
			snapshot: docOf(...shapes),
			openSlot,
		}),
	)
}

const triggers = (html: string) => [...html.matchAll(/data-style-trigger="([^"]+)"/g)].map((m) => m[1])

/** The opening tag of the first element carrying `attr` (order-insensitive
 * attribute assertions run against it). */
function openingTag(html: string, attr: string): string {
	const at = html.indexOf(attr)
	assert.ok(at >= 0, `an element with ${attr} renders — html: ${html}`)
	const start = html.lastIndexOf('<', at)
	return html.slice(start, html.indexOf('>', at) + 1)
}

/** A trigger button through its closing tag (its face lives inside). */
function triggerBlock(html: string, slot: string): string {
	const match = html.match(new RegExp(`<button[^>]*data-style-trigger="${slot}"[\\s\\S]*?</button>`))
	assert.ok(match, `"${slot}" trigger renders — html: ${html}`)
	return match![0]
}

/** One `data-style-control="axis"` row through its matching closing tags. */
function controlBlock(html: string, axis: string): string {
	const re = new RegExp(`<div[^>]*data-style-control="${axis}"[\\s\\S]*?<\\/div>\\s*<\\/div>`)
	const match = html.match(re)
	assert.ok(match, `"${axis}" control block found — html: ${html}`)
	return match![0]
}

// ----------------------------------------------------------------------------
// Tree walking for click wiring: renderToStaticMarkup drops handlers, so these
// cases call StylePanel as a plain function and walk the returned element
// tree, expanding hook-free function components, to reach a real onClick.
// ----------------------------------------------------------------------------

interface ElementLike {
	readonly type?: unknown
	readonly props?: Record<string, unknown>
}

function isElementLike(x: unknown): x is ElementLike {
	return x !== null && typeof x === 'object'
}

function expand(node: unknown): unknown {
	if (!isElementLike(node)) return node
	if (typeof node.type === 'function') {
		const render = node.type as (props: Record<string, unknown>) => unknown
		return expand(render(node.props ?? {}))
	}
	return node
}

/** First host element whose props satisfy `match`, searching depth-first. */
function findElement(node: unknown, match: (props: Record<string, unknown>) => boolean): ElementLike | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, match)
			if (found) return found
		}
		return undefined
	}
	const el = expand(node)
	if (!isElementLike(el) || !el.props) return undefined
	if (typeof el.type === 'string' && match(el.props)) return el
	return findElement(el.props['children'], match)
}

function findStyleValueOnClick(node: unknown, styleValue: string): (() => void) | undefined {
	const el = findElement(node, (p) => p['data-style-value'] === styleValue)
	return el?.props?.['onClick'] as (() => void) | undefined
}

function findTriggerOnClick(node: unknown, slot: string): (() => void) | undefined {
	const el = findElement(node, (p) => p['data-style-trigger'] === slot)
	return el?.props?.['onClick'] as (() => void) | undefined
}

// ============================================================================
// Selection toolbar
// ============================================================================

// Closed: one trigger per slot, no value controls rendered.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue' } })
	const html = renderSelection([n])
	assert.deepEqual(triggers(html), ['color', 'font', 'size', 'align', 'more'])
	assert.ok(!html.includes('data-style-value='), `no value buttons while closed — html: ${html}`)
	assert.ok(!html.includes('data-style-popover'), 'no popover while closed')
	assert.ok(html.includes('data-style-panel-mode="selection"'), `selection mode hook — html: ${html}`)
	const colorTrigger = openingTag(html, 'data-style-trigger="color"')
	assert.match(colorTrigger, /aria-expanded="false"/)
	assert.match(colorTrigger, /aria-haspopup="true"/)
	console.log('ok: closed note bar shows five triggers and no values')
}

// Trigger face shows the current value.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue', size: 'l' } })
	const html = renderSelection([n])
	assert.ok(triggerBlock(html, 'color').includes(`background:${colorSwatchHex('blue')}`), `colour trigger shows the blue swatch — html: ${html}`)
	assert.match(openingTag(html, 'data-style-trigger="size"'), /title="Size: L"/, 'size trigger names its value')
	console.log('ok: trigger faces reflect current values')
}

// Open: popover renders that slot's axes with existing data hooks.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue' } })
	const html = renderSelection([n], 'color')
	assert.ok(html.includes('data-style-popover="color"'))
	assert.match(openingTag(html, 'data-style-trigger="color"'), /aria-expanded="true"/)
	assert.match(html, /data-style-control="color"/)
	assert.match(html, /data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/)
	const alignHtml = renderSelection([n], 'align')
	assert.ok(alignHtml.includes('data-style-control="align"') && alignHtml.includes('data-style-control="verticalAlign"'), 'multi-axis slot renders both rows')
	console.log('ok: open popover renders the slot controls')
}

// An open slot the current selection does not have renders no popover.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: {} })
	const html = renderSelection([n], 'geo')
	assert.ok(!html.includes('data-style-popover'), `stale open slot renders no popover — html: ${html}`)
	console.log('ok: an open slot absent from the selection renders no popover')
}

// Mixed geo + arrow: intersection only.
{
	const g = shape({ id: 'shape:g', kind: 'geo', props: {} })
	const a = shape({ id: 'shape:a', kind: 'arrow', props: {} })
	assert.deepEqual(triggers(renderSelection([g, a])), ['color', 'fill', 'dash', 'more'])
	console.log('ok: mixed selection shows only shared triggers')
}

// Mixed value: colour trigger marks mixed, and its popover marks no swatch current.
{
	const a = shape({ id: 'shape:a', kind: 'note', props: { color: 'blue' } })
	const b = shape({ id: 'shape:b', kind: 'note', props: { color: 'red' } })
	assert.match(openingTag(renderSelection([a, b]), 'data-style-trigger="color"'), /data-style-mixed="true"/)
	const colorBlock = controlBlock(renderSelection([a, b], 'color'), 'color')
	assert.ok(colorBlock.includes('data-style-mixed="true"'), `color control flagged mixed — block: ${colorBlock}`)
	assert.ok(!colorBlock.includes('data-current="true"'), `no swatch wrongly marked current on a mixed axis — block: ${colorBlock}`)
	console.log('ok: disagreeing selection marks the trigger and popover row mixed')
}

// Pointer-events contract still holds for wrapper, bar and popover: containers
// sitting over the selection must never eat a canvas gesture.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: {} })
	const html = renderSelection([n], 'color')
	assert.match(openingTag(html, 'data-testid="ew-style-panel"'), /pointer-events:none/)
	const bar = html.match(/^<div[^>]*data-testid="ew-style-panel"[^>]*>(<div[^>]*>)/)
	assert.ok(bar, `bar is the wrapper's first child — html: ${html}`)
	assert.match(bar![1]!, /pointer-events:none/, 'bar container passes pointers through')
	assert.match(openingTag(html, 'data-style-popover="color"'), /pointer-events:none/)
	assert.match(openingTag(html, 'data-style-trigger="color"'), /pointer-events:auto/)
	assert.match(openingTag(html, 'data-style-value="blue"'), /pointer-events:auto/)
	console.log('ok: containers pass pointers through, controls take them')
}

// Clicking a trigger toggles its slot through onOpenSlotChange.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: {} })
	const calls: Array<ToolbarSlotId | null> = []
	const props = {
		...baseProps(),
		selection: new Set([n.id]),
		snapshot: docOf(n),
		onOpenSlotChange: (slot: ToolbarSlotId | null) => calls.push(slot),
	}
	findTriggerOnClick(StylePanel(props), 'color')!()
	findTriggerOnClick(StylePanel({ ...props, openSlot: 'color' }), 'color')!()
	findTriggerOnClick(StylePanel({ ...props, openSlot: 'color' }), 'size')!()
	assert.deepEqual(calls, ['color', null, 'size'], `open, close, swap — calls: ${JSON.stringify(calls)}`)
	console.log('ok: trigger click opens its slot, closes it when open, swaps from another')
}

// Mid-gesture, the toolbar is hidden entirely, even with a live selection.
{
	const s = shape({ id: 'shape:n6', kind: 'note', props: { color: 'blue' } })
	const html = renderToStaticMarkup(
		createElement(StylePanel, { ...baseProps(), selection: new Set([s.id]), snapshot: docOf(s), isGesturing: true, openSlot: 'color' }),
	)
	assert.equal(html, '', `mid-gesture panel renders nothing — html: ${html}`)
	console.log('ok: isGesturing — panel hidden mid-gesture')
}

// A LIVE SELECTION plus an armed tool: selection wins, and a swatch click in
// the open popover calls onStyleChange, never onArmStyle.
{
	const s = shape({ id: 'shape:n7', kind: 'note', props: { color: 'blue' } })
	const armCalls: Array<{ axis: string; value: unknown }> = []
	const styleChangeCalls: Array<{ axis: string; value: unknown }> = []
	const props = {
		...baseProps(),
		selection: new Set([s.id]),
		snapshot: docOf(s),
		activeToolId: 'geo' as const,
		nextShapeStyle: { color: 'red' },
		openSlot: 'color' as const,
		onStyleChange: (axis: string, value: unknown) => styleChangeCalls.push({ axis, value }),
		onArmStyle: (axis: string, value: unknown) => armCalls.push({ axis, value }),
	}
	const html = renderToStaticMarkup(createElement(StylePanel, props))
	assert.ok(html.includes('data-style-panel-mode="selection"'), `selection wins over an armed tool — html: ${html}`)
	assert.ok(!html.includes('data-style-panel-mode="armed"'), `armed mode does NOT render when a selection exists — html: ${html}`)
	const onClick = findStyleValueOnClick(StylePanel(props), 'red')
	assert.ok(onClick, `selection popover's red color swatch has an onClick handler`)
	onClick!()
	assert.deepEqual(styleChangeCalls, [{ axis: 'color', value: 'red' }], `selection-mode click calls onStyleChange — styleChangeCalls: ${JSON.stringify(styleChangeCalls)}`)
	assert.equal(armCalls.length, 0, `onArmStyle must not be called — armCalls: ${JSON.stringify(armCalls)}`)
	console.log('ok: selection + armed tool — selection wins (SetStyle); arming does not override')
}

// A geo selection's popovers render icon glyphs for every icon-able axis.
{
	const s = shape({ id: 'shape:g2', kind: 'geo', props: { geo: 'star', fill: 'pattern', dash: 'dotted', size: 'l', font: 'mono', align: 'end' } })
	const bySlot: ReadonlyArray<readonly [ToolbarSlotId, string]> = [
		['fill', 'fill'],
		['dash', 'dash'],
		['more', 'size'],
		['more', 'font'],
		['align', 'align'],
		['geo', 'geo'],
	]
	for (const [slot, axis] of bySlot) {
		const block = controlBlock(renderSelection([s], slot), axis)
		assert.ok(/<svg[ >]/.test(block) || /font-family/.test(block), `"${axis}" control renders an icon glyph, not just text — block: ${block}`)
	}
	console.log('ok: fill/dash/size/font/align/geo popover controls each render an icon glyph')
}

// Colour swatch hexes come from canvas-react's GEO_COLORS, all 13 exactly.
{
	const s = shape({ id: 'shape:n8', kind: 'note', props: { color: 'blue' } })
	const html = renderSelection([s], 'color')
	for (const [name, entry] of Object.entries(GEO_COLORS)) {
		const swatchMatch = html.match(new RegExp(`<button[^>]*data-style-value="${name}"[^>]*style="([^"]*)"`))
		assert.ok(swatchMatch, `"${name}" swatch renders — html: ${html}`)
		assert.ok(
			swatchMatch![1]!.toLowerCase().includes(`background:${entry.solid.toLowerCase()}`),
			`"${name}" swatch hex matches GEO_COLORS.${name}.solid (${entry.solid}) — style: ${swatchMatch![1]}`,
		)
	}
	console.log("ok: color swatches — every hex matches canvas-react's GEO_COLORS.solid table")
}

// The arrowheads popover offers all 9 values per end (incl. the model-only 'pipe'), as icons.
{
	const s = shape({ id: 'shape:a1', kind: 'arrow', props: { arrowheadStart: 'none', arrowheadEnd: 'arrow' } })
	const html = renderSelection([s], 'arrowheads')
	for (const axis of ['arrowheadStart', 'arrowheadEnd']) {
		const block = controlBlock(html, axis)
		for (const value of ['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none']) {
			assert.ok(block.includes(`data-style-value="${value}"`), `"${axis}" offers "${value}" — block: ${block}`)
		}
		assert.ok(/<svg[ >]/.test(block), `"${axis}" renders icon glyphs, not text — block: ${block}`)
	}
	console.log('ok: arrowhead pickers — all 9 values render as icon glyphs')
}

// ============================================================================
// Armed mode (empty selection, a style-bearing tool armed) and the empty case
// ============================================================================

// Empty selection AND no armed style-bearing tool: renders nothing.
{
	const html = renderToStaticMarkup(createElement(StylePanel, baseProps()))
	assert.equal(html, '', `empty selection, no armed style tool — renders nothing — html: ${html}`)
	console.log('ok: empty selection, select tool active — panel renders nothing')
}

// Armed geo tool, empty selection: the armed panel renders geo-relevant axes.
{
	const html = renderToStaticMarkup(createElement(StylePanel, { ...baseProps(), activeToolId: 'geo' }))
	assert.ok(html.includes('data-style-panel-mode="armed"'), `armed geo tool — panel renders in armed mode — html: ${html}`)
	for (const axis of ['color', 'fill', 'dash', 'geo']) {
		assert.ok(html.includes(`data-style-control="${axis}"`), `armed geo — ${axis} control renders — html: ${html}`)
	}
	console.log('ok: armed geo tool, empty selection — armed panel renders geo-relevant axes')
}

// Armed mode's blue swatch click calls onArmStyle — never onStyleChange.
{
	const armCalls: Array<{ axis: string; value: unknown }> = []
	const styleChangeCalls: Array<{ axis: string; value: unknown }> = []
	const tree = StylePanel({
		...baseProps(),
		activeToolId: 'geo',
		onStyleChange: (axis, value) => styleChangeCalls.push({ axis, value }),
		onArmStyle: (axis, value) => armCalls.push({ axis, value }),
	})
	const onClick = findStyleValueOnClick(tree, 'blue')
	assert.ok(onClick, `armed panel's blue color swatch has an onClick handler`)
	onClick!()
	assert.deepEqual(armCalls, [{ axis: 'color', value: 'blue' }], `armed click calls onArmStyle — armCalls: ${JSON.stringify(armCalls)}`)
	assert.equal(styleChangeCalls.length, 0, `armed click never calls onStyleChange — styleChangeCalls: ${JSON.stringify(styleChangeCalls)}`)
	console.log('ok: armed mode click calls onArmStyle (SetNextStyle), never onStyleChange (SetStyle)')
}

// Empty selection AND the hand tool: renders nothing.
{
	const html = renderToStaticMarkup(createElement(StylePanel, { ...baseProps(), activeToolId: 'hand' }))
	assert.equal(html, '', `empty selection, hand tool active — renders nothing — html: ${html}`)
	console.log('ok: empty selection, hand tool active — panel renders nothing')
}

// The armed panel reflects nextShapeStyle's current values, not the defaults.
{
	const html = renderToStaticMarkup(createElement(StylePanel, { ...baseProps(), activeToolId: 'geo', nextShapeStyle: { color: 'red' } }))
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

// A fresh armed mount (empty nextShapeStyle) shows the tool kind's real defaults.
{
	const html = renderToStaticMarkup(createElement(StylePanel, { ...baseProps(), activeToolId: 'geo' }))
	assert.ok(
		/data-style-value="black"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="black"/.test(html),
		`armed geo panel, nothing armed yet — color defaults to 'black' marked current — html: ${html}`,
	)
	assert.ok(
		/data-style-value="rectangle"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="rectangle"/.test(html),
		`armed geo panel, nothing armed yet — geo variant defaults to 'rectangle' marked current — html: ${html}`,
	)
	console.log("ok: armed panel — a fresh mount shows the tool kind's real defaults marked current")
}

console.log('ok: StylePanel — selection toolbar triggers/popover and armed-tool panel')
