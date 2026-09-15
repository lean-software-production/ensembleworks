// Value controls for one style axis: colour swatches, icon buttons and the
// opacity stops. Shared by the selection toolbar's popovers and the armed
// panel; each control only ever calls the injected `onStyleChange`.
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { STYLE_VALUE_SETS, type StyleAxis, type StyleValue } from '@ensembleworks/canvas-editor'
import { GEO_COLORS } from '@ensembleworks/canvas-react'
import { AlignIcon, ArrowheadIcon, DashIcon, FillIcon, FontIcon, GeoIcon, SizeIcon } from './style-icons.js'
import { UI_VARS } from './theme.js'

export const AXIS_LABELS: Record<StyleAxis, string> = {
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

/** Swatch hue for a `color` value, read from the table shapes are painted
 * with so the swatch can never drift from the rendered colour. */
export function colorSwatchHex(value: string): string {
	return GEO_COLORS[value]?.solid ?? '#94a3b8'
}

/** kebab-case value -> "Title Case" display label ('x-box' -> 'X Box'). */
export function humanize(value: string): string {
	return value
		.split('-')
		.map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
		.join(' ')
}

export type StyleChange = (axis: StyleAxis, value: StyleValue, options?: { readonly onlySelection: boolean }) => void

const ROW_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const ROW_LABEL_STYLE: CSSProperties = { fontSize: 10, color: UI_VARS.panelMuted, fontWeight: 600, letterSpacing: 0.2 }

export const SWATCH_PX = 20
export const SWATCH_GAP_PX = 4
const ROW_VALUES_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: SWATCH_GAP_PX }

const OPACITY_VALUES = STYLE_VALUE_SETS.opacity

// Controls opt back in to hit-testing; their containers are pointer-events:none
// so empty chrome never eats a canvas gesture.
function swatchButtonStyle(current: boolean): CSSProperties {
	return {
		width: SWATCH_PX,
		height: SWATCH_PX,
		borderRadius: '50%',
		border: current ? `2px solid ${UI_VARS.accent}` : `1px solid ${UI_VARS.swatchBorder}`,
		boxShadow: current ? `0 0 0 1px ${UI_VARS.panelBg} inset` : undefined,
		cursor: 'pointer',
		padding: 0,
		pointerEvents: 'auto',
	}
}

export const ICON_BUTTON_PX = 24
function segButtonStyle(current: boolean): CSSProperties {
	return {
		width: ICON_BUTTON_PX,
		height: ICON_BUTTON_PX,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 0,
		borderRadius: 4,
		border: current ? `1px solid ${UI_VARS.accent}` : `1px solid ${UI_VARS.controlBorder}`,
		background: current ? UI_VARS.accentSoft : 'transparent',
		color: current ? UI_VARS.accent : UI_VARS.panelFg,
		cursor: 'pointer',
		pointerEvents: 'auto',
	}
}

/** The icon glyph for an icon-able axis/value pair; `color` and `opacity`
 * render their own controls and return null here. */
export function axisIcon(axis: StyleAxis, value: string): ReactNode {
	switch (axis) {
		case 'fill':
			return <FillIcon variant={value} />
		case 'dash':
			return <DashIcon variant={value} />
		case 'size':
			return <SizeIcon variant={value} />
		case 'font':
			return <FontIcon variant={value} />
		case 'align':
		case 'textAlign':
		case 'verticalAlign':
			return <AlignIcon axis={axis} variant={value} />
		case 'geo':
			return <GeoIcon variant={value} />
		case 'arrowheadStart':
		case 'arrowheadEnd':
			return <ArrowheadIcon variant={value} />
		default:
			return null
	}
}

