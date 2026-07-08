/**
 * Focus view overlay (canvas-controls spec §7): lives in the InFrontOfTheCanvas
 * slot alongside ContextualStylePanel (see ui.tsx). Three concerns in one
 * component because they all key off the same `focusedShapeId`:
 *
 * 1. Enter affordance — a ⛶ button over a single selected focusable shape.
 * 2. Focused chrome — the dim matte (four strips around the shape's screen
 *    bounds) and the persistent exit button.
 * 3. Chord + self-healing — the capture-phase Ctrl/Cmd+Shift+Enter exit, and
 *    the effects that force an exit when focus would otherwise go stale
 *    (shape deleted, page navigated away, Present starts).
 *
 * Camera mechanics (enterFocus/exitFocus, the atom) live in ./focus — this
 * file is chrome only.
 */
import { useEffect, useRef, type CSSProperties } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import { wm } from '../theme'
import { enterFocus, exitFocus, FOCUSABLE_SHAPE_TYPES, useFocusedShapeId } from './focus'
import { useIsPresenting, usePresenter } from './present'

// Matches the mockups' paper matte (spec §7 / Task 1 design note).
const MATTE_COLOR = 'rgba(238,233,221,0.82)'

const buttonStyle: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	alignItems: 'center',
	gap: 6,
	padding: '4px 10px',
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 6,
	boxShadow: wm.shadowPaper,
	fontFamily: wm.sans,
	fontSize: 12,
	color: wm.ink,
	cursor: 'pointer',
	pointerEvents: 'auto',
	zIndex: 410,
}

interface ScreenRect {
	minX: number
	minY: number
	maxX: number
	maxY: number
}

function matteStripStyle(rect: ScreenRect): CSSProperties {
	return {
		position: 'absolute',
		left: rect.minX,
		top: rect.minY,
		width: Math.max(0, rect.maxX - rect.minX),
		height: Math.max(0, rect.maxY - rect.minY),
		background: MATTE_COLOR,
		// auto (not none): clicks/wheel on the matte must NOT reach the canvas
		// underneath, but must also NOT exit focus (see the matte div's own
		// comment below) — it just eats the input.
		pointerEvents: 'auto',
		zIndex: 400,
	}
}

