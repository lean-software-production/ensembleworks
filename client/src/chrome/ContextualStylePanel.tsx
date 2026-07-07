/**
 * Contextual style panel (canvas-controls spec §6): no fixed top-right panel.
 * One component, two anchors — above the selection bounds when a selection
 * exists (same spot as tldraw's rich-text toolbar), or floated above the
 * command bar when a style-bearing tool is armed with nothing selected.
 * Hidden mid-gesture so it never chases a drag.
 */
import { type CSSProperties } from 'react'
import {
	DefaultStylePanel,
	stopEventPropagation,
	useEditor,
	useRelevantStyles,
	useValue,
} from 'tldraw'

// Tools whose next-shape styles are worth editing before drawing.
const STYLE_TOOLS = new Set(['draw', 'highlight', 'arrow', 'line', 'geo', 'note', 'text', 'frame'])

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
	const midGesture = useValue(
		'mid gesture',
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

	// useRelevantStyles() returns the ReadonlySharedStyleMap directly (it IS
	// the map, not a wrapper with a `.styles` field) — node_modules/@tldraw/
	// editor/dist-cjs/index.d.ts declares `class ReadonlySharedStyleMap` with
	// `get size(): number` on the class itself. So the emptiness test is
	// `styles.size === 0`, not `styles.styles.size`.
	if (!styles || styles.size === 0) return null
	if (midGesture) return null

	let style: CSSProperties
	if (selectionBounds) {
		const margin = 8
		const left = Math.min(Math.max(selectionBounds.midX, 90), window.innerWidth - 90)
		const top = selectionBounds.minY - margin
		if (top < 60) {
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
