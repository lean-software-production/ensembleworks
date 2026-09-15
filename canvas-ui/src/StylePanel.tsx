// Selection style chrome for the canvas: a one-row toolbar anchored to the
// selection's screen bounds. `toolbarSlots` (canvas-editor) decides which
// triggers show; each trigger's face shows the slot's current value, and the
// open slot (`openSlot`, owned by the host) renders a popover of `AxisRow`
// value controls. A value click calls `onStyleChange` (-> `SetStyle`).
// Next-shape (armed) style lives beside the tool toolbar (ArmedStyleFlyout).
//
// Hidden entirely mid-gesture so it never chases a drag. Stays hook-free:
// StylePanel.test.ts calls it as a plain function to reach real onClicks.
import { type CSSProperties, type ReactNode } from 'react'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import {
	currentValue,
	toolbarSlots,
	worldToScreen,
	type Camera,
	type StyleValue,
	type ToolbarSlot,
	type ToolbarSlotId,
} from '@ensembleworks/canvas-editor'
import { combinedWorldBounds } from '@ensembleworks/canvas-react'
import { AXIS_LABELS, AxisRow, axisIcon, colorSwatchHex, humanize, ICON_BUTTON_PX, SWATCH_GAP_PX, SWATCH_PX, type StyleChange } from './style-controls.js'
import { FontIcon } from './style-icons.js'
import { UI_VARS } from './theme.js'

export interface StylePanelProps {
	readonly selection: ReadonlySet<string>
	readonly snapshot: CanvasDocument
	readonly camera: Camera
	readonly viewportSize: { readonly width: number; readonly height: number }
	/** Set on pointerdown, cleared on pointerup/cancel — the panel disappears
	 * rather than trailing a live drag. */
	readonly isGesturing: boolean
	/** `SetStyle` over the selection (and next-shape style
	 * memory unless `options.onlySelection`, i.e. Ctrl/Cmd held). */
	readonly onStyleChange: StyleChange
	/** The selection toolbar slot whose popover is open. Host-owned so it can
	 * close on Escape, outside click or selection change. */
	readonly openSlot: ToolbarSlotId | null
	readonly onOpenSlotChange: (slot: ToolbarSlotId | null) => void
}

const MARGIN = 8

// ---------------------------------------------------------------------------
// Positioning (pure)
// ---------------------------------------------------------------------------

export interface PanelPosition {
	readonly left: number
	readonly top: number
	readonly transform: string
}

function clampRange(value: number, min: number, max: number): number {
	// No placement satisfies both bounds (viewport narrower than the box):
	// centre in the available range as the least-bad fallback.
	if (min > max) return (min + max) / 2
	return Math.min(Math.max(value, min), max)
}

/**
 * Places a box of at most `panelSize` centred on the selection, below it when
 * there is less than `flipHeadroom` above, otherwise above it. Clamps the
 * box's real edges (after `transform`), not just its anchor, so the whole box
 * stays within `margin` of the viewport. For the "above" placement `top` is
 * the box's bottom edge (`translate(-50%, -100%)`).
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

/**
 * Post-processes `clampPanelPosition` so the box never overlaps the selection:
 * an edge clamp that pulled it onto the selection would let chrome eat clicks
 * meant for the shape. Moves the box back to the selection's edge (flipping
 * to the roomier side) and returns the `maxHeight` left on that side.
 */
export function avoidAnchorOverlap(
	position: PanelPosition,
	c1: { readonly x: number; readonly y: number },
	c2: { readonly x: number; readonly y: number },
	viewportSize: { readonly width: number; readonly height: number },
	margin: number,
): PanelPosition & { readonly maxHeight?: number } {
	const minY = Math.min(c1.y, c2.y)
	const maxY = Math.max(c1.y, c2.y)
	const idealTop = maxY + margin
	const belowRoom = Math.max(0, viewportSize.height - idealTop - margin)
	const idealBottom = minY - margin
	const aboveRoom = Math.max(0, idealBottom - margin)

	if (position.transform === 'translateX(-50%)') {
		if (position.top >= idealTop) return position
		if (aboveRoom > belowRoom) {
			return { ...position, top: idealBottom, transform: 'translate(-50%, -100%)', maxHeight: aboveRoom }
		}
		return { ...position, top: idealTop, maxHeight: belowRoom }
	}
	if (position.top <= idealBottom) return position
	if (belowRoom > aboveRoom) {
		return { ...position, top: idealTop, transform: 'translateX(-50%)', maxHeight: belowRoom }
	}
	return { ...position, top: idealBottom, maxHeight: aboveRoom }
}