// Opacity: discrete click-to-select stops drawn as a slider track. A mixed
// selection marks no stop current.
const OPACITY_TRACK_STYLE: CSSProperties = {
	position: 'relative',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	width: 130,
	height: ICON_BUTTON_PX,
}
const OPACITY_LINE_STYLE: CSSProperties = {
	position: 'absolute',
	left: 4,
	right: 4,
	top: '50%',
	height: 2,
	background: UI_VARS.controlBorder,
	transform: 'translateY(-50%)',
	pointerEvents: 'none',
}
// The visible dot stays small; padding keeps the hit target 20px.
const OPACITY_STOP_HIT_PX = 20
function opacityStopStyle(current: boolean): CSSProperties {
	const dot = current ? 14 : 8
	return {
		position: 'relative',
		width: OPACITY_STOP_HIT_PX,
		height: OPACITY_STOP_HIT_PX,
		borderRadius: '50%',
		border: 'none',
		background: current ? UI_VARS.accent : UI_VARS.stopInactive,
		backgroundClip: 'content-box',
		padding: (OPACITY_STOP_HIT_PX - dot) / 2,
		boxSizing: 'border-box',
		cursor: 'pointer',
		pointerEvents: 'auto',
	}
}

export interface AxisRowProps {
	readonly axis: StyleAxis
	/** Resolved by the caller; armed callers never pass 'mixed'. */
	readonly value: StyleValue | 'mixed' | undefined
	/** `onlySelection` mirrors Ctrl/Cmd on the click ("this shape only"). */
	readonly onStyleChange: StyleChange
	/** Hide the axis label (a single-axis popover is already named by its trigger). */
	readonly showLabel?: boolean
}

/** One axis's value set, current value marked, 'mixed' shown distinctly
 * rather than wrongly marking one value current. */
export function AxisRow({ axis, value, onStyleChange, showLabel = true }: AxisRowProps): ReactElement {
	const mixed = value === 'mixed'

	if (axis === 'opacity') {
		const numeric = typeof value === 'number' ? value : undefined
		return (
			<div style={ROW_STYLE} data-style-control="opacity" data-style-mixed={mixed ? 'true' : undefined}>
				{showLabel && (
					<span style={ROW_LABEL_STYLE}>
						{AXIS_LABELS.opacity}
						{mixed ? ' — mixed' : numeric !== undefined ? ` — ${Math.round(numeric * 100)}%` : ''}
					</span>
				)}
				<div style={OPACITY_TRACK_STYLE}>
					<div style={OPACITY_LINE_STYLE} />
					{OPACITY_VALUES.map((v) => {
						const isCurrent = !mixed && numeric === v
						return (
							<button
								key={v}
								type="button"
								data-style-value={v}
								aria-pressed={isCurrent}
								data-current={isCurrent ? 'true' : undefined}
								aria-label={`${Math.round(v * 100)}%`}
								title={`${Math.round(v * 100)}%`}
								style={opacityStopStyle(isCurrent)}
								onClick={(e) => onStyleChange('opacity', v, { onlySelection: Boolean(e?.ctrlKey || e?.metaKey) })}
							/>
						)
					})}
				</div>
			</div>
		)
	}

	const values = STYLE_VALUE_SETS[axis]
	return (
		<div style={ROW_STYLE} data-style-control={axis} data-style-mixed={mixed ? 'true' : undefined}>
			{showLabel && (
				<span style={ROW_LABEL_STYLE}>
					{AXIS_LABELS[axis]}
					{mixed ? ' — mixed' : ''}
				</span>
			)}
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
							aria-label={humanize(v)}
							style={{ ...swatchButtonStyle(isCurrent), background: colorSwatchHex(v) }}
							onClick={(e) => onStyleChange(axis, v, { onlySelection: Boolean(e?.ctrlKey || e?.metaKey) })}
						/>
					) : (
						<button
							key={v}
							type="button"
							data-style-value={v}
							aria-pressed={isCurrent}
							data-current={isCurrent ? 'true' : undefined}
							title={humanize(v)}
							aria-label={humanize(v)}
							style={segButtonStyle(isCurrent)}
							onClick={(e) => onStyleChange(axis, v, { onlySelection: Boolean(e?.ctrlKey || e?.metaKey) })}
						>
							{axisIcon(axis, v)}
						</button>
					)
				})}
			</div>
		</div>
	)
}
