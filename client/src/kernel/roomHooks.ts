/**
 * Attach every plugin's room hooks to a freshly mounted editor. One composed
 * before-delete handler and one composed after-delete handler are registered
 * (only when some plugin needs them), so tldraw sees at most two side-effect
 * registrations regardless of plugin count. Returns a cleanup for StrictMode
 * double-mount and real unmounts.
 */
import type { Editor } from 'tldraw'
import type { ClientPlugin, RoomHooks } from './plugin'

export function attachRoomHooks(editor: Editor, plugins: readonly ClientPlugin[]): () => void {
	const hooks: RoomHooks[] = []
	for (const plugin of plugins) {
		if (plugin.roomHooks) hooks.push(plugin.roomHooks(editor))
	}

	const cleanups: Array<() => void> = []

	const before = hooks.filter((h) => h.beforeShapeDelete)
	if (before.length > 0) {
		cleanups.push(
			editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
				// Every feature sees the delete; any single veto cancels the batch.
				let vetoed = false
				for (const h of before) {
					if (h.beforeShapeDelete!(shape, source) === false) vetoed = true
				}
				if (vetoed) return false
			})
		)
	}

	const after = hooks.filter((h) => h.afterShapeDelete)
	if (after.length > 0) {
		cleanups.push(
			editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
				for (const h of after) h.afterShapeDelete!(shape)
			})
		)
	}

	for (const h of hooks) {
		if (h.cleanup) cleanups.push(h.cleanup)
	}

	return () => {
		for (const cleanup of cleanups) cleanup()
	}
}
