// FINGER-SIZED CHROME (mobile-touch task, scope 3) — the one place this package
// decides how big a tappable control is, shared by the tool rail and the zoom
// pill so the two cannot drift.
//
// WHY A DEVICE QUERY HERE, when the canvas's own hit tolerances
// (canvas-editor's `hitTolerancePx`, `bbthreadDividerMargin`) deliberately
// refuse one and read each EVENT's pointerType instead: a rendered box has to
// have ONE size, chosen before any pointer arrives. There is no event to read.
// `(pointer: coarse)` describes the device's PRIMARY pointer, and its known
// failure case is a touchscreen laptop, where a mouse user gets finger-sized
// buttons — the harmless direction of the error, unlike a fingertip getting
// mouse-sized ones.
//
// PURE AND PARAMETERISED rather than a `matchMedia` call inside a component:
// this package has no DOM emulator (toolbar.test.ts's header), so a size
// written in a .tsx is a decision no test here can read.

/** The ~44px platform touch target: Apple HIG 44pt, Material 48dp, WCAG 2.5.5's
 * 44x44 CSS px. One number, cited once. */
export const COARSE_TARGET_PX = 44

/** Is the device's PRIMARY pointer coarse? Feature-checked: happy-dom and SSR
 * may have no `matchMedia` at all, and "no media query" must mean fine, not a
 * crash. Components take the answer as an optional PROP defaulted from this, so
 * a test can pass it and a host that knows better (a mobile shell) can say so. */
export function prefersCoarsePointer(): boolean {
	return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches
}

/** A square control's side, in CSS px, for a fine or coarse primary pointer. */
export function controlSizePx(coarsePointer: boolean, finePx: number): number {
	return coarsePointer ? COARSE_TARGET_PX : finePx
}
