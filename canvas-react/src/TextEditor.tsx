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
// NEVER CONSTRUCTS AN INTENT (the package's logic-free boundary, restated
// for this file specifically): text edits are reported via the
// `onTextChange(id, text)` callback prop; Escape and blur are reported via
// `onEndEdit()`. Both are the CALLER's job (G3, Seam G) to turn into
// `SetText`/`EndEdit` Intents applied through `editor.apply` — this
// component only reads editor/doc state and forwards raw DOM change/key
// events, exactly like Viewport.tsx forwards raw pointer/wheel/key events.
import type { ChangeEvent, KeyboardEvent } from 'react'
import { localBounds } from '@ensembleworks/canvas-model'
import type { ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from './use-editor-state.js'
import { shapeBodyTransform } from './ShapeBody.js'

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

/** Pure — exported so text-editor.test.ts can invoke it directly with a
 * fake event-shaped object and a spy callback. renderToStaticMarkup (this
 * house rig's only component-test tool — see viewport.test.ts's header)
 * renders markup ONCE and never runs React's event system, so no house
 * test can literally "type into" the rendered textarea; testing the pure
 * handler function directly (same limitation/workaround shape-layer.test.ts
 * and viewport.test.ts already document for their own event-adjacent
 * paths) is the exercised alternative. */
export function handleTextChange(id: string, text: string, onTextChange: (id: string, text: string) => void): void {
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

export function TextEditor({ toolContext, onTextChange, onEndEdit }: TextEditorProps) {
  const snapshot = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  const editingId = editorState.editingId
  const shape = editingId ? snapshot.byId.get(editingId) : undefined
  if (!editingId || !shape) return null // no active edit, or the editing shape vanished — mount nothing (see module header)

  const { maxX: w, maxY: h } = localBounds(shape) // localBounds is always {minX:0, minY:0, maxX:w, maxY:h} — geometry.ts's contract, same as ShapeBody.tsx
  const text = toolContext.editor.doc.getText(editingId) // READ through editor.doc — see module header's "not an import" note

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
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleTextChange(editingId, e.target.value, onTextChange)}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => handleEditorKeyDown(e.key, onEndEdit)}
        onBlur={onEndEdit}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          border: 'none',
          outline: 'none',
          font: 'inherit',
          background: 'transparent',
          padding: 4,
        }}
      />
    </div>
  )
}
