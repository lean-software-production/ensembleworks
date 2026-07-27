/**
 * Contextual style panel (canvas-controls spec §6): no fixed top-right panel.
 * One component, two anchors — above the selection bounds when a selection
 * exists (same spot as tldraw's rich-text toolbar), or floated above the
 * command bar when a style-bearing tool is armed with nothing selected.
 * Hidden mid-gesture so it never chases a drag, and hidden for an all-locked
 * selection (see `allLocked` below).
 */
import { type CSSProperties } from 'react'
import {
	DefaultStylePanel,
	stopEventPropagation,
	useEditor,
	useRelevantStyles,
	useValue,
	type TLShapeId,
} from 'tldraw'
import { everySelectedShapeLocked } from './lockedShapes'
import { useMidGesture } from './useMidGesture'

// Tools whose next-shape styles are worth editing before drawing.
const STYLE_TOOLS = new Set(['draw', 'highlight', 'arrow', 'line', 'geo', 'note', 'text', 'frame'])

// DefaultStylePanel renders ~300px tall; flip below the selection unless the
// full panel plus margin fits above it.
const PANEL_FLIP_HEADROOM = 320

export function ContextualStylePanel() {
	const editor = useEditor()
	const styles = useRelevantStyles()
	const currentToolId = useValue('current tool', () => editor.getCurrentToolId(), [editor])
	const selectionBounds = useValue(
		'selection screen bounds',
		() => {
			if (editor.getSelectedShapeIds().length === 0) return null
			return editor.getSelectionRotatedScreenBounds() ?? null
		},
		[editor]
	)
	const midGesture = useMidGesture()
	// A locked shape is selectable (App.tsx's selectLockedShapes), but every
	// control in this panel is a no-op against it — setStyleForSelectedShapes
	// doesn't lock-filter, the updateShapes beneath it does. Showing a panel
	// whose every control silently does nothing is the same class of bug the
	// padlock chip exists to kill, so suppress it. Mixed selections keep the
	// panel: the controls still restyle the unlocked members.
	// Right-clicking an unselected shape selects it, which would otherwise pop
	// this panel open at the same moment as the context menu — two overlapping
	// popups from one gesture. The right button should produce exactly one, so
	// the panel yields while the context menu is up and returns when it closes
	// (the shape stays selected throughout).
	const contextMenuOpen = useValue(
		'context menu open',
		() => editor.menus.isMenuOpen('context menu'),
		[editor]
	)
	const allLocked = useValue(
		'selection is all locked',
		() =>
			everySelectedShapeLocked(editor.getSelectedShapeIds(), (id) =>
				editor.isShapeOrAncestorLocked(id as TLShapeId)
			),
		[editor]
	)
	// Editor viewport width, not window.innerWidth: the canvas region won't
	// span the whole window once Phase 2 adds a right-hand side panel, and
	// this stays reactive to resize (useValue re-runs on viewport change).
	const viewportWidth = useValue(
		'viewport width',
		() => editor.getViewportScreenBounds().width,
		[editor]
	)

	// useRelevantStyles() returns the ReadonlySharedStyleMap directly (it IS
	// the map, not a wrapper with a `.styles` field) — node_modules/@tldraw/
	// editor/dist-cjs/index.d.ts declares `class ReadonlySharedStyleMap` with
	// `get size(): number` on the class itself. So the emptiness test is
	// `styles.size === 0`, not `styles.styles.size`.
	if (!styles || styles.size === 0) return null
	if (midGesture) return null
	// Before the anchor branches below: an all-locked selection suppresses the
	// panel outright rather than falling through to the armed-tool anchor,
	// which would float it over the command bar for a selection it cannot edit.
	if (allLocked) return null
	if (contextMenuOpen) return null

	let style: CSSProperties
	if (selectionBounds) {
		const margin = 8
		const left = Math.min(Math.max(selectionBounds.midX, 90), viewportWidth - 90)
		const top = selectionBounds.minY - margin
		if (top < PANEL_FLIP_HEADROOM) {
			// No headroom above the selection — drop below it instead.
			style = {
				position: 'absolute',
				left,
				top: selectionBounds.maxY + margin,
				transform: 'translateX(-50%)',
			}
		} else {
			style = { position: 'absolute', left, top, transform: 'translate(-50%, -100%)' }
		}
	} else if (STYLE_TOOLS.has(currentToolId)) {
		// 72: approx command-bar height + margin, so the floating panel sits
		// just above the bar. Retune against the real bar's measured height.
		style = { position: 'absolute', left: '50%', bottom: 72, transform: 'translateX(-50%)' }
	} else {
		return null
	}

	return (
		<div
			data-testid="ew-style-panel"
			onPointerDown={stopEventPropagation}
			style={{ ...style, pointerEvents: 'all', zIndex: 400 }}
		>
			<DefaultStylePanel />
		</div>
	)
}
