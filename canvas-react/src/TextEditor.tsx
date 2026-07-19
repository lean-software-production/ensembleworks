// D7 — the plain-text editing mount (Open Q4 ratified: plain-text this
// phase; a ProseMirror/loro-prosemirror binding is a Phase 4 item — see the
// phase-3 plan's Preflight P3 verdict). Mounts ONLY while `editorState.
// editingId` is set AND that shape still resolves in the current doc
// snapshot; renders nothing (null) otherwise — including the moment
// EndEdit fires (editingId goes back to null) or a concurrent delete
// removes the shape mid-edit (the shape vanishing from the snapshot is
// enough to unmount this component; ending the edit's EditorState is the
// caller's job via `onEndEdit`, not something this component infers).
//
// WORLD-SPACE vs SCREEN-SPACE (decision, OURS-v1 — the plan's own open
// question): this component is meant to be rendered INSIDE WorldLayer, as a
// sibling AFTER ShapeLayer (Viewport.tsx's STACKING CONTRACT: later DOM
// siblings paint over earlier ones, no z-index anywhere in this package —
// so the editing surface visually sits above the shape it edits). It is
// positioned and sized EXACTLY like a ShapeBody — same `shapeBodyTransform`
// (reused from ShapeBody.tsx, not re-derived) and the same `localBounds`
// w/h — so the camera's single CSS transform on WorldLayer scales this
// along with every shape body, for free. The alternative (a screen-space
// overlay computed via worldToScreen, living outside WorldLayer like D4's
// SVG overlay) was rejected for v1: it would need its own font-size/
// border/padding compensation to visually match the underlying shape at
// every zoom level, and would fight the DOM's native text layout instead
// of just inheriting it — more moving parts for no v1 benefit. tldraw's
// own editing surface scales with the camera the same way.
// CAVEAT (documented, not hidden): at extreme zoom-OUT, the browser
// rasterizes the textarea's glyphs at a tiny effective font size and then
// WorldLayer's CSS `scale()` blows the result back up — blurrier than a
// screen-space textarea rendered at a stable device-pixel size would be.
// Acceptable for v1; revisit if dogfood zoom levels make it a real
// complaint (a screen-space variant is a contained follow-up, not a
// rearchitecture, since the position math would just switch from
// shapeBodyTransform to worldToScreen).
//
// READING editor.doc IS NOT AN IMPORT (clean-room note — this file leans on
// it hardest of anything in the package so far): `editor.doc` is a
// `CanvasDoc` REFERENCE the `Editor` instance (canvas-editor/src/editor.ts)
// exposes as a public field. Calling `.getText(id)` on an object
// canvas-editor handed us is READING EDITOR STATE through its public
// surface, not an `import` of `@ensembleworks/canvas-doc` — this package's
// boundary.test.ts forbids the latter (a module-level `from '.../canvas-doc'`
// specifier) and neither can nor should forbid the former: there is no
// other way for a renderer to ever read a shape's text content. The
// distinction is the same one tool-context.ts's HOOK CHOICE comment draws
// between `editor.subscribe` and `editor.doc.subscribe` — both are reads
// THROUGH the Editor's public surface, never a direct dependency on the
// CRDT package.
//
// CONCURRENT-EDIT HONESTY (required by the phase-3 plan's ratified Q4):
// `CanvasDoc.setText` (canvas-doc/src/loro-canvas-doc.ts) is implemented as
// `t.delete(0, t.length); t.insert(0, text)` — a WHOLE-STRING REPLACE, not a
// character-level Loro text merge. Two peers editing the SAME shape in this
// plain-text mode therefore LAST-WRITE-WINS STOMP each other at SetText
// granularity: whichever SetText commits (or arrives over sync) last wins
// the entire field, and the other peer's concurrent keystrokes are silently
// discarded. There is no per-character CRDT merge in this mode — that is
// exactly what binding a shape's LoroText container to ProseMirror via
// `loro-prosemirror` would give (deferred to Phase 4 per Preflight P3's
// verdict: plain-text ships this phase, rich text is the Phase 4 item Open
// Q4 gates on).
//
// CONTROLLED FROM doc.getText (decision, OURS-v1): the textarea's `value`
// is read FRESH from `editor.doc.getText(editingId)` on every render — this
// component keeps no local/uncontrolled text state of its own. CAVEAT
// (documented, not hidden — the flip side of the LWW stomp above made
// visible in the UI): a remote SetText landing on the SAME shape WHILE a
// local user is typing overwrites the textarea's value out from under
// them — the doc's new text becomes this render's `value` immediately, and
// the browser's native caret-restore-on-value-change behavior places the
// caret wherever a freshly-set value leaves it (in practice, the end of
// the new string for a simple append/replace) — i.e. the local user's
// caret VISIBLY JUMPS. This is the SAME LWW stomp as above, made visible
// as a caret jump rather than hidden as "my keystrokes silently vanished
// eventually" — an honest v1 tradeoff, not a bug to silently paper over.
// The alternative (local-state-first, reconciling remote updates only when
// the field is blurred) is more moving parts this v1 does not need.
//
// IME COMPOSITION (sits directly on the LWW section above — same
// whole-string SetText, different trigger cadence): without composition
// tracking, EVERY intermediate keystroke of an IME session (each kana of a
// Japanese word being composed, each pinyin letter) would round-trip a
// whole-string CRDT commit — pure churn locally AND half-composed text
// shipped to peers. So: `compositionstart` opens a window during which
// `onChange` SKIPS dispatching onTextChange entirely; `compositionend`
// flushes the FINAL committed value exactly once (handlers exported pure —
// handleCompositionStart/handleCompositionEnd — and the sequence is pinned
// by text-editor.test.ts). CAVEAT (v1, documented): while the window is
// open the DOM textarea legitimately diverges from the controlled `value`
// (React deliberately does not clobber a mid-composition input); a remote
// SetText arriving mid-composition therefore doesn't repaint until the
// composition ends — one more face of the same LWW honesty above.
//
// TRIGGER LANDED (Unit 13, was previously unassigned): canvas-editor's select
// tool (tools/select.ts) now fires BeginEdit itself — a completed click that
// lands, within tldraw's own double-click time/distance window (input.ts's
// DOUBLE_CLICK_MS/DOUBLE_CLICK_RADIUS_PX), on the SAME target as the
// previous completed click emits `BeginEdit(target)` IFF the target's kind
// is TEXT-CAPABLE (canvas-model's `isTextCapableKind`: note/text/geo —
// select.ts's own EMBED GUARD note there is exactly why this component's
// separate `isEmbedKind` check just above never actually races it: the two
// checks describe DISJOINT kind sets by construction, not by luck — no
// embed kind is ever text-capable). No wiring was needed in THIS file: the
// intent already flows generically through client/src/canvas-v2/tool-
// loop.ts's dispatchToActiveTool -> editor.applyAll, same as every other
// Intent any tool emits.
//
// WATCH-ITEM (cost, same accumulator as EmbedLayer's H3 note): whole-string
// SetText is O(len) per change through Loro's delete+insert — fine at
// sticky-note scale; H3 measures and Phase-4 rich text owns long-text cost.
//
// NEVER CONSTRUCTS AN INTENT (the package's logic-free boundary, restated
// for this file specifically): text edits are reported via the
// `onTextChange(id, text)` callback prop; Escape and blur are reported via
// `onEndEdit()`. Both are the CALLER's job (G3, Seam G) to turn into
// `SetText`/`EndEdit` Intents applied through `editor.apply` — this
// component only reads editor/doc state and forwards raw DOM change/key
// events, exactly like Viewport.tsx forwards raw pointer/wheel/key events.
import { useRef, type ChangeEvent, type CompositionEvent, type KeyboardEvent } from 'react'
import { localBounds, type Shape } from '@ensembleworks/canvas-model'
import type { ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from './use-editor-state.js'
import { shapeBodyTransform } from './ShapeBody.js'
import { isEmbedKind } from './shapeRegistry.js'
import { noteStyle, NOTE_LABEL_FONT_SIZE, NOTE_LABEL_LINE_HEIGHT, NOTE_TEXT_ALIGN } from './shapes/NoteShape.js'
import { textStyle } from './shapes/TextShape.js'
import { geoStyle, GEO_LABEL_TEXT_ALIGN } from './shapes/GeoShape.js'

export interface TextEditorProps {
  readonly toolContext: ToolContext
  /** Fired on every textarea change with the editing shape's id and the
   * new full text (NOT a diff — matches CanvasDoc.setText's own whole-
   * string-replace contract, see the module header). The renderer never
   * calls `editor.apply`/constructs a `SetText` Intent itself — the caller
   * does that. */
  readonly onTextChange: (id: string, text: string) => void
  /** Fired on Escape or on the textarea losing focus (blur). The renderer
   * never calls `editor.apply`/constructs an `EndEdit` Intent itself — the
   * caller does that. */
  readonly onEndEdit: () => void
}

/** IME composition tracking (see the module header's IME COMPOSITION
 * section): a single mutable flag, held per-mount in a ref by the
 * component and threaded explicitly through the pure handlers below so
 * text-editor.test.ts can drive the exact start→change→end sequence with
 * no DOM at all. */
export interface TextCompositionState { composing: boolean }
export function createCompositionState(): TextCompositionState { return { composing: false } }

/** Pure — exported so text-editor.test.ts can invoke it directly with a
 * fake event-shaped object and a spy callback. renderToStaticMarkup (this
 * house rig's only component-test tool — see viewport.test.ts's header)
 * renders markup ONCE and never runs React's event system, so no house
 * test can literally "type into" the rendered textarea; testing the pure
 * handler function directly (same limitation/workaround shape-layer.test.ts
 * and viewport.test.ts already document for their own event-adjacent
 * paths) is the exercised alternative.
 *
 * SKIPS dispatch while an IME composition is open — see the module
 * header's IME COMPOSITION section; handleCompositionEnd flushes the
 * final value. */
export function handleTextChange(composition: TextCompositionState, id: string, text: string, onTextChange: (id: string, text: string) => void): void {
  if (composition.composing) return
  onTextChange(id, text)
}

/** Pure — same exported-for-direct-invocation reasoning as handleTextChange.
 * Opens the composition window: onChange stops dispatching until
 * handleCompositionEnd. */
export function handleCompositionStart(composition: TextCompositionState): void {
  composition.composing = true
}

/** Pure — same exported-for-direct-invocation reasoning as handleTextChange.
 * Closes the composition window and flushes the FINAL composed value
 * exactly once (the browser fires compositionend with the textarea already
 * holding the committed text — `text` here is the element's current
 * value). */
export function handleCompositionEnd(composition: TextCompositionState, id: string, text: string, onTextChange: (id: string, text: string) => void): void {
  composition.composing = false
  onTextChange(id, text)
}

/** Pure — same exported-for-direct-invocation reasoning as handleTextChange
 * above. Only Escape triggers onEndEdit; every other key is a no-op here
 * (blur, the other onEndEdit trigger, is wired directly to the textarea's
 * onBlur below — trivial passthrough with no decision logic worth
 * extracting into its own pure function). */
export function handleEditorKeyDown(key: string, onEndEdit: () => void): void {
  if (key === 'Escape') onEndEdit()
}
// Enter is deliberately NOT special-cased above: it falls through as a no-op
// here, leaving the underlying <textarea>'s NATIVE newline-insertion behavior
// unobstructed — Enter inserts a line break (multi-line note/text editing),
// it does not end the edit (only Escape/blur do, per the module header's
// NEVER CONSTRUCTS AN INTENT section). Using a <textarea> (not an <input>) is
// load-bearing for this: an <input> would swallow Enter's newline entirely.

/** The textarea's font-family/size/line-height/color/text-align, derived to
 * MATCH whichever text-capable kind (note/text/geo — canvas-model's
 * isTextCapableKind) is currently being edited (Task C6 — "the editing mount
 * must not jump visually vs the rich bodies"). Reuses each body's own pure
 * style resolver — NoteShape.tsx's `noteStyle`, TextShape.tsx's `textStyle`,
 * GeoShape.tsx's `geoStyle` — rather than re-deriving the color/font/size
 * tables those modules already own; NoteShape.tsx/GeoShape.tsx additionally
 * export their fixed label-layout CONSTANTS (fontSize/lineHeight/textAlign —
 * not tables, the same numbers every note/geo label uses regardless of
 * props) for the identical single-source-of-truth reason. See those modules'
 * GROUNDING headers for where every value ultimately traces back to v1.
 *
 * NOTE COLOR: `noteStyle(shape).color` is v1's fixed noteText (#000000,
 * black in every theme color) — NOT the sticky's own fill color; matches
 * NoteShape.tsx's label text exactly.
 * GEO COLOR: `geoStyle(shape).labelColor` is the INDEPENDENT `labelColor`
 * prop (defaults to black regardless of the shape's own stroke `color` — see
 * GeoShape.tsx's geoStyle doc comment) — deliberately NOT `strokeColor`.
 *
 * Exported so text-editor.test.ts can assert it directly (Task C6's failing-
 * test-first requirement) without re-deriving the expected values by hand —
 * tests compare against the SAME noteStyle/textStyle/geoStyle helpers this
 * function calls, so this can't silently drift from the bodies it mirrors.
 *
 * PARITY GAP (Task C6 review's corrected finding — font/size/color/align are
 * matched above, but the box model is NOT fully matched, and cannot be
 * without a design pass):
 *   - PADDING: the `text`-kind TextShape body renders with `padding:0`, so
 *     the editing textarea matches it with `padding:0` too (the ~4px shift a
 *     default `padding:4` caused on entering edit is fixed — see `padding`
 *     below). note/geo keep the textarea's small `padding:4` — their real
 *     jump is NOT padding (see next), so matching the bodies' larger 16px/8px
 *     insets would only trade one mismatch for a worse one against the
 *     vertical-centering issue.
 *   - VERTICAL ALIGNMENT (the real, deferred gap): NoteShape/GeoShape bodies
 *     VERTICALLY CENTER their label via flex (`alignItems`/`justifyContent:
 *     center`), but a <textarea> TOP-ANCHORS its text. So entering edit on a
 *     note/geo shape moves the text from vertically-centered to top-pinned —
 *     a real jump of ~80–90px for a default 200×200 note, ~40px for a default
 *     100×100 geo. This is genuinely Seam-F / design-pass scope, not a
 *     one-liner: a full-box click-catching textarea (you must be able to
 *     click anywhere in the shape to place the caret) fundamentally conflicts
 *     with vertically centering a growing/shrinking text block. Deliberately
 *     NOT fixed here — deferred to Seam F's harness / a design pass. */
export interface EditorTextStyle {
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly color: string
  readonly textAlign: 'left' | 'center' | 'right'
  /** Textarea padding, per-kind — see the PARITY GAP note above. `text` is 0
   * to match TextShape's own `padding:0` body (fixes a ~4px enter-edit
   * shift); note/geo keep 4 (their jump is vertical-centering, not padding). */
  readonly padding: number
}
export function editorTextStyle(shape: Shape): EditorTextStyle {
  switch (shape.kind) {
    case 'note': {
      const s = noteStyle(shape)
      return { fontFamily: s.fontFamily, fontSize: NOTE_LABEL_FONT_SIZE, lineHeight: NOTE_LABEL_LINE_HEIGHT, color: s.color, textAlign: NOTE_TEXT_ALIGN, padding: 4 }
    }
    case 'text': {
      const s = textStyle(shape)
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.color, textAlign: s.textAlign, padding: 0 } // padding:0 matches TextShape's own padding:0 body
    }
    case 'geo': {
      const s = geoStyle(shape)
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.labelColor, textAlign: GEO_LABEL_TEXT_ALIGN, padding: 4 }
    }
    default:
      // Defensive only, never actually hit: TextEditor only ever mounts for
      // an editingId canvas-editor's select tool set via BeginEdit, which is
      // itself gated on isTextCapableKind (note/text/geo) — see the module
      // header's TRIGGER LANDED section. A sane, undramatic fallback rather
      // than a thrown error if that invariant ever changes underneath us.
      return { fontFamily: 'sans-serif', fontSize: 16, lineHeight: 1.35, color: '#000000', textAlign: 'left', padding: 4 }
  }
}

