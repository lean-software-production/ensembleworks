/**
 * Run: bun client/src/chrome/presentDialogFocus.test.ts
 *
 * EW26 smoke Finding 1: the Present confirmation opened with
 * `DIV.tlui-dialog__body` focused (tldraw's dialog body is unconditionally
 * `tabIndex={0}`), so Enter and Space did nothing and Cancel never held the
 * default focus the card requires. This rebuilds tldraw's dialog DOM shape in
 * happy-dom — content > header/body(tabIndex 0)/footer > Cancel, Present — and
 * pins the fix: Cancel focused, body out of the tab sequence.
 */
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document

const { claimDialogDefaultFocus } = await import('./presentDialogFocus')

/** The DOM tldraw's dialog primitives actually produce, in order. */
function buildDialog() {
	const doc = win.document
	doc.body.innerHTML = `
		<div class="tlui-dialog__overlay">
			<div class="tlui-dialog__content">
				<div class="tlui-dialog__header"><h2>Present to everyone?</h2></div>
				<div class="tlui-dialog__body" tabindex="0">You're about to grab control…</div>
				<div class="tlui-dialog__footer tlui-dialog__footer__actions">
					<button data-testid="ew-present-cancel">Cancel</button>
					<button data-testid="ew-present-confirm">Present</button>
				</div>
			</div>
		</div>`
	return {
		body: doc.querySelector('.tlui-dialog__body') as any,
		cancel: doc.querySelector('[data-testid="ew-present-cancel"]') as any,
		confirm: doc.querySelector('[data-testid="ew-present-confirm"]') as any,
	}
}

// Baseline: tldraw really does ship the body as a tabbable element, which is
// what defeated the original "Cancel is first in the DOM" reasoning.
{
	const { body } = buildDialog()
	assert.equal(body.tabIndex, 0, 'tldraw dialog body is tabbable before the fix')
}

// The fix: Cancel takes the focus, and the body leaves the tab sequence so
// nothing can take it back.
{
	const { body, cancel } = buildDialog()
	claimDialogDefaultFocus(cancel)
	assert.equal(win.document.activeElement, cancel, 'Cancel holds the default focus')
	assert.equal(body.tabIndex, -1, 'the dialog body is no longer tabbable')
}

// Cancel — never Present — is the first tabbable control, so Radix landing on
// "first tabbable" also lands on Cancel. A stray Enter can only cancel.
{
	const { cancel, confirm } = buildDialog()
	claimDialogDefaultFocus(cancel)
	const tabbable = [...win.document.querySelectorAll('.tlui-dialog__content *')].filter(
		(el: any) => el.tabIndex >= 0
	)
	assert.equal(tabbable[0], cancel, 'Cancel is the first tabbable element')
	assert.ok(tabbable.indexOf(confirm as any) > 0, 'Present comes after Cancel')
}

// Defensive no-op: dialog closed (or ref not attached) between render and
// effect. Must not throw.
claimDialogDefaultFocus(null)

console.log('presentDialogFocus.test.ts: all assertions passed')
