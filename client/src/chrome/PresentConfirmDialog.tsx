/**
 * Present confirmation (EW26): ▶ Present no longer starts a broadcast
 * directly — it opens this two-button confirm first. Present is the one
 * command in the bar that reaches out and grabs EVERY person's viewport, so it
 * gets the one gate: the keyboard route ('p') is gone entirely (CommandBar.tsx)
 * and the click route lands here. END PRESENTING is deliberately NOT gated —
 * stopping is never intrusive.
 *
 * Cancel is FIRST in the DOM on purpose, and there is no header close button.
 * tldraw renders dialogs through Radix (tldraw/src/lib/ui/components/
 * Dialogs.tsx), and Radix's focus scope focuses the first tabbable element in
 * the content when the dialog opens — so DOM ORDER, not an `autoFocus` prop,
 * is what actually makes a stray Enter or Space cancel instead of confirm.
 *
 * Escape and a backdrop click both close via Radix's own handling, and closing
 * is Cancel by construction: presenting only ever starts from the Present
 * button's onClick below, never from a close path.
 *
 * Styled with tldraw's own dialog primitives — the same house pattern as
 * MainMenu.tsx's About dialog and terminal/openNewTerminal.tsx's gateway
 * picker. No checkbox, no "don't ask again": a gate you can turn off is not a
 * gate.
 */
import {
	TldrawUiButton,
	TldrawUiDialogBody,
	TldrawUiDialogFooter,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	type Editor,
	type TLUiDialogProps,
} from 'tldraw'
import { tryStartPresenting } from './present'
import {
	PRESENT_CANCEL_LABEL,
	PRESENT_CONFIRM_BODY,
	PRESENT_CONFIRM_LABEL,
	PRESENT_CONFIRM_TITLE,
} from './presentCopy'

export function PresentConfirmDialog({ onClose, editor }: TLUiDialogProps & { editor: Editor }) {
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>{PRESENT_CONFIRM_TITLE}</TldrawUiDialogTitle>
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ maxWidth: 420 }}>{PRESENT_CONFIRM_BODY}</TldrawUiDialogBody>
			<TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<TldrawUiButton type="normal" data-testid="ew-present-cancel" onClick={onClose}>
					{PRESENT_CANCEL_LABEL}
				</TldrawUiButton>
				<TldrawUiButton
					type="primary"
					data-testid="ew-present-confirm"
					onClick={() => {
						// tryStartPresenting, not presentingAtom.set(true): it
						// re-checks collaborators imperatively, closing the
						// render-lag half of the two-presenters race (see
						// present.ts's doc comment).
						tryStartPresenting(editor)
						onClose()
					}}
				>
					{PRESENT_CONFIRM_LABEL}
				</TldrawUiButton>
			</TldrawUiDialogFooter>
		</>
	)
}
