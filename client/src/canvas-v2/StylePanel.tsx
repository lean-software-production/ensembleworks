// Task P2 (docs/plans/2026-07-21-canvas-v2-styling.md) — contextual style
// panel, mirroring v1's `client/src/chrome/ContextualStylePanel.tsx`: one
// component, anchored above the current selection's screen bounds, hidden
// mid-gesture so it never chases a drag. Reads P1's pure `relevantAxes` /
// `currentValue` helpers (style-axes.ts) to decide which controls to show
// and their value/'mixed' state; value-sets come from `STYLE_VALUE_SETS`
// (style-axes.ts, itself sourced from the model via Task M3 — never a
// second hand-typed copy of tldraw's palette).
//
// WIRED as of Task P4: every control's onClick calls the `onStyleChange`
// PROP, and CanvasV2Session (CanvasV2App.tsx) now mounts this with a real
// handler that dispatches `SetStyle` over the current selection — see that
// module's `buildSetStyleIntent`/`onStyleChange`. Task P2 landed this
// component with the prop deliberately unwired (a no-op at the mount site)
// so Task P3's browser contract had a clean RED (swatch renders, click did
// nothing -> the shape's stored style stayed unchanged) BEFORE P4's fix
// landed. This component still does not import the editor's apply/SetStyle
// machinery itself — it only ever calls the injected prop.
//
// Armed-tool / next-shape-style mode (nothing selected, a style-bearing tool
// armed) is Task AS3 — out of scope here; this component only ever reads a
// live SELECTION and renders nothing when it's empty.
import { type CSSProperties } from 'react'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { combinedWorldBounds } from '@ensembleworks/canvas-react'
import { currentValue, relevantAxes, STYLE_VALUE_SETS, type StyleAxis, type StyleValue } from './style-axes.js'

export interface StylePanelProps {
	readonly selection: ReadonlySet<string>
	readonly snapshot: CanvasDocument
	readonly camera: Camera
	readonly viewportSize: { readonly width: number; readonly height: number }
	/** Set on pointerdown, cleared on pointerup/cancel (CanvasV2Session) — the
	 * panel disappears entirely rather than trailing a live drag. */
	readonly isGesturing: boolean
	/** UNWIRED prop — see module header. The panel emits only kind-relevant
	 * props per axis; relevance lives here, the eventual intent stays dumb. */
	readonly onStyleChange: (axis: StyleAxis, value: StyleValue) => void
}

// Visual grouping (plan: "color row, fill/dash, size/font, align"), extended
// to the remaining axes. A group whose axes are ALL irrelevant to the current
// selection renders nothing — see `renderGroups` below, which filters each
// group down to the axes `relevantAxes` actually returned.
const AXIS_GROUPS: readonly (readonly StyleAxis[])[] = [
	['color'],
	['fill', 'dash'],
	['size', 'font'],
	['align', 'verticalAlign', 'textAlign'],
	['geo'],
	['arrowheadStart', 'arrowheadEnd'],
	['opacity'],
]

const AXIS_LABELS: Record<StyleAxis, string> = {
	color: 'Color',
	fill: 'Fill',
	dash: 'Dash',
	size: 'Size',
	font: 'Font',
	align: 'Align',
	verticalAlign: 'Vertical align',
	textAlign: 'Text align',
	geo: 'Shape',
	arrowheadStart: 'Arrow start',
	arrowheadEnd: 'Arrow end',
	opacity: 'Opacity',
}

// Approximate swatch hues for the color axis — chosen for visual distinction
// between named colors, NOT a verified match to tldraw's exact palette (the
// model's COLOR enum, not this map, is the validity source of truth; a wrong
// hex here is a cosmetic miss, never a write-boundary risk).
const COLOR_SWATCH_HEX: Record<string, string> = {
	black: '#1d1d1d',
	grey: '#9fa8b3',
	'light-violet': '#e085f4',
	violet: '#ae3ec9',
	blue: '#4465e9',
	'light-blue': '#4fa9e8',
	yellow: '#f1ac00',
	orange: '#e8590c',
	green: '#099268',
	'light-green': '#66c96f',
	'light-red': '#f87777',
	red: '#e03131',
	white: '#f8f9fa',
}

/** kebab-case value -> "Title Case" display label ('x-box' -> 'X Box'). */
function humanize(value: string): string {
	return value
		.split('-')
		.map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
		.join(' ')
}

