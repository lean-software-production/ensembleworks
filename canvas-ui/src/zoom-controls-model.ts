// Pure decision logic for the manual zoom controls (ZoomControls.tsx):
// which camera a click produces, and which buttons are disabled. Kept out of
// the component so the host-agnostic chrome file stays close to markup only,
// and so this logic is testable without a DOM emulator (there is none in
// this package — see toolbar.test.ts's header for the same reasoning).
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP_FACTOR, zoomAboutPoint, zoomToLevelAbout, type Camera } from '@ensembleworks/canvas-editor'

export type ZoomControlAction = 'in' | 'out' | 'reset'

/** The viewport's centre in screen px — the fixed point every zoom-control
 * click zooms about, so a button click never drifts the visible content
 * off-centre the way a corner-anchored zoom would. */
export function viewportCentre(viewportSize: { readonly width: number; readonly height: number }): { readonly x: number; readonly y: number } {
	return { x: viewportSize.width / 2, y: viewportSize.height / 2 }
}

/** The camera a zoom-control click produces. 'in'/'out' step by
 * ZOOM_STEP_FACTOR about the viewport centre; 'reset' sets the ABSOLUTE
 * level to 1 (100%) about the same point, via zoomToLevelAbout rather than a
 * factor computed from the current z — a control that always means "go to
 * 100%", not "halve however-zoomed-in-I-am". */
export function zoomControlIntent(
	camera: Camera,
	viewportSize: { readonly width: number; readonly height: number },
	action: ZoomControlAction,
): Camera {
	const centre = viewportCentre(viewportSize)
	switch (action) {
		case 'in':
			return zoomAboutPoint(camera, centre, ZOOM_STEP_FACTOR)
		case 'out':
			return zoomAboutPoint(camera, centre, 1 / ZOOM_STEP_FACTOR)
		case 'reset':
			return zoomToLevelAbout(camera, centre, 1)
	}
}

export interface ZoomControlDisabled {
	readonly in: boolean
	readonly out: boolean
}

/** Which of the in/out buttons are at their end of the [MIN_ZOOM, MAX_ZOOM]
 * range already — clicking further would be a no-op, so the control is
 * disabled rather than silently doing nothing. 'reset' is never disabled: at
 * z===1 it is a harmless no-op click, and the readout still functions as a
 * label. */
export function zoomControlDisabled(camera: Camera): ZoomControlDisabled {
	return { in: camera.z >= MAX_ZOOM, out: camera.z <= MIN_ZOOM }
}

/** The zoom pill's button box, in CSS px, for a fine or a coarse pointer
 * (mobile-touch task, scope 3).
 *
 * 28 IS UNDER HALF A FINGER. The pill's buttons were a flat 28x28 — fine for a
 * cursor, and well under the ~44px the platform guidance asks for (Apple HIG
 * 44pt, Material 48dp, WCAG 2.5.5's 44x44 CSS px). They are also the ONLY
 * zoom affordance a touch user had before pinch existed, and they sit in a
 * corner, where a miss lands on the canvas and starts a marquee.
 *
 * A DEVICE QUERY IS THE RIGHT SIGNAL HERE, unlike the canvas's per-event hit
 * tolerances (canvas-editor's `hitTolerancePx`/`bbthreadDividerMargin`, which
 * deliberately refuse one): a rendered box has to have ONE size, chosen before
 * any pointer arrives, so there is no event to read. `(pointer: coarse)` — the
 * PRIMARY pointer — is the best available answer, and its known failure is a
 * touchscreen laptop, where the mouse user gets finger-sized buttons. That is
 * the harmless direction of the error.
 *
 * Pure and parameterised rather than a `matchMedia` call inside the component,
 * for the reason this whole module exists: a number written in the .tsx is a
 * decision no test in this package can read (there is no DOM emulator here). */
export interface ZoomControlMetrics {
	readonly buttonSize: number
	readonly gap: number
	readonly padding: number
}

export const FINE_ZOOM_BUTTON_PX = 28
export const COARSE_ZOOM_BUTTON_PX = 44

export function zoomControlMetrics(coarsePointer: boolean): ZoomControlMetrics {
	return coarsePointer
		? { buttonSize: COARSE_ZOOM_BUTTON_PX, gap: 4, padding: 4 }
		: { buttonSize: FINE_ZOOM_BUTTON_PX, gap: 2, padding: 4 }
}
