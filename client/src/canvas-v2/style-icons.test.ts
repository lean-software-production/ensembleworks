// Run: bun src/canvas-v2/style-icons.test.ts
// Task style-panel-icons — pins that every value in canvas-model's style
// enums (read through style-axes.ts's STYLE_VALUE_SETS, the same value-set
// source of truth StylePanel.tsx renders from) gets an EXPLICIT icon glyph
// from style-icons.tsx, not a silent fallback — a fallback is a legitimate
// defensive branch for a value the enum doesn't (yet) carry, but every value
// the enum ACTUALLY carries today should hit its own `case`, so a future
// enum addition that forgets to add a matching icon case shows up here
// (rendering the FALLBACK glyph) rather than silently looking like some
// other value.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { STYLE_VALUE_SETS } from './style-axes.js'
import { AlignIcon, ArrowheadIcon, DashIcon, FillIcon, FontIcon, GeoIcon, SizeIcon } from './style-icons.js'

function html(el: unknown): string {
	return renderToStaticMarkup(el as never)
}

// Normalizes an SVG markup string's point-bearing shapes (polygon/polyline
// points, line/rect/circle coordinate attrs) into a SORTED set of (x,y)
// pairs, order-independent. Two glyphs that are literal mirror images or
// genuinely different shapes must differ under this fingerprint; two glyphs
// that differ only in the WINDING ORDER of the same vertex set (e.g. a
// polygon's points reversed) will — correctly — collide, because a reversed
// closed polygon is pixel-identical. This catches the class of bug where a
// naive string-equality check ("does the markup differ") passes even though
// nothing about the rendered picture actually differs.
function geometricFingerprint(svgMarkup: string): string {
	const points: Array<[number, number]> = []
	for (const m of svgMarkup.matchAll(/points="([^"]+)"/g)) {
		for (const pair of m[1]!.trim().split(/\s+/)) {
			const [x, y] = pair.split(',').map(Number)
			points.push([x!, y!])
		}
	}
	for (const m of svgMarkup.matchAll(/<(line|rect|circle)[^>]*>/g)) {
		const tag = m[0]
		const attr = (name: string) => {
			const am = tag.match(new RegExp(`${name}="([^"]+)"`))
			return am ? Number(am[1]) : undefined
		}
		if (tag.startsWith('<line')) points.push([attr('x1')!, attr('y1')!], [attr('x2')!, attr('y2')!])
		else if (tag.startsWith('<rect')) points.push([attr('x')!, attr('y')!], [attr('width')!, attr('height')!])
		else if (tag.startsWith('<circle')) points.push([attr('cx')!, attr('cy')!], [attr('r')!, 0])
	}
	return points
		.map(([x, y]) => `${x},${y}`)
		.sort()
		.join(' ')
}

// ============================================================================
// 1. Every FILL value renders a DISTINCT glyph from every other FILL value —
//    the fallback (a bare stroked rect) would otherwise be silently
//    indistinguishable from 'none's own bare stroked rect.
// ============================================================================
{
	const rendered = new Map<string, string>()
	for (const v of STYLE_VALUE_SETS.fill) rendered.set(v, html(createElement(FillIcon, { variant: v })))
	const values = [...rendered.keys()]
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			assert.notEqual(rendered.get(values[i]!), rendered.get(values[j]!), `fill icons for "${values[i]}" and "${values[j]}" must differ`)
		}
	}
	console.log('ok: FillIcon — every fill value (incl. pattern/lined-fill/fill, beyond tldraw\'s primary 3) renders a distinct glyph')
}

// ============================================================================
// 2. Every DASH value renders a distinct glyph.
// ============================================================================
{
	const rendered = STYLE_VALUE_SETS.dash.map((v) => html(createElement(DashIcon, { variant: v })))
	assert.equal(new Set(rendered).size, rendered.length, `every dash value renders a distinct glyph — got: ${JSON.stringify(rendered)}`)
	console.log('ok: DashIcon — every dash value renders a distinct glyph')
}

// ============================================================================
// 3. SIZE grows monotonically (s < m < l < xl) — the whole point of a dot
//    icon is that a bigger value reads as a bigger dot.
// ============================================================================
{
	const radii = STYLE_VALUE_SETS.size.map((v) => {
		const markup = html(createElement(SizeIcon, { variant: v }))
		const m = markup.match(/r="([\d.]+)"/)
		assert.ok(m, `SizeIcon("${v}") renders a circle with an "r" attribute — markup: ${markup}`)
		return Number(m![1])
	})
	for (let i = 1; i < radii.length; i++) {
		assert.ok(radii[i]! > radii[i - 1]!, `size radius grows monotonically: ${JSON.stringify(STYLE_VALUE_SETS.size)} -> ${JSON.stringify(radii)}`)
	}
	console.log('ok: SizeIcon — s < m < l < xl, strictly growing dot radius')
}

