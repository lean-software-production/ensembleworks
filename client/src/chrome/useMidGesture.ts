/**
 * Shared "mid-gesture" check (canvas-controls spec §6/§7): true while the
 * editor is in the middle of a drag/resize/rotate/brush/handle-drag, so
 * chrome that floats over the selection (ContextualStylePanel's popover,
 * FocusOverlay's enter affordance) can hide rather than chase the shape
 * around mid-gesture. Both call sites already run inside tldraw's editor
 * context (ContextualStylePanel directly, FocusOverlay via the
 * InFrontOfTheCanvas slot), so this hook can safely call useEditor() itself
 * rather than taking the editor as a parameter.
 */
import { useEditor, useValue } from 'tldraw'

export function useMidGesture(): boolean {
	const editor = useEditor()
	return useValue(
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
}
