// Run: bun src/toolbar.test.ts
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { COARSE_TARGET_PX } from './pointer-metrics.js'
import { FINE_TOOL_BUTTON_PX, Toolbar, TOOL_ORDER } from './Toolbar.js'
import { ArmedStyleFlyout, armedValue } from './ArmedStyleFlyout.js'

/** The opening tag of the first element carrying `attr`. */
function openingTag(markup: string, attr: string): string {
	const at = markup.indexOf(attr)
	assert.ok(at >= 0, `an element with ${attr} renders — html: ${markup}`)
	return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1)
}

const isCurrent = (markup: string, value: string) =>
	new RegExp(`data-style-value="${value}"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="${value}"`).test(markup)

interface ElementLike {
	readonly type?: unknown
	readonly props?: Record<string, unknown>
}

/** First host element whose props satisfy `match`, expanding hook-free
 * function components so a real onClick is reachable (renderToStaticMarkup
 * drops handlers). */
function findElement(node: unknown, match: (props: Record<string, unknown>) => boolean): ElementLike | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, match)
			if (found) return found
		}
		return undefined
	}
	if (node === null || typeof node !== 'object') return undefined
	const el = node as ElementLike
	if (typeof el.type === 'function') return findElement((el.type as (p: Record<string, unknown>) => unknown)(el.props ?? {}), match)
	if (!el.props) return undefined
	if (typeof el.type === 'string' && match(el.props)) return el
	return findElement(el.props['children'], match)
}

const html = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'note', onSelectTool: () => {} }))

assert.deepEqual(TOOL_ORDER.map((t) => t.id), ['select', 'hand', 'note', 'text', 'geo', 'frame', 'arrow', 'draw', 'line'])
assert.ok(html.includes('role="toolbar"'), 'the toolbar is an ARIA toolbar')
for (const { id } of TOOL_ORDER) {
  assert.ok(html.includes(`data-canvas-tool="${id}"`), `renders a button for ${id}`)
}
assert.match(html, /data-canvas-tool="note"[^>]*aria-pressed="true"/, 'the active tool is pressed')
assert.match(html, /data-canvas-tool="select"[^>]*aria-pressed="false"/, 'inactive tools are not pressed')
assert.ok(html.includes('title="Note (N)"'), 'tooltip names the shortcut letter')
assert.ok(html.includes('title="Shape (R)"'), 'geo shows its first shortcut letter')
assert.equal((html.match(/<svg/g) ?? []).length, 9, 'every button renders an icon')
assert.ok(!/>\s*Note\s*</.test(html), 'buttons show icons, not text labels')
console.log('ok: Toolbar renders nine icon buttons with pressed state and shortcut tooltips')

// ============================================================================
// Vertical rail + armed flyout
// ============================================================================

const railHtml = renderToStaticMarkup(
	createElement(Toolbar, { activeToolId: 'geo', onSelectTool: () => {}, orientation: 'vertical', nextShapeStyle: { color: 'blue' }, onArmStyle: () => {} }),
)
assert.match(railHtml, /data-canvas-toolbar[^>]*aria-orientation="vertical"/, 'rail declares vertical orientation')
assert.match(railHtml, /data-canvas-toolbar[^>]*flex-direction:column/, 'rail stacks buttons')
assert.ok(railHtml.includes('data-style-panel-mode="armed"'), 'armed flyout renders for a style-bearing tool')
assert.match(railHtml, /data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/, 'flyout shows the armed value')
assert.ok(railHtml.includes('data-style-control="geo"') && railHtml.includes('data-style-control="dash"'), 'flyout shows every axis expanded')
assert.ok(!railHtml.includes('data-style-control="opacity"'), 'flyout omits opacity')
assert.ok(railHtml.indexOf('data-canvas-tool="geo"') < railHtml.indexOf('data-style-panel-mode="armed"'), 'flyout is attached to the active tool button')

