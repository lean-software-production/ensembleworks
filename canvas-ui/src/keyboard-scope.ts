// Which keydown targets belong to the canvas's shortcut scope.
//
// A keydown targeting an element inside the scope always does. A keydown
// targeting the document body (or nothing) does only when the canvas was the
// last thing the user pointed at or focused: focus falls back to body when a
// text edit ends, and shortcuts must survive that; but in a host with other
// panes (bb's split layout), clicking plain text outside the canvas also leaves
// focus on body, and Backspace or Ctrl+C there must not act on the canvas.

/** True when a keydown with this target is a canvas shortcut candidate. */
export function isKeyTargetInScope(
	target: EventTarget | null,
	scope: Element | null,
	body: Element | null,
	lastInteractionInScope: boolean,
): boolean {
	if (scope === null) return false
	if (target === null || target === body) return lastInteractionInScope
	return scope.contains(target as Node)
}
