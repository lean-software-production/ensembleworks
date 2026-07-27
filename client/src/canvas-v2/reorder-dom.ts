/**
 * The pure key -> Arrange-op DECISION for the four bracket-key reorder
 * shortcuts (Task D1, D-6) — DOM-free and unit-testable, mirroring
 * `clipboard-dom.ts`'s `clipboardShortcut`. CanvasV2App.tsx's
 * `handleGlobalShortcut` is the only caller: it maps the returned `op` to
 * `reorderSelectionIntents(editor, op)` and applies the batch in one
 * `editor.applyAll(...)` call (one commit, one undo entry — canvas-editor's
 * E2). The actual "press ] -> shape moves up in paint order" is proved
 * end-to-end by Z1's browser contract, not here.
 *
 * SHIFTED-KEY SUBTLETY (D-6, same class the undo/redo z-branch's
 * `key.toLowerCase()` comment already documents): Shift+`]` arrives as
 * `event.key === '}'`, not `']'` with a shift flag set — so this matches on
 * the DELIVERED CHARACTER directly, no separate shift-modifier check. That
 * is also why `]` must not casually be treated as "the same key, shift
 * optional": `]` and `}` are different characters mapping to different ops.
 */
import type { KeyInputEvent } from '@ensembleworks/canvas-editor'
import type { ReorderOp } from '@ensembleworks/canvas-editor'

/**
 * Pure decision: does this keydown mean a bracket-key Arrange shortcut, and
 * which op? Gated on `editingId === null` exactly like Escape/Delete/
 * undo/clipboard in CanvasV2App.tsx's `handleGlobalShortcut` — brackets are
 * ordinary typeable characters, so while a shape is being text-edited the
 * TextEditor's own textarea must receive them unmolested.
 */
export function reorderShortcut(event: KeyInputEvent, editingId: string | null): { op: ReorderOp } | null {
	if (editingId !== null) return null
	switch (event.key) {
		case ']':
			return { op: 'forward' }
		case '[':
			return { op: 'backward' }
		case '}':
			return { op: 'toFront' }
		case '{':
			return { op: 'toBack' }
		default:
			return null
	}
}