const selectHtml = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'select', onSelectTool: () => {}, orientation: 'vertical', nextShapeStyle: {}, onArmStyle: () => {} }))
assert.ok(!selectHtml.includes('data-style-panel-mode="armed"'), 'no flyout for select')
assert.ok(!html.includes('data-style-panel-mode="armed"'), 'no flyout when the host passes no onArmStyle')
console.log('ok: vertical rail with an armed flyout beside the active style tool')

// A horizontal toolbar renders no flyout: both hosts show armed style on the rail.
{
	const topHtml = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'note', onSelectTool: () => {}, nextShapeStyle: {}, onArmStyle: () => {} }))
	assert.match(topHtml, /data-canvas-toolbar[^>]*aria-orientation="horizontal"/, 'toolbar defaults to horizontal')
	assert.ok(!topHtml.includes('data-style-panel-mode="armed"'), `horizontal toolbar renders no flyout — html: ${topHtml}`)
	console.log('ok: horizontal toolbar renders no flyout')
}

// The rail's flyout stays inside the host: centred on the rail (which hosts
// centre vertically), capped to the host's height, scrolling past that.
{
	const card = openingTag(railHtml, 'data-style-panel-mode="armed"')
	assert.match(card, /left:calc\(100% \+ 10px\);top:50%;transform:translateY\(-50%\)/, `flyout opens beside the rail, centred on it — ${card}`)
	assert.match(card, /max-height:calc\(100cqh - 24px\)/, `flyout height is capped to the host — ${card}`)
	assert.match(card, /overflow-y:auto/, `a capped flyout scrolls — ${card}`)
	const geoWrapper = railHtml.slice(railHtml.lastIndexOf('<div', railHtml.indexOf('data-canvas-tool="geo"')), railHtml.indexOf('data-canvas-tool="geo"'))
	assert.ok(!geoWrapper.includes('position:relative'), `the button wrapper is not the flyout's containing block — ${geoWrapper}`)
	console.log('ok: rail flyout is centred on the rail and capped to the host height')
}

// A rail taller than its host scrolls its buttons instead of pushing tools
// off-edge. The scroller is unpositioned, so the flyout (contained by the
// rail itself) is never clipped by it.
{
	const container = openingTag(railHtml, 'data-canvas-toolbar')
	assert.match(container, /position:relative/, `the rail is the flyout's containing block — ${container}`)
	assert.match(container, /min-height:0/, `the rail can shrink to a host max-height — ${container}`)
	const scroller = openingTag(railHtml, 'data-canvas-toolbar-scroller')
	assert.match(scroller, /min-height:0/, `the scroller can shrink — ${scroller}`)
	assert.match(scroller, /overflow-y:auto/, `the scroller scrolls — ${scroller}`)
	assert.ok(!scroller.includes('position:'), `the scroller is not positioned, so it cannot clip the flyout — ${scroller}`)
	assert.ok(railHtml.indexOf('data-canvas-toolbar-scroller') < railHtml.indexOf('data-canvas-tool="select"'), 'buttons live in the scroller')
	console.log('ok: a tall rail scrolls its buttons without clipping the flyout')
}

// Frame arms only opacity, which the flyout omits: no empty card.
{
	const frameHtml = renderToStaticMarkup(createElement(ArmedStyleFlyout, { toolId: 'frame', nextShapeStyle: {}, onArmStyle: () => {} }))
	assert.equal(frameHtml, '', `frame renders no flyout — html: ${frameHtml}`)
	console.log('ok: a tool with no non-opacity axis renders no flyout')
}

// The flyout reflects nextShapeStyle's values, not the defaults.
{
	const flyHtml = renderToStaticMarkup(createElement(ArmedStyleFlyout, { toolId: 'geo', nextShapeStyle: { color: 'red' }, onArmStyle: () => {} }))
	assert.ok(isCurrent(flyHtml, 'red'), `armed nextShapeStyle.color:'red' is marked current — html: ${flyHtml}`)
	assert.ok(!isCurrent(flyHtml, 'blue'), `flyout does not ALSO mark blue current — html: ${flyHtml}`)
	console.log('ok: flyout — nextShapeStyle.color:red is marked current, not a default')
}