// Bounded so `clampPanelPosition`'s edge-clamp math (below) has a GUARANTEED
// upper bound to clamp against — the real DOM node's rendered width can never
// exceed this CSS `maxWidth`, regardless of content, so clamping the panel's
// CENTER to keep a PANEL_MAX_WIDTH-wide box on-screen is always sufficient
// for the (possibly narrower) real box too. A selection whose relevant axes
// span most of the groups (e.g. two geo shapes: color/fill/dash/size/font/
// align/verticalAlign/geo) has enough buttons to lay out past 1000px wide
// with NO cap at all — not just a cosmetic clip: Task P3's browser contract
// clicks a specific swatch by DOM selector via a raw mouse-move-to-
// coordinate (no Playwright visibility check), so a bounding-box that lands
// off-screen makes the click miss the button entirely and silently land on
// nothing (empirically reproduced: an unbounded panel for this exact
// two-geo-shape selection measured 1030px wide, left edge at x:-265).
// `flexWrap` on ROW_GROUP_STYLE below is what lets a group's columns
// actually wrap once this cap makes them not fit.
//
// REVIEW FIX: capping the WIDTH alone is not sufficient on its own — see
// `clampPanelPosition`'s doc comment (and the comment just above its
// definition, near PANEL_FLIP_HEADROOM) for the anchor-vs-edge clamp bug
// this cap used to be paired with (a P4 first pass clamped only the anchor
// point, which still let a wide-but-bounded panel spill off-screen).
const PANEL_MAX_WIDTH = 320
// Bounds panel HEIGHT the same way PANEL_MAX_WIDTH bounds width — see that
// constant's doc comment. `overflowY: 'auto'` on PANEL_STYLE below is the
// safety net for a selection with an unusually large union of relevant axis
// groups (e.g. a MIXED geo+arrow+text selection could show nearly every
// group at once) that would otherwise need more room than this cap allows —
// it scrolls internally rather than silently exceeding the bound
// `clampPanelPosition` relies on. 480 comfortably covers the tallest
// observed case today (a 2-geo-shape selection — 8 relevant groups —
// measured 434px after the width fix above).
const PANEL_MAX_HEIGHT = 480

const PANEL_STYLE: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	flexDirection: 'column',
	gap: 8,
	padding: '8px 10px',
	background: '#fafaf7',
	border: '1px solid rgba(15,23,42,0.14)',
	borderRadius: 8,
	boxShadow: '0 2px 10px rgba(15,23,42,0.18)',
	fontFamily: 'system-ui, sans-serif',
	fontSize: 11,
	color: '#0f172a',
	pointerEvents: 'all',
	zIndex: 500,
	minWidth: 160,
	maxWidth: PANEL_MAX_WIDTH,
	maxHeight: PANEL_MAX_HEIGHT,
	overflowY: 'auto',
}

// `flexWrap: 'wrap'` (not the previous no-wrap default) — see PANEL_MAX_WIDTH's
// doc comment: this is what lets a group's own axis-columns drop onto a new
// line once PANEL_STYLE's cap makes them not fit on one, instead of forcing
// the panel wider than its cap (which `maxWidth` alone cannot prevent for a
// non-wrapping flex row of intrinsically-sized children).
const ROW_GROUP_STYLE: CSSProperties = { display: 'flex', gap: 14, flexWrap: 'wrap' }
const ROW_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const ROW_LABEL_STYLE: CSSProperties = { fontSize: 10, color: '#475569', fontWeight: 600, letterSpacing: 0.2 }
const ROW_VALUES_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }

// tldraw's own opacity control offers five discrete steps (Decisions §
// Parity value-sets, "opacity") — style-axes.ts's STYLE_VALUE_SETS.opacity
// carries the same five, so this reads that instead of re-typing them.
const OPACITY_VALUES = STYLE_VALUE_SETS.opacity

function swatchButtonStyle(current: boolean): CSSProperties {
	return {
		width: 20,
		height: 20,
		borderRadius: '50%',
		border: current ? '2px solid #004990' : '1px solid rgba(15,23,42,0.25)',
		boxShadow: current ? '0 0 0 1px #fafaf7 inset' : undefined,
		cursor: 'pointer',
		padding: 0,
	}
}

function segButtonStyle(current: boolean): CSSProperties {
	return {
		padding: '2px 7px',
		borderRadius: 4,
		border: current ? '1px solid #004990' : '1px solid rgba(15,23,42,0.22)',
		background: current ? '#004990' : 'transparent',
		color: current ? '#fafaf7' : '#0f172a',
		fontSize: 10,
		cursor: 'pointer',
	}
}

interface AxisRowProps {
	readonly axis: StyleAxis
	readonly shapes: readonly Shape[]
	readonly onStyleChange: (axis: StyleAxis, value: StyleValue) => void
}

/** One labeled row: the axis's value-set rendered as swatches (color) or
 * segmented buttons (everything else), current value marked, 'mixed' shown
 * distinctly rather than defaulting to (wrongly) marking one value current. */