export function TextEditor({ toolContext, onTextChange, onEndEdit }: TextEditorProps) {
  const snapshot = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  // Per-mount IME composition flag (see the module header's IME COMPOSITION
  // section). A ref, not state: mid-composition transitions must not force
  // re-renders — the flag only gates dispatch inside event handlers.
  // Declared BEFORE the early returns below (rules of hooks).
  const composition = useRef<TextCompositionState>({ composing: false })
  const editingId = editorState.editingId
  const shape = editingId ? snapshot.byId.get(editingId) : undefined
  if (!editingId || !shape) return null // no active edit, or the editing shape vanished — mount nothing (see module header)
  // EMBED GUARD: never mount a text editor over an embed-kind shape
  // (terminal/iframe/screenshare — shapeRegistry.ts's isEmbedKind, the same
  // flag ShapeLayer/EmbedLayer split on). Embeds carry no doc text to edit,
  // and a future GENERIC BeginEdit trigger (double-click on any shape —
  // Unit 13, see the header's TRIGGER UNASSIGNED note) must never float a
  // textarea over a live terminal session. Guarded here, at the mount
  // decision, rather than trusting every future trigger to remember.
  if (isEmbedKind(shape.kind)) return null

  const { maxX: w, maxY: h } = localBounds(shape) // localBounds is always {minX:0, minY:0, maxX:w, maxY:h} — geometry.ts's contract, same as ShapeBody.tsx
  const text = toolContext.editor.doc.getText(editingId) // READ through editor.doc — see module header's "not an import" note
  const style = editorTextStyle(shape) // Task C6 — matches whichever kind's body (NoteShape/TextShape/GeoShape) is being edited

  return (
    <div
      data-text-editor-id={editingId}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: '0 0',
        transform: shapeBodyTransform(snapshot, shape), // reused verbatim from ShapeBody.tsx, not re-derived
      }}
    >
      <textarea
        data-text-editor-input={editingId}
        autoFocus
        value={text}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleTextChange(composition.current, editingId, e.target.value, onTextChange)}
        onCompositionStart={() => handleCompositionStart(composition.current)}
        onCompositionEnd={(e: CompositionEvent<HTMLTextAreaElement>) => handleCompositionEnd(composition.current, editingId, e.currentTarget.value, onTextChange)}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => handleEditorKeyDown(e.key, onEndEdit)}
        onBlur={onEndEdit}
        // BELT-AND-SUSPENDERS (pilot 4, modality exclusivity): the FSM guard
        // in select.ts is what makes the invariant true and testable
        // headlessly, but the textarea's own pointer events would otherwise
        // still bubble up to the viewport's pointer handlers underneath it.
        // stopPropagation (never preventDefault — that would break native
        // caret placement) keeps the canvas from ever seeing them at all.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          padding: style.padding, // per-kind — see editorTextStyle's PARITY GAP note (text:0 matches TextShape; note/geo:4)
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          color: style.color,
          textAlign: style.textAlign,
        }}
      />
    </div>
  )
}
