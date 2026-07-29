/**
 * Focus view (canvas-controls spec §7): fill the canvas region with a single
 * shape by zooming the tldraw camera to its bounds and locking it — uniform
 * zoom preserves aspect by construction, so this never touches the shape's
 * own w/h. That matters specifically for terminals: the cols×rows grid
 * belongs to the shared tmux PTY (one size for every viewer), so a purely
 * local view change must never reflow it — see TerminalShapeUtil's header
 * comment. Purely local, like panel width: nothing here talks to the sync
 * server.
 *
 * `focusedShapeIdAtom` is the single source of truth for "what (if anything)
 * is focused" — precedent: chrome/present.ts's presentingAtom. The camera
 * mechanics (enterFocus/exitFocus) live here; FocusOverlay.tsx owns the
 * chrome (enter affordance, matte, exit button, chord, self-healing).
 */
import { atom, useValue, type Editor, type TLShapeId } from 'tldraw'

export const focusedShapeIdAtom = atom<TLShapeId | null>('ew focused shape', null)

/** Reactive read of which shape (if any) is currently focused. */
export function useFocusedShapeId(): TLShapeId | null {
	return useValue(focusedShapeIdAtom)
}

/**
 * v1 arms focus for terminal shapes only. The mechanism itself — camera zoom
 * + lock + matte — is shape-agnostic by design (spec §7: "cast tiles and
 * iframes can adopt it later"); nothing in focus.ts or FocusOverlay.tsx
 * assumes "terminal" beyond this policy set. Widening focus to another shape
 * type is just adding to this Set.
 */
export const FOCUSABLE_SHAPE_TYPES = new Set(['terminal', 'frame'])

import { EDIT_ON_FOCUS_SHAPE_TYPES, focusStartsEditingSession } from './focusEditing'

// Re-exported so focus.ts stays the one module callers reach for; the Set
// itself lives next door in focusEditing.ts, which is tldraw-free so its
// policy can be unit-tested under bare `bun`.
export { EDIT_ON_FOCUS_SHAPE_TYPES } from './focusEditing'

// Camera isLocked at the moment we entered focus, so exitFocus can restore it
// exactly rather than assuming it was always false beforehand. Module-level
// rather than atom-housed: it's write-once/read-once bookkeeping for the
// CURRENT focus session, never rendered by anything, and always paired 1:1
// with an enterFocus/exitFocus call — an atom would just add unneeded
// reactivity overhead for a value nothing subscribes to.
let previousIsLocked = false

// Did THIS focus session put the shape into editing (EW26)? Module-level for
// exactly the same reason as previousIsLocked above: write-once/read-once
// bookkeeping for the CURRENT session, paired 1:1 with enterFocus/exitFocus,
// never rendered. Guards the exit path from clearing an editing session the
// user started themselves (double-click) before entering focus.
let autoEnteredEditing = false

/**
 * Enter focus on `shapeId`: zoom the camera to the shape's page bounds (16px
 * inset so the matte edge reads clearly), THEN lock it. Order matters —
 * TLCameraMoveOptions has a `force` flag specifically because a locked camera
 * refuses to move otherwise; relying on zoom-then-lock ordering (rather than
 * locking first and passing `force: true`) keeps this straightforward to
 * read and matches how the camera behaves everywhere else in the app (lock
 * is a steady-state property, not a per-call override).
 *
 * No-ops if the shape doesn't exist (deleted between the button rendering
 * and the click landing) — nothing to zoom to, so nothing to lock.
 *
 * EW26: for shape types in EDIT_ON_FOCUS_SHAPE_TYPES (terminals) this also
 * enters editing, so the full-screen terminal owns the keyboard from the first
 * keystroke rather than needing a double-click first.
 */
export function enterFocus(editor: Editor, shapeId: TLShapeId) {
	// Defense-in-depth reentrancy guard: a double-call (e.g. a fast double
	// click on the enter affordance) must not re-snapshot `previousIsLocked`
	// while already focused — that second snapshot would capture isLocked
	// TRUE (this session's lock), so exitFocus would then "restore" true and
	// leave the camera permanently locked instead of unlocking it.
	if (focusedShapeIdAtom.get() !== null) return
	const bounds = editor.getShapePageBounds(shapeId)
	if (!bounds) return
	previousIsLocked = editor.getCameraOptions().isLocked
	editor.zoomToBounds(bounds, { inset: 16, animation: { duration: 220 } })
	editor.setCameraOptions({ ...editor.getCameraOptions(), isLocked: true })
	// EW26: attach the keyboard for shape types that want it, BEFORE publishing
	// the atom. Order matters — FocusOverlay's lost-editing self-heal reads both
	// the focused id and the editing id, so a render that saw "focused but not
	// editing" would exit focus the instant it was entered.
	//
	// setEditingShape is the STATE half of the mechanism: TerminalShapeUtil
	// derives its isEditing from editor.getEditingShapeId(). The DOM-focus half
	// is TerminalShapeUtil's own effect, which keys off focus-view entry as
	// well as the editing transition — deliberately, because setEditingShape is
	// a no-op when the shape is already being edited and the transition alone
	// therefore misses the "already typing, then hit ⛶" path (smoke Finding 2).
	// The select tool is deliberately NOT transitioned into its `editing_shape`
	// state — that state owns its own click-outside / cancel semantics, which
	// would fight focus view's matte and its exit chord for control of the
	// session. Focus view owns the lifecycle here; exitFocus below unwinds it.
	autoEnteredEditing = false
	const shape = editor.getShape(shapeId)
	if (shape && EDIT_ON_FOCUS_SHAPE_TYPES.has(shape.type)) {
		// Read BEFORE the call — afterwards there is no way to tell an
		// inherited session from one we just opened.
		autoEnteredEditing = focusStartsEditingSession({
			shapeId,
			shapeType: shape.type,
			editingShapeIdBefore: editor.getEditingShapeId(),
		})
		editor.setEditingShape(shapeId)
	}
	focusedShapeIdAtom.set(shapeId)
}

/**
 * Exit focus: unlock the camera (restoring whatever `isLocked` was before
 * enterFocus ran, not hardcoded false) and clear the atom. Deliberately does
 * NOT restore the pre-focus camera position/zoom: spec §7 frames focus as a
 * personal, local convenience, and snapping the view back to wherever it was
 * before would yank the canvas away from the terminal the user was just
 * reading/working in — staying zoomed in on it is the less jarring exit (they
 * can zoom-to-fit or pan out themselves if they want the wider view back).
 *
 * Idempotent: a no-op when nothing is focused, so self-healing callers
 * (FocusOverlay's shape-deleted / page-changed / Present-wins effects) can
 * call this defensively without first checking whether focus is even active.
 */
export function exitFocus(editor: Editor) {
	const focusedShapeId = focusedShapeIdAtom.get()
	if (focusedShapeId === null) return
	// EW26: only unwind editing WE entered, and only if it's still ours — if
	// xterm's double-Esc already cleared it (which is what routed us here in
	// the first place), or the user moved editing to another shape, there is
	// nothing of ours left to clear. Keeps this idempotent.
	if (autoEnteredEditing && editor.getEditingShapeId() === focusedShapeId) {
		editor.setEditingShape(null)
	}
	autoEnteredEditing = false
	editor.setCameraOptions({ ...editor.getCameraOptions(), isLocked: previousIsLocked })
	focusedShapeIdAtom.set(null)
}