/** Where a popover opens for a trigger on the bar: centred on the trigger, on
 * the bar's side away from the selection. It never crosses back over the bar
 * (which would bury the bar and the selection under clickable controls): when
 * that side is short, `maxHeight` caps it to the room left. Returns the
 * top-left and height budget of the popover's box. */
export function popoverPosition(
	bar: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
	trigger: { readonly left: number; readonly width: number },
	popover: { readonly width: number; readonly height: number },
	viewport: { readonly width: number; readonly height: number },
	side: 'above' | 'below',
	margin: number,
): { left: number; top: number; maxHeight: number } {
	const centre = trigger.left + trigger.width / 2
	const left = clampRange(centre - popover.width / 2, margin, viewport.width - popover.width - margin)
	if (side === 'below') {
		const top = bar.top + bar.height + margin
		return { left, top, maxHeight: Math.max(0, Math.min(popover.height, viewport.height - margin - top)) }
	}
	const bottom = bar.top - margin
	const maxHeight = Math.max(0, Math.min(popover.height, bottom - margin))
	return { left, top: bottom - maxHeight, maxHeight }
}

// ---------------------------------------------------------------------------
// Selection toolbar
// ---------------------------------------------------------------------------

// Fixed trigger geometry lets the bar's width and each trigger's offset be
// computed without DOM measurement, so positioning stays pure and static.
const BAR_BORDER_PX = 1
const BAR_PADDING_PX = 4
const TRIGGER_WIDTH_PX = 32
const TRIGGER_HEIGHT_PX = 30
const BAR_GAP_PX = 2
const TRIGGER_STEP_PX = TRIGGER_WIDTH_PX + BAR_GAP_PX // 34
const DIVIDER_PX = 1
const BAR_HEIGHT = 2 * BAR_BORDER_PX + 2 * BAR_PADDING_PX + TRIGGER_HEIGHT_PX // 40
// Widest layout is geo's six slots.
const BAR_MAX_WIDTH = 6 * TRIGGER_STEP_PX + 12
// 220 tall: the arrow `more` popover stacks four labelled rows.
const POPOVER_MAX = { width: 200, height: 220 } as const
// Room needed above the selection for the bar plus a popover opening above it.
const BAR_FLIP_HEADROOM = BAR_HEIGHT + POPOVER_MAX.height + 3 * MARGIN

const dividerWidth = (slots: readonly ToolbarSlot[]) => (slots.some((s) => s.id === 'more') ? DIVIDER_PX + BAR_GAP_PX : 0)

function barWidth(slots: readonly ToolbarSlot[]): number {
	return 2 * (BAR_BORDER_PX + BAR_PADDING_PX) + slots.length * TRIGGER_STEP_PX - BAR_GAP_PX + dividerWidth(slots)
}

/** A trigger's left edge within the bar; `more` sits after the divider. */
function triggerOffset(slots: readonly ToolbarSlot[], index: number): number {
	const divider = slots[index]!.id === 'more' ? dividerWidth(slots) : 0
	return BAR_BORDER_PX + BAR_PADDING_PX + index * TRIGGER_STEP_PX + divider
}

const WRAPPER_STYLE: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' }

// Containers are pointer-events:none so chrome sitting over the selection
// never eats a drag/double-click/delete aimed at the shape; only controls opt
// back in. Pointer events on a control still bubble to the wrapper's
// stopPropagation (CSS pointer-events affects hit-testing, not propagation),
// which keeps control clicks from reaching Viewport as canvas gestures.
const CARD_STYLE: CSSProperties = {
	position: 'absolute',
	background: UI_VARS.panelBg,
	border: `${BAR_BORDER_PX}px solid ${UI_VARS.panelBorder}`,
	borderRadius: 10,
	boxShadow: UI_VARS.shadow,
	color: UI_VARS.panelFg,
	fontFamily: 'system-ui, sans-serif',
	fontSize: 11,
	pointerEvents: 'none',
	zIndex: 500,
	boxSizing: 'border-box',
}

const BAR_STYLE: CSSProperties = {
	...CARD_STYLE,
	display: 'flex',
	flexDirection: 'row',
	alignItems: 'center',
	gap: BAR_GAP_PX,
	padding: BAR_PADDING_PX,
	height: BAR_HEIGHT,
	whiteSpace: 'nowrap',
}