// A fresh flyout (empty nextShapeStyle) shows the tool kind's real defaults.
{
	const flyHtml = renderToStaticMarkup(createElement(ArmedStyleFlyout, { toolId: 'geo', nextShapeStyle: {}, onArmStyle: () => {} }))
	assert.ok(isCurrent(flyHtml, 'black'), `color defaults to 'black' marked current — html: ${flyHtml}`)
	assert.ok(isCurrent(flyHtml, 'rectangle'), `geo variant defaults to 'rectangle' marked current — html: ${flyHtml}`)
	assert.equal(armedValue({}, 'geo', 'color'), 'black')
	assert.equal(armedValue({ color: 'red' }, 'geo', 'color'), 'red')
	assert.equal(armedValue({}, 'select', 'color'), undefined)
	console.log("ok: flyout — a fresh mount shows the tool kind's real defaults marked current")
}

// A flyout swatch click calls onArmStyle (SetNextStyle).
{
	const armCalls: Array<{ axis: string; value: unknown }> = []
	const tree = ArmedStyleFlyout({ toolId: 'geo', nextShapeStyle: {}, onArmStyle: (axis, value) => armCalls.push({ axis, value }) })
	const swatch = findElement(tree, (p) => p['data-style-value'] === 'blue')
	const onClick = swatch?.props?.['onClick'] as (() => void) | undefined
	assert.ok(onClick, `flyout's blue color swatch has an onClick handler`)
	onClick!()
	assert.deepEqual(armCalls, [{ axis: 'color', value: 'blue' }], `flyout click calls onArmStyle — armCalls: ${JSON.stringify(armCalls)}`)
	console.log('ok: flyout click calls onArmStyle')
}

// The card takes pointers (it sits beside the rail, over the canvas edge).
{
	assert.match(openingTag(railHtml, 'data-style-panel-mode="armed"'), /pointer-events:auto/)
	console.log('ok: flyout card takes pointers')
}

// ---------------------------------------------------------------------------
// FINGER-SIZED TOOL BUTTONS (mobile-touch task, scope 3). The rail is the
// most-tapped chrome on the canvas and its buttons were a flat 32px — under
// three quarters of a fingertip, and a miss lands on the canvas behind it.
{
	const coarse = renderToStaticMarkup(
		createElement(Toolbar, { activeToolId: 'select' as const, onSelectTool: () => {}, coarsePointer: true }),
	)
	const fine = renderToStaticMarkup(
		createElement(Toolbar, { activeToolId: 'select' as const, onSelectTool: () => {}, coarsePointer: false }),
	)
	// ABSOLUTE on both sides: "coarse is bigger" would survive a retune to 34px,
	// which is still not a touch target.
	assert.equal(COARSE_TARGET_PX, 44, 'the shared touch target is 44px')
	assert.equal(FINE_TOOL_BUTTON_PX, 32, 'a fine pointer keeps the 32px rail button')
	assert.match(coarse, /data-canvas-tool="select"[^>]*style="[^"]*width:44px/, 'the coarse rail renders 44px buttons')
	assert.match(fine, /data-canvas-tool="select"[^>]*style="[^"]*width:32px/, 'the fine rail renders 32px buttons')
	assert.ok(!fine.includes('width:44px'), 'a fine pointer never gets the touch size')
	// The rail already scrolls when it outgrows its host, which is what makes
	// the taller buttons safe on a short viewport — pinned so a later tidy-up
	// of the scroller style cannot quietly push tools off the edge instead.
	const coarseRail = renderToStaticMarkup(
		createElement(Toolbar, { activeToolId: 'select' as const, onSelectTool: () => {}, orientation: 'vertical' as const, coarsePointer: true }),
	)
	assert.match(coarseRail, /overflow-y:auto/, 'the vertical rail still scrolls rather than clipping its tools')
}
console.log('ok: Toolbar buttons reach a 44px touch target on a coarse pointer')
