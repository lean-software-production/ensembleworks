/**
 * Default focus for the Present confirmation (EW26, smoke Finding 1).
 *
 * The dialog's whole safety property is that the harmless button holds focus:
 * a stray Enter or Space cancels, it never confirms a room-wide takeover.
 * PresentConfirmDialog originally relied on DOM ORDER for that — Cancel first
 * in the footer, and Radix's focus scope focuses the first tabbable element in
 * the content on open. That premise is false against tldraw's primitives:
 * `TldrawUiDialogBody` renders `<div className="tlui-dialog__body"
 * tabIndex={0}>` unconditionally (tldraw/src/lib/ui/components/primitives/
 * TldrawUiDialog.tsx), so the body div is ALWAYS the first tabbable element
 * and always wins the autofocus. Observed live: `document.activeElement` was
 * `DIV.tlui-dialog__body`, and Enter/Space did nothing at all.
 *
 * So Cancel claims focus explicitly. Two moves, and they agree:
 *
 * 1. Drop the body div out of the tab sequence (`tabIndex = -1`). It is a
 *    static paragraph of text, not a control; making it non-tabbable makes
 *    Cancel genuinely first in tab order, which is what the DOM ordering was
 *    reaching for. Radix's own autofocus then lands on Cancel too.
 * 2. Focus Cancel directly. This runs from the dialog content's own mount
 *    effect, which React flushes BEFORE the ancestor FocusScope's — and Radix
 *    skips its autofocus entirely when focus is already inside the container
 *    (`hasFocusedCandidate` in @radix-ui/react-focus-scope). So step 2 wins
 *    outright, and step 1 is what keeps the outcome right if that ordering
 *    ever changes.
 *
 * Its own tldraw-free module so the policy is unit-testable against plain
 * happy-dom nodes — importing tldraw into a bare-bun test process hangs it on
 * exit (see canvas-health/modalCopy.test.ts's header).
 */

/** Class tldraw's dialog primitives put on the scrollable body div. */
const DIALOG_BODY_CLASS = 'tlui-dialog__body'

/** Class tldraw's dialog primitives put on the Radix content wrapper. */
const DIALOG_CONTENT_CLASS = 'tlui-dialog__content'

/**
 * Give `cancel` the dialog's default focus, and take the body div out of the
 * tab sequence so it stays there.
 *
 * No-ops on a null button (the ref has not attached yet, or the dialog closed
 * between render and effect) — nothing to focus, nothing to protect.
 */
export function claimDialogDefaultFocus(cancel: HTMLElement | null): void {
	if (!cancel) return
	const content = cancel.closest(`.${DIALOG_CONTENT_CLASS}`) ?? cancel.ownerDocument
	const body = content?.querySelector<HTMLElement>(`.${DIALOG_BODY_CLASS}`)
	if (body) body.tabIndex = -1
	cancel.focus()
}
