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
import { useMidGesture } from './useMidGesture'

// Estimated on-screen width of the ⛶ enter button (padding '4px 6px' + one
// glyph + border) — used only to clamp its left edge inside the viewport
// (Fix 2 below); doesn't need to be exact, just wide enough that the clamp
// never lets the button's right edge slip past the window.
const ENTER_BUTTON_WIDTH = 32

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
	const midGesture = useMidGesture()
	// Fix 3 (coordinate space): this component renders inside the editor's own
	// container via the InFrontOfTheCanvas slot — that container is the
	// positioning root for everything below, NOT the window. tldraw's
	// getSelectionRotatedScreenBounds() is built on pageToScreen, which is
	// window space (it adds the container's own getBoundingClientRect offset
	// back in — see @tldraw/editor's Editor.pageToScreen). Subtracting
	// getViewportScreenBounds()'s minX/minY (that same container offset)
	// converts it back to container-relative space, which is what these
	// `left`/`top` CSS values are actually measured against. This only
	// "worked" before because the container happened to sit at the window
	// origin.
	const enterCandidate = useValue(
		'focus enter candidate',
		() => {
			if (focusedShapeId || presentActive) return null
			const ids = editor.getSelectedShapeIds()
			if (ids.length !== 1) return null
			const shape = editor.getShape(ids[0])
			if (!shape || !FOCUSABLE_SHAPE_TYPES.has(shape.type)) return null
			const screenBounds = editor.getSelectionRotatedScreenBounds()
			if (!screenBounds) return null
			const viewport = editor.getViewportScreenBounds()
			const bounds = {
				minX: screenBounds.minX - viewport.minX,
				minY: screenBounds.minY - viewport.minY,
				maxX: screenBounds.maxX - viewport.minX,
				maxY: screenBounds.maxY - viewport.minY,
			}
			return { id: shape.id, bounds, viewportWidth: viewport.width }
		},
		[editor, focusedShapeId, presentActive]
	)

	// --- 2. Focused chrome ---------------------------------------------------
	// The shape's screen bounds, recomputed reactively off its page bounds so
	// panning/zooming (before the lock engages, or from a future non-locked
	// focus variant) keeps the matte glued to it.
	//
	// Fix 3 (coordinate space): pageToViewport (unlike pageToScreen) already
	// returns container-relative coordinates, so the shape's corners need no
	// further adjustment. The "viewport" rect the matte strips fill out to is
	// this same container's own box — (0, 0) to (width, height) — not
	// getViewportScreenBounds()'s minX/minY/maxX/maxY, which are in window
	// space and would double-count the container's offset.
	const focusedScreen = useValue(
		'focus screen bounds',
		() => {
			if (!focusedShapeId) return null
			const pageBounds = editor.getShapePageBounds(focusedShapeId)
			if (!pageBounds) return null
			const viewport = editor.getViewportScreenBounds()
			const topLeft = editor.pageToViewport({ x: pageBounds.minX, y: pageBounds.minY })
			const bottomRight = editor.pageToViewport({ x: pageBounds.maxX, y: pageBounds.maxY })
			return {
				shape: { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y },
				viewport: { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height },
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
	//
	// Fix 1 (spec §7 focus guard): tldraw's own useKeyboardShortcuts arms
	// native tools ('n' note, 'e' eraser, ...) from a target-phase listener on
	// `document.body` — this capture-phase listener runs ahead of it, same
	// trick the chord above relies on. While focused, the canvas gets NO tool
	// keys at all; the terminal keeps everything (its hidden xterm textarea is
	// excluded by the editable-target check, same guard CommandBar's own
	// accelerator handler uses); 'p' (Present must stay startable — see
	// CommandBar.tsx's own focused-guard) and this chord are the only two
	// pass-throughs.
	useEffect(() => {
		if (!focusedShapeId) return
		function onKeyDown(e: KeyboardEvent) {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
				e.preventDefault()
				e.stopPropagation()
				exitFocus(editor)
				return
			}
			if (e.ctrlKey || e.metaKey || e.altKey) return
			if (e.key.length !== 1) return
			if (e.key.toLowerCase() === 'p') return
			const target = e.target as HTMLElement | null
			if (target) {
				if (target.isContentEditable) return
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
			}
			e.preventDefault()
			e.stopPropagation()
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
		const { bounds, viewportWidth } = enterCandidate
		// Fix 2: an un-clamped button can land off-screen — e.g. after exiting
		// focus the camera stays zoomed on the shape (see exitFocus's doc
		// comment), so the shape's top edge can sit above the viewport, or its
		// right edge past it, leaving the button unreachable. Clamp both axes
		// into the viewport (8px margin) rather than letting it follow the
		// shape's bounds unconditionally.
		const left = Math.min(Math.max(bounds.maxX - 28, 8), viewportWidth - ENTER_BUTTON_WIDTH - 8)
		const top = Math.max(8, bounds.minY - 34)
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
					left,
					top,
				}}
			>
				⛶
			</button>
		)
	}

	return null
}
