// Manual zoom controls: a horizontal pill of zoom-out / level-readout /
// zoom-in, matching Toolbar.tsx and StylePanel.tsx's styling conventions
// (UI_VARS-only colours, so a host that maps nothing still gets the web
// app's current look). Host-agnostic, logic-free chrome — every decision
// (what camera a click produces, which buttons are disabled) lives in
// zoom-controls-model.ts's pure functions; this file only renders their
// result and wires clicks to them.
import type { CSSProperties } from 'react'
import type { Camera } from '@ensembleworks/canvas-editor'
import { zoomControlDisabled, zoomControlIntent } from './zoom-controls-model.js'
import { UI_VARS } from './theme.js'

export interface ZoomControlsProps {
	readonly camera: Camera
	readonly viewportSize: { readonly width: number; readonly height: number }
	/** `SetCamera`; called with the already-computed next camera. */
	readonly onSetCamera: (camera: Camera) => void
	/** Merged over the pill's own container style — hosts use it for placement. */
	readonly style?: CSSProperties
}

const containerStyle: CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: 2,
	boxSizing: 'border-box',
	padding: 4,
	borderRadius: 8,
	background: UI_VARS.panelBg,
	border: `1px solid ${UI_VARS.panelBorder}`,
}

function buttonStyle(disabled: boolean): CSSProperties {
	return {
		height: 28,
		minWidth: 28,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '0 6px',
		borderRadius: 6,
		border: 'none',
		cursor: disabled ? 'default' : 'pointer',
		opacity: disabled ? 0.4 : 1,
		background: 'transparent',
		color: UI_VARS.panelFg,
		font: 'inherit',
		fontSize: 12,
		fontVariantNumeric: 'tabular-nums',
	}
}

export function ZoomControls({ camera, viewportSize, onSetCamera, style }: ZoomControlsProps) {
	const disabled = zoomControlDisabled(camera)
	return (
		<div data-canvas-zoom-pill role="group" aria-label="Zoom controls" style={{ ...containerStyle, ...style }}>
			<button
				type="button"
				data-canvas-zoom="out"
				aria-label="Zoom out"
				disabled={disabled.out}
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'out'))}
				style={buttonStyle(disabled.out)}
			>
				−
			</button>
			<button
				type="button"
				data-canvas-zoom="reset"
				aria-label="Reset zoom to 100%"
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'reset'))}
				style={buttonStyle(false)}
			>
				{Math.round(camera.z * 100)}%
			</button>
			<button
				type="button"
				data-canvas-zoom="in"
				aria-label="Zoom in"
				disabled={disabled.in}
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'in'))}
				style={buttonStyle(disabled.in)}
			>
				+
			</button>
		</div>
	)
}