export function FocusOverlay() {
	const editor = useEditor()
	const focusedShapeId = useFocusedShapeId()
	const isPresenting = useIsPresenting()
	const presenter = usePresenter(editor)
	// Present wins (see the self-healing effect below): while a Present
	// session is active — ours or someone else's — focus should neither be
	// enterable nor stay entered.
	const presentActive = isPresenting || !!presenter

	// --- 1. Enter affordance ------------------------------------------------
	// Exactly one selected shape, of a focusable type, no focus already
	// active, not mid-gesture (reusing ContextualStylePanel's pattern so the
	// button doesn't chase a drag/resize), and no Present session live.
	const midGesture = useValue(
		'focus mid gesture',
		() =>
			editor.isInAny(
				'select.translating',
				'select.resizing',
				'select.rotating',
				'select.brushing',
				'select.pointing_shape',
				'select.dragging_handle'
			),
		[editor]
	)
	const enterCandidate = useValue(
		'focus enter candidate',
		() => {
			if (focusedShapeId || presentActive) return null
			const ids = editor.getSelectedShapeIds()
			if (ids.length !== 1) return null
			const shape = editor.getShape(ids[0])
			if (!shape || !FOCUSABLE_SHAPE_TYPES.has(shape.type)) return null
			const bounds = editor.getSelectionRotatedScreenBounds()
			if (!bounds) return null
			return { id: shape.id, bounds }
		},
		[editor, focusedShapeId, presentActive]
	)

	// --- 2. Focused chrome ---------------------------------------------------
	// The shape's screen bounds, recomputed reactively off its page bounds so
	// panning/zooming (before the lock engages, or from a future non-locked
	// focus variant) keeps the matte glued to it.
	const focusedScreen = useValue(
		'focus screen bounds',
		() => {
			if (!focusedShapeId) return null
			const pageBounds = editor.getShapePageBounds(focusedShapeId)
			if (!pageBounds) return null
			const viewport = editor.getViewportScreenBounds()
			const topLeft = editor.pageToScreen({ x: pageBounds.minX, y: pageBounds.minY })
			const bottomRight = editor.pageToScreen({ x: pageBounds.maxX, y: pageBounds.maxY })
			return {
				shape: { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y },
				viewport: {
					minX: viewport.minX,
					minY: viewport.minY,
					maxX: viewport.maxX,
					maxY: viewport.maxY,
				},
			}
		},
		[editor, focusedShapeId]
	)

	// --- 3. Chord + self-healing ---------------------------------------------
	// Entered-page tracking: a ref (not state) because it's write-once per
	// focus session and only ever read inside the effect below, not rendered.
	const enteredPageIdRef = useRef<string | null>(null)
	useEffect(() => {
		if (focusedShapeId) enteredPageIdRef.current = editor.getCurrentPageId()
	}, [focusedShapeId, editor])

	const shapeMissing = useValue(
		'focus shape missing',
		() => !!focusedShapeId && !editor.getShape(focusedShapeId),
		[editor, focusedShapeId]
	)
	const currentPageId = useValue('focus current page id', () => editor.getCurrentPageId(), [editor])

	useEffect(() => {
		if (!focusedShapeId) return
		// Shape deleted out from under the focused view — nothing left to show.
		if (shapeMissing) {
			exitFocus(editor)
			return
		}
		// Navigated to a different page (e.g. via the side panel, which itself
		// also exits focus before switching — Task 2) — focus doesn't follow
		// across pages, so if this fires it's a belt-and-braces catch.
		if (enteredPageIdRef.current && currentPageId !== enteredPageIdRef.current) {
			exitFocus(editor)
			return
		}
		// Present wins: a locked, letterboxed single-terminal view and a
		// Present broadcast (which drives the viewport for a whole room, or
		// follows someone else's) are mutually exclusive chrome states. If
		// Present starts while focused — by us or by someone else — exit
		// focus first rather than leaving a stale lock fighting Present's own
		// camera control, or hiding the Present strip behind the matte.
		if (presentActive) {
			exitFocus(editor)
		}
	}, [focusedShapeId, shapeMissing, currentPageId, presentActive, editor])

	// Capture-phase so a focused xterm's own attachCustomKeyEventHandler (bound
	// to its hidden textarea, a target-phase listener) never gets a chance to
	// swallow the chord — see TerminalShapeUtil's keydown handling. Also
	// Cmd+Shift+Enter for Mac users.
	useEffect(() => {
		if (!focusedShapeId) return
		function onKeyDown(e: KeyboardEvent) {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
				e.preventDefault()
				e.stopPropagation()
				exitFocus(editor)
			}
		}
		window.addEventListener('keydown', onKeyDown, true)
		return () => window.removeEventListener('keydown', onKeyDown, true)
	}, [focusedShapeId, editor])

	if (focusedShapeId && focusedScreen) {
		const { shape, viewport } = focusedScreen
		return (
			<>
				<div
					data-testid="ew-focus-matte-top"
					onPointerDown={stopEventPropagation}
					style={matteStripStyle({ minX: viewport.minX, minY: viewport.minY, maxX: viewport.maxX, maxY: shape.minY })}
				/>
				<div
					data-testid="ew-focus-matte-bottom"
					onPointerDown={stopEventPropagation}
					style={matteStripStyle({ minX: viewport.minX, minY: shape.maxY, maxX: viewport.maxX, maxY: viewport.maxY })}
				/>
				<div
					data-testid="ew-focus-matte-left"
					onPointerDown={stopEventPropagation}
					style={matteStripStyle({ minX: viewport.minX, minY: shape.minY, maxX: shape.minX, maxY: shape.maxY })}
				/>
				<div
					data-testid="ew-focus-matte-right"
					onPointerDown={stopEventPropagation}
					style={matteStripStyle({ minX: shape.maxX, minY: shape.minY, maxX: viewport.maxX, maxY: shape.maxY })}
				/>
				<button
					type="button"
					data-testid="ew-focus-exit"
					title="Exit focus (Ctrl+Shift+Enter)"
					onPointerDown={stopEventPropagation}
					onClick={() => exitFocus(editor)}
					style={{ ...buttonStyle, right: 16, top: 16 }}
				>
					⛶ exit focus · Ctrl+⇧+⏎
				</button>
			</>
		)
	}

	if (enterCandidate && !midGesture) {
		const { bounds } = enterCandidate
		return (
			<button
				type="button"
				data-testid="ew-focus-enter"
				title="Focus terminal (fills the canvas)"
				onPointerDown={stopEventPropagation}
				onClick={() => enterFocus(editor, enterCandidate.id)}
				style={{
					...buttonStyle,
					padding: '4px 6px',
					left: bounds.maxX - 28,
					top: bounds.minY - 34,
				}}
			>
				⛶
			</button>
		)
	}

	return null
}
