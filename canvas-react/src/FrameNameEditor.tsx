// The frame-rename editing mount (frame-interaction task, gap 1). Mirrors
// TextEditor.tsx's shape (mounts ONLY while `editorState.editingId` points
// at a live shape; renders nothing otherwise) but is a SEPARATE component
// rather than a TextEditor branch: a frame's rename target is
// `shape.props.name` — a plain UpdateProps string field (canvas-model/src/
// shape.ts's `frame: box.extend({ name: z.string().optional() })`) — not
// `editor.doc.getText`'s richText/plain-text container every TextEditor
// target (note/text/geo) actually owns. Reusing TextEditor's `<textarea>`
// bound to `doc.getText` would either throw or silently edit an empty,
// unrelated text container; a small, purpose-built `<input>` bound to
// `props.name` via UpdateProps is the correct shape for this data.
//
// GEOMETRY: reproduces canvas-react's FrameShape.tsx header chrome EXACTLY
// (same HEADER_* constants, imported from there rather than re-declared, so
// the rename input can never visually drift from the label it replaces) —
// an invisible wrapper sized/transformed exactly like the frame's BODY
// (shapeBodyTransform, same helper TextEditor.tsx reuses), with the actual
// `<input>` positioned `bottom:'100%'` inside it, above the frame's
// top-left corner, matching FrameShape.tsx's own header div layout 1:1.
//
// NEVER CONSTRUCTS AN INTENT (same logic-free boundary as TextEditor.tsx):
// a name edit is reported via `onNameChange(id, name)`; Escape/Enter/blur
// via `onEndEdit()`. Both are the CALLER's job (client/src/canvas-v2) to
// turn into UpdateProps/EndEdit Intents through `editor.apply`.
import { useRef, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react'
import { isFrameLike, localBounds } from '@ensembleworks/canvas-model'
import type { ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from './use-editor-state.js'
import { shapeBodyTransform } from './ShapeBody.js'
import {
  HEADER_FILL, HEADER_BORDER, HEADER_TEXT, HEADER_HEIGHT, HEADER_RADIUS, HEADER_FONT_SIZE, HEADER_PADDING_X, HEADER_OFFSET_X,
} from './shapes/FrameShape.js'

// Editing-affordance accent (frame-interaction validator advisory) — no
// shared selection/accent color constant exists elsewhere in canvas-react
// to reuse yet, so this is a locally-scoped choice (tldraw's own selection
// blue), not a re-derivation of an existing value.
const EDITING_RING_COLOR = '#4465e9'

export interface FrameNameEditorProps {
  readonly toolContext: ToolContext
  /** Fired on every input change with the editing frame's id and the new
   * full name (whole-string, matching UpdateProps' shallow-merge contract —
   * there is no character-level CRDT merge for a plain string prop, same
   * LWW-stomp honesty TextEditor.tsx documents for SetText). The renderer
   * never calls `editor.apply`/constructs an Intent itself — the caller
   * does. */
  readonly onNameChange: (id: string, name: string) => void
  /** Fired on Escape, Enter, or the input losing focus (blur) — an `<input>`
   * (unlike TextEditor's `<textarea>`) has no native multi-line concept, so
   * Enter ending the edit (rather than inserting a newline) is the correct,
   * unsurprising behavior here. */
  readonly onEndEdit: () => void
}

/** Pure — exported so a future frame-name-editor.test.ts can drive it
 * directly (same reasoning as TextEditor.tsx's handleEditorKeyDown: this
 * house rig's renderToStaticMarkup tool never runs React's event system,
 * so a pure handler is the only way to test the key-driven branch at all). */
export function handleFrameNameKeyDown(key: string, onEndEdit: () => void): void {
  if (key === 'Escape' || key === 'Enter') onEndEdit()
}

/** Select-all-on-open (frame-interaction validator advisory): tldraw
 * selects a shape's whole existing name the moment rename opens, so typing
 * replaces it rather than appending after the caret. Takes anything with a
 * `select()` method (an `HTMLInputElement`, or a fake in a test) rather
 * than the full FocusEvent so it stays pure/directly testable, same
 * posture as handleFrameNameKeyDown above. */
export function handleFrameNameFocus(target: { select(): void }): void {
  target.select()
}

/** `shape.props.name`, verbatim (never defaulted to the "Frame" placeholder
 * FrameShape.tsx's `frameLabel` shows for an EMPTY name — the editing
 * input's value must be the real (possibly empty) stored string, not a
 * display placeholder, or clearing a frame's name would be impossible to
 * type). Pure, exported for direct testing. */
export function frameNameValue(props: Record<string, unknown>): string {
  return typeof props.name === 'string' ? props.name : ''
}

export function FrameNameEditor({ toolContext, onNameChange, onEndEdit }: FrameNameEditorProps) {
  const snapshot = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  // Declared BEFORE the early returns below (rules of hooks). Used by
  // onFocus below to select-all (handleFrameNameFocus) -- kept as a ref
  // rather than relying on the FocusEvent's own `e.target` so the pure
  // handler's contract (`{ select(): void }`) stays trivially satisfied by
  // either.
  const inputRef = useRef<HTMLInputElement>(null)
  const editingId = editorState.editingId
  const shape = editingId ? snapshot.byId.get(editingId) : undefined
  // REGION GATE (pane input routing task, docs/plans/2026-09-15-bb-thread-
  // frame.md's follow-up section): a bbthread's editingId also resolves
  // isFrameLike (isFrameLike covers 'frame' and 'bbthread' alike), but its
  // `region: 'body'` edit is the thread PANE, not a header rename — this
  // component mounts ONLY for `region: 'name'`, the same gate the select
  // tool's opensFrameRename branch used to decide which BeginEdit region to
  // send in the first place (canvas-editor's select.ts).
  if (!editingId || !shape || !isFrameLike(shape.kind) || editorState.editingRegion !== 'name') return null // no active header-rename edit, or it vanished/isn't frame-like/isn't the name region (TextEditor.tsx owns every other kind; the bbthread pane owns 'body')

  const { maxX: w, maxY: h } = localBounds(shape)
  const name = frameNameValue(shape.props as Record<string, unknown>)

  return (
    <div
      data-frame-name-editor-id={editingId}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: '0 0',
        transform: shapeBodyTransform(snapshot, shape), // reused verbatim from ShapeBody.tsx/TextEditor.tsx, not re-derived
        pointerEvents: 'none', // only the header input itself (below) is interactive -- the rest of this box is the frame's own body, already painted by FrameShape
      }}
    >
      <input
        data-frame-name-editor-input={editingId}
        ref={inputRef}
        autoFocus
        value={name}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(editingId, e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => handleFrameNameKeyDown(e.key, onEndEdit)}
        onFocus={(e: FocusEvent<HTMLInputElement>) => handleFrameNameFocus(e.target)}
        onBlur={onEndEdit}
        // BELT-AND-SUSPENDERS (same modality-exclusivity guard TextEditor.tsx's
        // textarea carries): keeps the canvas viewport from ever seeing this
        // input's own pointer events.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: HEADER_OFFSET_X,
          bottom: '100%',
          height: HEADER_HEIGHT,
          maxWidth: '100%',
          boxSizing: 'border-box',
          borderRadius: HEADER_RADIUS,
          border: 'none',
          outline: 'none',
          // Visible editing affordance (frame-interaction validator advisory):
          // this input mounts ONLY while editingId points at this frame, so
          // there's no separate ":focus" state to distinguish -- a static
          // accent ring is what tells it apart from FrameShape.tsx's static
          // label, which shares HEADER_FILL/HEADER_BORDER (both resolve to
          // the same near-white hex, see that file's GROUNDING comment).
          boxShadow: `inset 0 0 0 1px ${HEADER_BORDER}, 0 0 0 2px ${EDITING_RING_COLOR}`,
          background: HEADER_FILL,
          color: HEADER_TEXT,
          padding: `0 ${HEADER_PADDING_X}px`,
          fontSize: HEADER_FONT_SIZE,
          pointerEvents: 'auto',
        }}
      />
    </div>
  )
}