const POPOVER_PADDING_PX = 8
const POPOVER_STYLE: CSSProperties = {
	...CARD_STYLE,
	display: 'flex',
	flexDirection: 'column',
	gap: 8,
	padding: POPOVER_PADDING_PX,
	// max-content keeps a popover near the viewport's right edge from being
	// squeezed by its containing block.
	width: 'max-content',
	maxWidth: POPOVER_MAX.width,
	maxHeight: POPOVER_MAX.height,
	overflowY: 'auto',
}

// Fixed widths set swatches/icons per line for the big single-axis value sets
// (6 colours, 5 geo shapes); +2 absorbs sub-pixel rounding.
const POPOVER_CHROME_PX = 2 * (POPOVER_PADDING_PX + BAR_BORDER_PX) + 2
const POPOVER_WIDTH_BY_SLOT: Partial<Record<ToolbarSlotId, number>> = {
	color: 6 * SWATCH_PX + 5 * SWATCH_GAP_PX + POPOVER_CHROME_PX,
	geo: 5 * ICON_BUTTON_PX + 4 * SWATCH_GAP_PX + POPOVER_CHROME_PX,
}

const DIVIDER_STYLE: CSSProperties = { width: DIVIDER_PX, alignSelf: 'stretch', background: UI_VARS.panelBorder, flexShrink: 0 }

function triggerStyle(open: boolean): CSSProperties {
	return {
		width: TRIGGER_WIDTH_PX,
		height: TRIGGER_HEIGHT_PX,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 0,
		border: 'none',
		borderRadius: 6,
		background: open ? UI_VARS.accentSoft : 'transparent',
		color: open ? UI_VARS.accent : UI_VARS.panelFg,
		fontFamily: 'inherit',
		fontSize: 12,
		fontWeight: 600,
		cursor: 'pointer',
		pointerEvents: 'auto',
	}
}

const MIXED_COLOR_SWATCH = `conic-gradient(${colorSwatchHex('red')} 0 25%, ${colorSwatchHex('yellow')} 0 50%, ${colorSwatchHex('green')} 0 75%, ${colorSwatchHex('blue')} 0)`

function SwatchFace({ background }: { readonly background: string }) {
	return (
		<span
			style={{ width: 18, height: 18, borderRadius: '50%', background, border: `1px solid ${UI_VARS.swatchBorder}`, boxSizing: 'border-box', display: 'inline-block' }}
		/>
	)
}

function MoreIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<circle cx={3} cy={8} r={1.5} />
			<circle cx={8} cy={8} r={1.5} />
			<circle cx={13} cy={8} r={1.5} />
		</svg>
	)
}

function triggerFace(slot: ToolbarSlot, value: StyleValue | 'mixed' | undefined): ReactNode {
	if (slot.id === 'more') return <MoreIcon />
	const axis = slot.axes[0]!
	if (axis === 'color') return <SwatchFace background={value === 'mixed' ? MIXED_COLOR_SWATCH : colorSwatchHex(String(value ?? ''))} />
	if (value === 'mixed') return '–'
	if (value === undefined) return null
	const v = String(value)
	if (axis === 'size') return v.toUpperCase()
	if (axis === 'font') return <FontIcon variant={v} />
	return axisIcon(axis, v)
}

function triggerTitle(slot: ToolbarSlot, value: StyleValue | 'mixed' | undefined): string {
	if (slot.id === 'more') return 'More styles'
	const label = AXIS_LABELS[slot.axes[0]!]
	return value === undefined ? label : `${label}: ${humanize(String(value))}`
}

/** The bar's top-left in screen space and which side of the selection it sits on. */
function computeBarBox(
	snapshot: CanvasDocument,
	selection: ReadonlySet<string>,
	camera: Camera,
	viewportSize: { readonly width: number; readonly height: number },
	width: number,
): { readonly left: number; readonly top: number; readonly side: 'above' | 'below' } {
	const bounds = combinedWorldBounds(snapshot, selection)
	if (!bounds) {
		// Defensive: slots resolved but no live bounds — anchor top-centre.
		return { left: viewportSize.width / 2 - width / 2, top: MARGIN, side: 'below' }
	}
	const c1 = worldToScreen(camera, { x: bounds.minX, y: bounds.minY })
	const c2 = worldToScreen(camera, { x: bounds.maxX, y: bounds.maxY })
	const clamped = clampPanelPosition(c1, c2, viewportSize, { width: BAR_MAX_WIDTH, height: BAR_HEIGHT }, MARGIN, BAR_FLIP_HEADROOM)
	const position = avoidAnchorOverlap(clamped, c1, c2, viewportSize, MARGIN)
	const side = position.transform === 'translate(-50%, -100%)' ? 'above' : 'below'
	return { left: position.left - width / 2, top: side === 'above' ? position.top - BAR_HEIGHT : position.top, side }
}

