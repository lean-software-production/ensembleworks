// Manual zoom controls: a horizontal pill of zoom-out / level-readout /
// zoom-in, matching Toolbar.tsx and StylePanel.tsx's styling conventions
// (UI_VARS-only colours, so a host that maps nothing still gets the web
// app's current look). Host-agnostic, logic-free chrome — every decision
// (what camera a click produces, which buttons are disabled) lives in
// zoom-controls-model.ts's pure functions; this file only renders their
// result and wires clicks to them.
import type { CSSProperties } from 'react'
import type { Camera } from '@ensembleworks/canvas-editor'
import { zoomControlDisabled, zoomControlIntent, zoomControlMetrics, type ZoomControlMetrics } from './zoom-controls-model.js'
import { prefersCoarsePointer } from './pointer-metrics.js'
import { UI_VARS } from './theme.js'

export interface ZoomControlsProps {
	readonly camera: Camera
	readonly viewportSize: { readonly width: number; readonly height: number }
	/** `SetCamera`; called with the already-computed next camera. */
	readonly onSetCamera: (camera: Camera) => void
	/** Merged over the pill's own container style — hosts use it for placement. */
	readonly style?: CSSProperties
	/** Is this device's PRIMARY pointer coarse (a finger)? Sizes the buttons to
	 * a ~44px touch target — see `zoomControlMetrics` for why a device query is
	 * the right signal for a rendered box, where the canvas's own hit tolerances
	 * deliberately use the per-event pointerType instead.
	 *
	 * A PROP, defaulted from `prefersCoarsePointer` (pointer-metrics.ts), for
	 * the reasons that module states. */
	readonly coarsePointer?: boolean
}



function containerStyle(metrics: ZoomControlMetrics): CSSProperties {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		gap: metrics.gap,
		boxSizing: 'border-box',
		padding: metrics.padding,
		borderRadius: 8,
		background: UI_VARS.panelBg,
		border: `1px solid ${UI_VARS.panelBorder}`,
	}
}

function buttonStyle(disabled: boolean, metrics: ZoomControlMetrics): CSSProperties {
	return {
		height: metrics.buttonSize,
		minWidth: metrics.buttonSize,
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

export function ZoomControls({ camera, viewportSize, onSetCamera, style, coarsePointer }: ZoomControlsProps) {
	const disabled = zoomControlDisabled(camera)
	const metrics = zoomControlMetrics(coarsePointer ?? prefersCoarsePointer())
	return (
		<div data-canvas-zoom-pill role="group" aria-label="Zoom controls" style={{ ...containerStyle(metrics), ...style }}>
			<button
				type="button"
				data-canvas-zoom="out"
				aria-label="Zoom out"
				disabled={disabled.out}
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'out'))}
				style={buttonStyle(disabled.out, metrics)}
			>
				−
			</button>
			<button
				type="button"
				data-canvas-zoom="reset"
				aria-label="Reset zoom to 100%"
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'reset'))}
				style={buttonStyle(false, metrics)}
			>
				{Math.round(camera.z * 100)}%
			</button>
			<button
				type="button"
				data-canvas-zoom="in"
				aria-label="Zoom in"
				disabled={disabled.in}
				onClick={() => onSetCamera(zoomControlIntent(camera, viewportSize, 'in'))}
				style={buttonStyle(disabled.in, metrics)}
			>
				+
			</button>
		</div>
	)
}
