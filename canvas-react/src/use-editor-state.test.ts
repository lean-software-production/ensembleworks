// Run: bun src/use-editor-state.test.ts
// Probes the cached-snapshot strategy directly against `createEditorStateStore`
// (the plain, non-hook function `useEditorState` rides on — see its doc
// comment) rather than through a rendered component: the hazard being
// tested ("editor.get() alone would infinite-loop uSES") is about REFERENCE
// IDENTITY between calls with no intervening notification, which is exactly
// as observable calling the store's `getSnapshot` directly as it would be
// through a full render loop, with none of the ceremony.
//
// Builds a REAL Editor (not a fake) using a MINIMAL stub CanvasDoc: the
// intents this test applies (SetCamera/SetSelection — both "view intents"
// per editor.ts) never touch `doc` at all (their ApplyResult is
// `docMutated: false`), so the stub's methods are never called — a real
// @ensembleworks/canvas-doc dependency would be pure ceremony for this
// test (and canvas-react correctly does not declare one — see
// boundary.test.ts).
import assert from 'node:assert/strict'
import { Editor, type EditorOpts } from '@ensembleworks/canvas-editor'
import { createEditorStateStore } from './use-editor-state.js'

// `Editor`'s `doc` field is typed `CanvasDoc` (from @ensembleworks/canvas-doc,
// a type canvas-react never imports by name — see boundary.test.ts). Naming
// it via `EditorOpts['doc']` (EditorOpts IS exported from canvas-editor's
// public barrel) gets the exact same structural type with no import of
// canvas-doc at all. Rather than enumerate CanvasDoc's full method surface,
// the stub is asserted via `as unknown as` — legitimate in a `.test.ts` file
// (boundary.test.ts exempts tests from the clean-room scan), and safe: every
// intent this test applies is a VIEW intent (SetCamera/SetSelection), which
// editor.ts's applyOne never routes through `doc` at all.
const stubDoc = {} as unknown as EditorOpts['doc']

function setup() {
  const editor = new Editor({ doc: stubDoc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  return { editor, store: createEditorStateStore(editor) }
}

// ============================================================================
// 1. THE LOAD-BEARING PROBE: two getSnapshot() calls with NO intervening
//    editor.subscribe notification return the IDENTICAL reference. This is
//    what makes useSyncExternalStore's Object.is check succeed and bail out
//    of re-rendering — editor.get() alone (a FRESH object every call, per
//    its own doc comment) would fail this exact assertion.
// ============================================================================
{
  const { store } = setup()
  const a = store.getSnapshot()
  const b = store.getSnapshot()
  assert.equal(a, b, 'getSnapshot() called twice with no notification in between must return the SAME reference')
  console.log('ok: cached snapshot — same reference across repeated getSnapshot() calls with no notification')
}

// ============================================================================
// 2. A REAL state change (via editor.apply, which fires the subscribe
//    listener synchronously — editor.ts's applyAll) DOES produce a new
//    reference, and the new reference reflects the change — the cache
//    isn't just permanently frozen.
// ============================================================================
{
  const { editor, store } = setup()
  // Mirrors what useSyncExternalStore itself does on mount: calls
  // `subscribe` once, which is what actually wires createEditorStateStore's
  // invalidation callback to editor.subscribe (see that function's doc
  // comment) — WITHOUT this call, `cached` would never be replaced (the
  // wiring lives inside `subscribe`, not `getSnapshot`), which is itself a
  // fact worth having pinned rather than silently assumed.
  store.subscribe(() => {})

  const before = store.getSnapshot()
  assert.equal(before.camera.z, 1, 'initial camera.z is the editor default')

  editor.apply({ type: 'SetCamera', x: 10, y: 20, z: 2 })

  const after = store.getSnapshot()
  assert.notEqual(after, before, 'a real SetCamera intent must invalidate the cached reference')
  assert.deepEqual(after.camera, { x: 10, y: 20, z: 2 }, 'and the new reference reflects the change')
  console.log('ok: cached snapshot — invalidates on a real state change, reflecting it')
}

// ============================================================================
// 3. Stability again AFTER the change: repeated getSnapshot() calls
//    post-notification are once again reference-stable until the NEXT
//    notification — proving this isn't a one-shot cache but a real
//    subscribe-driven invalidation cycle.
// ============================================================================
{
  const { editor, store } = setup()
  store.subscribe(() => {})
  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
  const s1 = store.getSnapshot()
  const s2 = store.getSnapshot()
  assert.equal(s1, s2, 'stable again immediately after a notification, with no further notification in between')
  console.log('ok: cached snapshot — stable again after settling post-notification')
}

console.log('ok: use-editor-state (cached-snapshot store: identity-stable between notifications, invalidates on real changes)')
