/**
 * Focus-view key policy (EW26), extracted from FocusOverlay.tsx as a pure
 * function. Lives in its own module with NO tldraw import so it is testable
 * under bare `bun` (importing tldraw hangs the test process on exit — see
 * canvas-health/modalCopy.test.ts's header).
 *
 * While a shape is focus-viewed, FocusOverlay listens in the CAPTURE phase on
 * `window`, ahead of both tldraw's own body-level shortcut handler and
 * CommandBar's accelerator engine. So this decides, for every keystroke:
 *
 *   'exit'    — the Ctrl/Cmd+Shift+Enter exit chord. Checked FIRST, before the
 *               editable-target pass-through, because a focused terminal's
 *               xterm textarea would otherwise keep it.
 *   'pass'    — leave the event completely alone.
 *   'swallow' — preventDefault + stopPropagation; the canvas gets nothing.
 *
 * EW26 changed two of these. 'p' used to be a pass-through so Present could
 * preempt focus view; Present now has no keyboard route anywhere, so 'p' is
 * just another swallowed character. And `Escape` — previously not covered,
 * because the swallow only looked at `key.length === 1` — is now swallowed
 * too, so it cannot reach CommandBar's end-present / stop-follow handling
 * from a full-screen terminal.
 *
 * Two pass-throughs sit AHEAD of the swallow, in this order:
 *   - `editableTarget`: the terminal (xterm's hidden textarea), an <input>, or
 *     a contentEditable node owns every key, Escape included — that is what
 *     makes vim and xterm's double-Esc exit work.
 *   - `inDialog`: the Present confirmation (chrome/PresentConfirmDialog.tsx)
 *     can open ON TOP of focus view, and it is a Radix dialog whose Escape /
 *     backdrop handling is bound at the document level — swallowing here in
 *     the capture phase would strand it open.
 */
export interface FocusKeyContext {
	key: string
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
	shiftKey: boolean
	/** Target is a text-entry surface: xterm's hidden textarea, <input>,
	 *  <textarea>, <select>, or a contentEditable node. */
	editableTarget: boolean
	/** Target sits inside an open modal dialog (Radix gives Dialog.Content
	 *  `role="dialog"`). */
	inDialog: boolean
}

export type FocusKeyVerdict = 'exit' | 'swallow' | 'pass'

export function focusKeyVerdict(ctx: FocusKeyContext): FocusKeyVerdict {
	if ((ctx.ctrlKey || ctx.metaKey) && ctx.shiftKey && ctx.key === 'Enter') return 'exit'
	if (ctx.ctrlKey || ctx.metaKey || ctx.altKey) return 'pass'
	if (ctx.editableTarget || ctx.inDialog) return 'pass'
	if (ctx.key.length === 1 || ctx.key === 'Escape') return 'swallow'
	return 'pass'
}