function AxisRow({ axis, shapes, onStyleChange }: AxisRowProps) {
	const value = currentValue(shapes, axis)
	const mixed = value === 'mixed'

	if (axis === 'opacity') {
		const numeric = typeof value === 'number' ? value : undefined
		return (
			<div style={ROW_STYLE} data-style-control="opacity" data-style-mixed={mixed ? 'true' : undefined}>
				<span style={ROW_LABEL_STYLE}>{AXIS_LABELS.opacity}{mixed ? ' — mixed' : ''}</span>
				<div style={ROW_VALUES_STYLE}>
					{OPACITY_VALUES.map((v) => (
						<button
							key={v}
							type="button"
							data-style-value={v}
							aria-pressed={!mixed && numeric === v}
							data-current={!mixed && numeric === v ? 'true' : undefined}
							title={`${Math.round(v * 100)}%`}
							style={segButtonStyle(!mixed && numeric === v)}
							onClick={() => onStyleChange('opacity', v)}
						>
							{Math.round(v * 100)}
						</button>
					))}
				</div>
			</div>
		)
	}

	const values = STYLE_VALUE_SETS[axis]
	return (
		<div style={ROW_STYLE} data-style-control={axis} data-style-mixed={mixed ? 'true' : undefined}>
			<span style={ROW_LABEL_STYLE}>{AXIS_LABELS[axis]}{mixed ? ' — mixed' : ''}</span>
			<div style={ROW_VALUES_STYLE}>
				{values.map((v) => {
					const isCurrent = !mixed && value === v
					return axis === 'color' ? (
						<button
							key={v}
							type="button"
							data-style-value={v}
							aria-pressed={isCurrent}
							data-current={isCurrent ? 'true' : undefined}
							title={humanize(v)}
							style={{ ...swatchButtonStyle(isCurrent), background: COLOR_SWATCH_HEX[v] ?? '#94a3b8' }}
							onClick={() => onStyleChange(axis, v)}
						/>
					) : (
						<button
							key={v}
							type="button"
							data-style-value={v}
							aria-pressed={isCurrent}
							data-current={isCurrent ? 'true' : undefined}
							title={humanize(v)}
							style={segButtonStyle(isCurrent)}
							onClick={() => onStyleChange(axis, v)}
						>
							{humanize(v)}
						</button>
					)
				})}
			</div>
		</div>
	)
}

// DefaultStylePanel-sized headroom guess (v1's PANEL_FLIP_HEADROOM, same
// idea): below this much room above the selection, drop the panel below it
// instead of clipping off the top of the viewport.
const PANEL_FLIP_HEADROOM = 220
const MARGIN = 8
// REVIEW FIX (post-P4): P4's first pass clamped only the panel's ANCHOR
// point to a fixed [90, W-90] range before centering it with
// `translateX(-50%)`. That's insufficient once the panel's own half-width
// exceeds that 90px margin — PANEL_MAX_WIDTH/2 is 160 > 90, so an anchor
// 90px from the edge still centered a panel whose real edge landed up to
// 70px past the viewport boundary (empirically reproduced: left=90 ->
// rendered edges [-70, 250] for a 320px panel in a 1280px viewport — pinned
// by StylePanel.position.test.ts). `clampPanelPosition` below replaces that
// fixed-margin anchor clamp with a proper EDGE clamp (bounds the panel's
// actual left/right/top/bottom against `panelSize`, not just its center
// point) — see that function's own doc comment for the corrected,
// actually-true on-screen guarantee.

export interface PanelPosition {
	readonly left: number
	readonly top: number
	readonly transform: string
}

function clampRange(value: number, min: number, max: number): number {
	// Degenerate case: the available span (max - min) is narrower than the
	// panel itself — e.g. a viewport thinner than PANEL_MAX_WIDTH. There is no
	// on-screen placement that satisfies both bounds; centering in the
	// available range is the least-bad fallback (matches this file's other
	// "defensive, not the expected path" fallbacks).
	if (min > max) return (min + max) / 2
	return Math.min(Math.max(value, min), max)
}

