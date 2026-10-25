// text-autosize task — the DOM half of auto-sizing (the pure DECISION half
// lives in canvas-editor/src/autosize.ts's `computeAutosizeProps`, which
// this module's caller, TextEditor.tsx, feeds with the result of the
// function below). Measures how big a block of text renders at a given
// font/line-height/padding — optionally WRAPPED to a fixed inner width (for
// note/geo, whose box width never grows) or left to its NATURAL width (for
// `text`, whose autoSize grows both axes) — using a hidden, off-screen DOM
// element. This is exactly why the function must live in canvas-react (DOM
// access is allowed here) rather than canvas-editor (clean-room, no DOM).
//
// GUARDED, NOT ASSUMED, DOM ACCESS: this house test rig has no DOM emulator
// (see TextEditor.tsx's text-editor.test.ts header) — `typeof document ===
// 'undefined'` short-circuits to a harmless zero-size measurement so this
// module stays importable (and its CALLERS unit-testable with a stubbed
// measurer) outside a real browser. The actual measuring behaviour is only
// exercised where a real DOM exists — Playwright, via
// interaction-contracts' `shape-grows-to-fit-typed-text` browser contract.
export interface TextMetricsInput {
  readonly text: string
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  /** Uniform padding (px) on all four sides — matches TextEditor.tsx's own
   * per-kind `editorTextStyle().padding`, so the measured box is exactly
   * the box the caret sits inside, the same box `computeAutosizeProps`'s
   * baseline constants were chosen against. */
  readonly padding: number
}

/** Measures `input.text` at `input`'s font metrics. `wrapWidth`, when given,
 * constrains wrapping to that inner CONTENT width (the padding is added on
 * top, matching a `box-sizing: border-box` box at `wrapWidth + padding*2`
 * outer width) — the note/geo case, where only height may grow. Omitted for
 * the `text` kind, which measures its NATURAL (unwrapped) width so both
 * axes can grow with the content, matching tldraw's `autoSize`. */
export function measureTextSize(input: TextMetricsInput, wrapWidth?: number): { width: number; height: number } {
  if (typeof document === 'undefined') return { width: wrapWidth ?? 0, height: 0 }
  const div = document.createElement('div')
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.left = '-99999px'
  div.style.top = '-99999px'
  div.style.whiteSpace = wrapWidth === undefined ? 'pre' : 'pre-wrap'
  div.style.wordBreak = 'break-word'
  div.style.fontFamily = input.fontFamily
  div.style.fontSize = `${input.fontSize}px`
  div.style.lineHeight = `${input.lineHeight}`
  div.style.padding = `${input.padding}px`
  div.style.boxSizing = 'border-box'
  if (wrapWidth !== undefined) div.style.width = `${wrapWidth + input.padding * 2}px`
  // A zero-width space keeps an EMPTY textarea measuring one full line
  // (matching a real caret's resting line height) instead of collapsing to
  // a zero-height div — textContent = '' renders nothing at all.
  div.textContent = input.text.length > 0 ? input.text : '​'
  document.body.appendChild(div)
  const size = { width: div.scrollWidth, height: div.scrollHeight }
  document.body.removeChild(div)
  return size
}
