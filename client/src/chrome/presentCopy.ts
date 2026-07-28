/**
 * Present confirmation copy (EW26). Its own tldraw-free module so the wording
 * is unit-testable under bare `bun` — importing the dialog component would
 * drag tldraw into the test process, which hangs on exit (see
 * canvas-health/modalCopy.test.ts's header for the same constraint).
 *
 * The body sentence is deliberately about the OTHER people in the room, not
 * about the presenter: Present is the only command in the bar whose blast
 * radius is everyone else's screen, and the confirmation exists to say so.
 */
export const PRESENT_CONFIRM_TITLE = 'Present to the room?'

export const PRESENT_CONFIRM_BODY =
	"You're about to grab control of everyone's canvas and pull them over to see what you're seeing. Are you sure?"

export const PRESENT_CONFIRM_LABEL = 'Present'
export const PRESENT_CANCEL_LABEL = 'Cancel'