/**
 * Pure positioning math (no DOM/model access — `computePosition` below
 * resolves the selection's SCREEN-space corners and delegates here). Given
 * those corners, the viewport size, and the panel's MAXIMUM rendered size
 * (`panelSize` — PANEL_MAX_WIDTH/PANEL_MAX_HEIGHT below, the actual CSS caps
 * on `PANEL_STYLE`, so the real DOM node is GUARANTEED never to exceed this,
 * regardless of content), returns a `{left, top, transform}` CSS position
 * whose real on-screen box — after the `transform` is applied — stays within
 * `[margin, viewportSize.{width,height} - margin]` on BOTH axes.
 *
 * This clamps the panel's ACTUAL EDGES, not just its anchor point (the bug
 * this replaces — see the comment just above this function's definition): a
 * `translateX(-50%)`-centered panel's real left/right edges are
 * `center ∓ panelSize.width/2`, so keeping the CENTER within
 * `[panelSize.width/2 + margin, viewportWidth - panelSize.width/2 - margin]`
 * is what actually keeps those edges on-screen — a plain anchor clamp with a
 * fixed margin smaller than half the panel's width cannot, no matter what
 * that margin is set to. Same reasoning vertically: the "below" placement's
 * `top` is a literal top edge (clamped against `[margin, viewportHeight -
 * panelSize.height - margin]`); the "above" placement's `top` is the panel's
 * BOTTOM edge under `translate(-50%, -100%)` (clamped against
 * `[panelSize.height + margin, viewportHeight - margin]` so the resulting
 * TOP edge, `bottom - panelSize.height`, stays >= margin).
 */
export function clampPanelPosition(
	c1: { readonly x: number; readonly y: number },
	c2: { readonly x: number; readonly y: number },
	viewportSize: { readonly width: number; readonly height: number },
	panelSize: { readonly width: number; readonly height: number },
	margin: number,
	flipHeadroom: number,
): PanelPosition {
	const halfW = panelSize.width / 2
	const midX = clampRange((c1.x + c2.x) / 2, halfW + margin, viewportSize.width - halfW - margin)
	const minY = Math.min(c1.y, c2.y)
	const maxY = Math.max(c1.y, c2.y)
	if (minY < flipHeadroom) {
		const top = clampRange(maxY + margin, margin, viewportSize.height - panelSize.height - margin)
		return { left: midX, top, transform: 'translateX(-50%)' }
	}
	const bottom = clampRange(minY - margin, panelSize.height + margin, viewportSize.height - margin)
	return { left: midX, top: bottom, transform: 'translate(-50%, -100%)' }
}

function computePosition(
	snapshot: CanvasDocument,
	selection: ReadonlySet<string>,
	camera: Camera,
	viewportSize: { readonly width: number; readonly height: number },
): CSSProperties {
	const bounds = combinedWorldBounds(snapshot, selection)
	if (!bounds) {
		// Selection resolved to no live shape's bounds (unusual — relevantAxes
		// already returned a non-empty axis list, so this is a defensive
		// fallback, not the expected path): anchor near the top center.
		return { left: viewportSize.width / 2, top: MARGIN, transform: 'translateX(-50%)' }
	}
	const c1 = worldToScreen(camera, { x: bounds.minX, y: bounds.minY })
	const c2 = worldToScreen(camera, { x: bounds.maxX, y: bounds.maxY })
	return clampPanelPosition(c1, c2, viewportSize, { width: PANEL_MAX_WIDTH, height: PANEL_MAX_HEIGHT }, MARGIN, PANEL_FLIP_HEADROOM)
}

function stopPropagation(e: { stopPropagation(): void }): void {
	e.stopPropagation()
}

/**
 * Contextual selection style panel (Task P2). Renders nothing when there's
 * no live selection with at least one style-relevant axis, or mid-gesture.
 * `onPointerDown`/`onPointerUp` stop propagation so a click on a control
 * never reaches Viewport's own pointer handling (canvas-react/src/
 * Viewport.tsx) and gets misread as the start of a canvas gesture —
 * mirrors v1 ContextualStylePanel's `stopEventPropagation` wrapping, using a
 * local helper since this package may not import tldraw.
 */
export function StylePanel({ selection, snapshot, camera, viewportSize, isGesturing, onStyleChange }: StylePanelProps) {
	if (isGesturing) return null

	const shapes: Shape[] = []
	for (const id of selection) {
		const shape = snapshot.byId.get(id)
		if (shape) shapes.push(shape)
	}
	const axes = new Set(relevantAxes(shapes))
	if (axes.size === 0) return null

	const position = computePosition(snapshot, selection, camera, viewportSize)
	const groups = AXIS_GROUPS.map((group) => group.filter((axis) => axes.has(axis))).filter((group) => group.length > 0)

	return (
		<div
			data-testid="ew-style-panel"
			data-canvas-v2-style-panel
			onPointerDown={stopPropagation}
			onPointerUp={stopPropagation}
			style={{ ...PANEL_STYLE, ...position }}
		>
			{groups.map((group) => (
				<div key={group.join('-')} style={ROW_GROUP_STYLE}>
					{group.map((axis) => (
						<AxisRow key={axis} axis={axis} shapes={shapes} onStyleChange={onStyleChange} />
					))}
				</div>
			))}
		</div>
	)
}