function stopPropagation(e: { stopPropagation(): void }): void {
	e.stopPropagation()
}

export function StylePanel({
	selection,
	snapshot,
	camera,
	viewportSize,
	isGesturing,
	onStyleChange,
	openSlot,
	onOpenSlotChange,
}: StylePanelProps) {
	if (isGesturing || selection.size === 0) return null

	const shapes: Shape[] = []
	for (const id of selection) {
		const shape = snapshot.byId.get(id)
		if (shape) shapes.push(shape)
	}
	const slots = toolbarSlots(shapes.map((s) => s.kind))
	if (slots.length === 0) return null

	const width = barWidth(slots)
	const bar = computeBarBox(snapshot, selection, camera, viewportSize, width)
	const openIndex = slots.findIndex((s) => s.id === openSlot)
	const open = openIndex >= 0 ? slots[openIndex]! : undefined

	let popover: ReactNode = null
	if (open) {
		const pos = popoverPosition(
			{ left: bar.left, top: bar.top, width, height: BAR_HEIGHT },
			{ left: bar.left + triggerOffset(slots, openIndex), width: TRIGGER_WIDTH_PX },
			POPOVER_MAX,
			viewportSize,
			bar.side,
			MARGIN,
		)
		// The real, usually shorter card hugs the bar-side edge of its box so it
		// stays by its trigger; overflowY makes a capped height real.
		const placement: CSSProperties = {
			left: pos.left + POPOVER_MAX.width / 2,
			top: bar.side === 'above' ? pos.top + pos.maxHeight : pos.top,
			transform: bar.side === 'above' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
			maxHeight: pos.maxHeight,
		}
		const fixedWidth = POPOVER_WIDTH_BY_SLOT[open.id]
		popover = (
			<div data-style-popover={open.id} style={{ ...POPOVER_STYLE, ...placement, ...(fixedWidth ? { width: fixedWidth } : {}) }}>
				{open.axes.map((axis) => (
					<AxisRow key={axis} axis={axis} value={currentValue(shapes, axis)} onStyleChange={onStyleChange} showLabel={open.axes.length > 1} />
				))}
			</div>
		)
	}

	return (
		<div
			data-testid="ew-style-panel"
			data-canvas-v2-style-panel
			data-style-panel-mode="selection"
			onPointerDown={stopPropagation}
			onPointerUp={stopPropagation}
			onKeyDown={(e) => {
				if (e.key !== 'Escape' || openSlot === null) return
				// Stop here so neither the Viewport nor the session's document listener
				// treats this Escape as a canvas cancel.
				e.stopPropagation()
				e.preventDefault()
				// Focus goes back to the trigger rather than the unmounting popover.
				// Scoped to this panel so two canvases on one page never cross-focus.
				e.currentTarget.querySelector<HTMLElement>(`[data-style-trigger="${openSlot}"]`)?.focus()
				onOpenSlotChange(null)
			}}
			style={WRAPPER_STYLE}
		>
			<div style={{ ...BAR_STYLE, left: bar.left, top: bar.top, width }}>
				{slots.flatMap((slot) => {
					const value = slot.id === 'more' ? undefined : currentValue(shapes, slot.axes[0]!)
					const isOpen = openSlot === slot.id
					const title = triggerTitle(slot, value)
					const trigger = (
						<button
							key={slot.id}
							type="button"
							data-style-trigger={slot.id}
							aria-haspopup="true"
							aria-expanded={isOpen}
							data-style-mixed={value === 'mixed' ? 'true' : undefined}
							title={title}
							aria-label={title}
							style={triggerStyle(isOpen)}
							onClick={() => onOpenSlotChange(isOpen ? null : slot.id)}
						>
							{triggerFace(slot, value)}
						</button>
					)
					return slot.id === 'more' ? [<div key="divider" style={DIVIDER_STYLE} />, trigger] : [trigger]
				})}
			</div>
			{popover}
		</div>
	)
}
