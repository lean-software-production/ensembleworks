/**
 * Focus-view ⇄ editing policy (EW26). Its own tldraw-free module so the
 * decision is unit-testable under bare `bun` — focus.ts imports tldraw, which
 * hangs a bare-bun test process on exit (see canvas-health/modalCopy.test.ts's
 * header). focus.ts re-exports EDIT_ON_FOCUS_SHAPE_TYPES so callers can keep
 * treating focus.ts as the focus module.
 *
 * Why this exists: entering focus view zoomed and locked the camera but did
 * NOT enter editing, so a terminal could fill the entire screen with the
 * keyboard not attached to its PTY. The user typed, nothing appeared, and the
 * one accelerator that leaked past the focus swallow started presenting to the
 * whole room. Focusing a terminal now enters editing too — which means the
 * reverse also has to hold: when editing goes away (xterm's own double-Esc
 * calls setEditingShape(null)), focus view must go with it, or the matte
 * lingers over a terminal that no longer owns the keyboard.
 */

/** Shape types whose focus view also attaches the keyboard (enters editing).
 *  Frames are focusable but stay focus-only — there is nothing to type into. */
export const EDIT_ON_FOCUS_SHAPE_TYPES = new Set(['terminal'])

/**
 * Self-healing rule: focus view must not outlive the editing session it
 * opened. True only when a keyboard-attaching shape is focused AND something
 * has taken editing away from it.
 *
 * A null `focusedShapeType` (shape deleted out from under us) returns false on
 * purpose: FocusOverlay's shape-missing effect already owns that case and runs
 * first, so firing here too would just be a second, redundant exitFocus.
 */
export function shouldExitFocusForLostEditing(args: {
	focusedShapeId: string | null
	focusedShapeType: string | null
	editingShapeId: string | null
}): boolean {
	const { focusedShapeId, focusedShapeType, editingShapeId } = args
	if (!focusedShapeId || !focusedShapeType) return false
	if (!EDIT_ON_FOCUS_SHAPE_TYPES.has(focusedShapeType)) return false
	return editingShapeId !== focusedShapeId
}