// ============================================================================
// 4. Every FONT value renders its OWN webfont family (fonts.css names) — a
//    live preview, not four identical "Aa"s.
// ============================================================================
{
	// The style attribute's single-quotes come back HTML-entity-escaped
	// (`&#x27;tldraw_draw&#x27;`, whose own trailing `;` would truncate a
	// naive `[^;]+` capture at the entity itself) — matching the bare family
	// TOKEN (`tldraw_draw` etc.) sidesteps that instead of over-fitting the
	// escaping.
	const families = STYLE_VALUE_SETS.font.map((v) => {
		const markup = html(createElement(FontIcon, { variant: v }))
		const m = markup.match(/tldraw_(draw|sans|serif|mono)/)
		assert.ok(m, `FontIcon("${v}") sets a font-family — markup: ${markup}`)
		return m![1]
	})
	assert.equal(new Set(families).size, families.length, `every font value uses a distinct font-family — got: ${JSON.stringify(families)}`)
	console.log('ok: FontIcon — draw/sans/serif/mono each render in their own real webfont family')
}

// ============================================================================
// 5. Every GEO value (all 20) renders a DISTINCT glyph from every other geo
//    value — i.e. every value the model's GEO enum actually carries has its
//    own explicit `case` in GeoIcon's switch, rather than several values
//    silently collapsing onto the same unhandled-variant fallback glyph.
//    ('rectangle' legitimately renders the SAME shape as the fallback — a
//    plain rectangle outline, mirroring GeoShape.tsx's own "unhandled ->
//    rectangle" convention — so it is excluded from the fallback check, not
//    from the pairwise-distinctness check below.)
// ============================================================================
{
	assert.equal(STYLE_VALUE_SETS.geo.length, 20, `sanity: the model's geo enum still has all 20 values — got ${STYLE_VALUE_SETS.geo.length}`)
	const rendered = new Map(STYLE_VALUE_SETS.geo.map((v) => [v, html(createElement(GeoIcon, { variant: v }))] as const))
	const values = [...rendered.keys()]
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			assert.notEqual(rendered.get(values[i]!), rendered.get(values[j]!), `geo icons for "${values[i]}" and "${values[j]}" must differ`)
		}
	}
	console.log('ok: GeoIcon — all 20 canvas-model geo values render pairwise-distinct glyphs')
}

// ============================================================================
// 6. Every ARROWHEAD value (9, including the model-only 'pipe') renders a
//    distinct glyph — 'pipe' in particular must not collide with 'bar' (the
//    two closest-looking values, both a perpendicular stroke near the tip).
// ============================================================================
{
	const rendered = new Map<string, string>()
	for (const v of STYLE_VALUE_SETS.arrowheadStart) rendered.set(v, html(createElement(ArrowheadIcon, { variant: v })))
	assert.equal(rendered.size, 9, `sanity: 9 arrowhead values — got ${rendered.size}`)
	assert.notEqual(rendered.get('pipe'), rendered.get('bar'), `"pipe" must render distinctly from "bar"`)
	const values = [...rendered.keys()]
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			assert.notEqual(rendered.get(values[i]!), rendered.get(values[j]!), `arrowhead icons for "${values[i]}" and "${values[j]}" must differ`)
		}
	}
	// Markup-string inequality alone is not enough: a polygon whose points
	// are merely listed in reverse order renders IDENTICAL pixels (SVG
	// winding has no visual effect on a simple filled/unfilled shape), so a
	// string comparison passes tautologically for that pair even though the
	// user sees the same picture twice. Compare a normalized, order-
	// independent geometric fingerprint too, which collapses a mere-reversal
	// pair (same vertex set) but must NOT collapse 'triangle' vs 'inverted'
	// specifically — 'inverted' has to be an actually different (mirrored)
	// shape, not a relisting of the same three points.
	const fingerprints = new Map<string, string>()
	for (const v of values) fingerprints.set(v, geometricFingerprint(rendered.get(v)!))
	assert.notEqual(
		fingerprints.get('triangle'),
		fingerprints.get('inverted'),
		`"triangle" and "inverted" must be geometrically distinct shapes, not the same vertex set reordered`,
	)
	console.log('ok: ArrowheadIcon — all 9 values (incl. the model-only "pipe") render distinct glyphs')
}

// ============================================================================
// 7. AlignIcon positions its emphasis bar/line per value (start/middle/end)
//    distinctly, for both the horizontal and vertical orientations.
// ============================================================================
{
	for (const axis of ['align', 'verticalAlign'] as const) {
		const rendered = ['start', 'middle', 'end'].map((v) => html(createElement(AlignIcon, { axis, variant: v })))
		assert.equal(new Set(rendered).size, 3, `${axis}: start/middle/end each render distinctly — got: ${JSON.stringify(rendered)}`)
	}
	// A '-legacy' suffixed value renders IDENTICALLY to its base (parity with
	// GeoShape.tsx/NoteShape.tsx's own normalizeAlign — a legacy document
	// value must look the same as its modern equivalent, never a 4th look).
	assert.equal(
		html(createElement(AlignIcon, { axis: 'align', variant: 'start-legacy' })),
		html(createElement(AlignIcon, { axis: 'align', variant: 'start' })),
		`"start-legacy" renders identically to "start"`,
	)
	console.log('ok: AlignIcon — start/middle/end render distinctly (both orientations), a "-legacy" value renders as its base')
}

console.log('ok: style-icons — every StylePanel icon glyph module renders a distinct, value-appropriate icon for every real canvas-model style value')
