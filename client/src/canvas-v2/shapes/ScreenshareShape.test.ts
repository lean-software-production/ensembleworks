// Run: bun src/canvas-v2/shapes/ScreenshareShape.test.ts
//
// TEST-HARNESS LIMITATION (stated once): store.ts's `useScreenShareTrack`
// calls `useSyncExternalStore(subscribe, getSnapshot)` with NO
// `getServerSnapshot` argument — under a real SSR environment (no `window`,
// which is exactly what a plain `bun run` gives you) React requires that
// third argument for a hook actually invoked during render; ScreenshareShape
// unconditionally calls the hook, so rendering it (even via
// renderToStaticMarkup) is not safely testable in this house rig without a
// DOM emulator. This file therefore tests ONLY the pure halves:
// `screenshareContentFrom` + `screenshareStillTreatment` +
// `screenshareStampIntent` + `screenshareAspectRelockIntent` (Task D4's
// dispatch-channel restorations, exercised with a fake dispatch spy exactly
// like TerminalShape.test.ts's dispatchCalls pattern — the component itself
// only ever calls `dispatch?.(...)` with what these pure functions compute).
// Real mounting (LiveKit track attach/detach, suspend/resume, the actual
// `<video>` `resize` event, the `/uploads` PUT) is G2-golden/D6 E2E
// territory — see TerminalShape.test.ts's identical note for the sibling
// heavy embed.
import assert from 'node:assert/strict'
import type { Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '@ensembleworks/canvas-editor'
import {
  screenshareAspectRelockIntent,
  screenshareContentFrom,
  screenshareStampIntent,
  screenshareStillTreatment,
} from './ScreenshareShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:s1', kind: 'screenshare', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

{
  const shape = shapeWithProps({
    w: 1000,
    h: 600,
    title: 'alice · window',
    participantId: 'p-alice',
    trackName: 'screen:0:0',
    stillUrl: '/uploads/screenstill-0-0',
    ownerColor: '#ff0000',
  })
  const content = screenshareContentFrom(shape)
  assert.deepEqual(content, {
    w: 1000,
    h: 600,
    title: 'alice · window',
    participantId: 'p-alice',
    trackName: 'screen:0:0',
    stillUrl: '/uploads/screenstill-0-0',
    ownerColor: '#ff0000',
  })
}

{
  const content = screenshareContentFrom(shapeWithProps({}))
  assert.equal(content.title, 'screen share')
  assert.equal(content.participantId, '')
  assert.equal(content.trackName, '')
  assert.equal(content.stillUrl, undefined)
  assert.equal(content.ownerColor, undefined)
  assert.ok(content.w > 0 && content.h > 0)
}

// --- screenshareStillTreatment: the restored ended/paused badge + filter
// (pure — same values as the legacy component's inline expressions) ---
assert.deepEqual(
  screenshareStillTreatment('ended'),
  { label: 'share ended', filter: 'grayscale(0.5) brightness(0.8)' },
  'an ended tile reads as a still: grayscale/dimmed + "share ended" badge'
)
assert.deepEqual(
  screenshareStillTreatment('connecting'),
  { label: 'paused', filter: undefined },
  'a connecting tile with a held frame reads as paused, unfiltered'
)

console.log('ok: ScreenshareShape — screenshareContentFrom + screenshareStillTreatment (pure halves only; see header for the SSR limitation)')

// --- screenshareStampIntent (Task D4): captured-frame stamp-back, gated on
// ended + lastFrame + single-writer (presenter) + the stamp-loop guard ---
{
  const dispatchCalls: Intent[][] = []
  const dispatch = (intents: Intent[]) => dispatchCalls.push(intents)

  // The presenter, share ended, frame captured, no stillUrl yet -> stamps.
  const intent = screenshareStampIntent({
    id: 'shape:s1',
    trackKind: 'ended',
    lastFrame: 'data:image/jpeg;base64,AAA',
    currentStillUrl: undefined,
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
    nextStillUrl: '/uploads/screenstill-0-0',
  })
  assert.ok(intent, 'presenter, ended, captured frame, no existing stillUrl -> stamps')
  if (intent) dispatch([intent])
  assert.deepEqual(
    dispatchCalls,
    [[{ type: 'UpdateProps', id: 'shape:s1', props: { stillUrl: '/uploads/screenstill-0-0' } }]],
    'stamps UpdateProps with the uploaded still URL'
  )
  console.log('ok: screenshareStampIntent — presenter stamps the captured last frame via dispatch')
}

// SINGLE-WRITER: a viewer who is NOT the presenter must never stamp, even
// with an identical captured lastFrame and an ended track — otherwise every
// viewer watching the same stream would race to write the same prop.
{
  const intent = screenshareStampIntent({
    id: 'shape:s1',
    trackKind: 'ended',
    lastFrame: 'data:image/jpeg;base64,AAA',
    currentStillUrl: undefined,
    localParticipantId: 'p-bob', // viewer, not the sharer
    participantId: 'p-alice',
    nextStillUrl: '/uploads/screenstill-0-0',
  })
  assert.equal(intent, null, 'a non-presenter viewer never stamps — single-writer is the presenter only')
  console.log('ok: screenshareStampIntent — single-writer: only the presenter (participantId match) stamps')
}

// STAMP-LOOP GUARD: same presenter, same ended+lastFrame, but the candidate
// stillUrl is ALREADY the shape's current stillUrl -> no-op (a same-value
// dispatch would just re-render, re-observe the same state, and re-stamp
// forever).
{
  const intent = screenshareStampIntent({
    id: 'shape:s1',
    trackKind: 'ended',
    lastFrame: 'data:image/jpeg;base64,AAA',
    currentStillUrl: '/uploads/screenstill-0-0',
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
    nextStillUrl: '/uploads/screenstill-0-0',
  })
  assert.equal(intent, null, 'no dispatch when the candidate stillUrl already matches the current prop')
  console.log('ok: screenshareStampIntent — stamp-loop guard: no-ops when stillUrl would not actually change')
}

// Not yet ended (still 'connecting') -> no stamp, even with a held frame
// (e.g. a brief gap between subscription cycles, not a real share end).
{
  const intent = screenshareStampIntent({
    id: 'shape:s1',
    trackKind: 'connecting',
    lastFrame: 'data:image/jpeg;base64,AAA',
    currentStillUrl: undefined,
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
    nextStillUrl: '/uploads/screenstill-0-0',
  })
  assert.equal(intent, null, 'a merely-connecting gap never stamps — only a genuinely ENDED share does')
  console.log('ok: screenshareStampIntent — only an ended track stamps, not a connecting gap')
}

// No captured lastFrame at all -> no stamp (nothing to upload).
{
  const intent = screenshareStampIntent({
    id: 'shape:s1',
    trackKind: 'ended',
    lastFrame: null,
    currentStillUrl: undefined,
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
    nextStillUrl: '/uploads/screenstill-0-0',
  })
  assert.equal(intent, null, 'no captured lastFrame -> nothing to stamp')
  console.log('ok: screenshareStampIntent — no lastFrame -> no-op')
}

// --- screenshareAspectRelockIntent (Task D4): relock the tile's w/h to the
// attached video's true intrinsic aspect, reusing lockScreenShareAspect
// verbatim, single-writer (presenter) + a relock-loop guard ---
{
  const dispatchCalls: Intent[][] = []
  const dispatch = (intents: Intent[]) => dispatchCalls.push(intents)

  // Tile currently 16:9-ish (1280x748incl. header); video is actually 4:3.
  const intent = screenshareAspectRelockIntent({
    id: 'shape:s1',
    currentW: 1280,
    currentH: 748, // 720 video area + 28 header
    videoWidth: 1024,
    videoHeight: 768, // 4:3
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
  })
  assert.ok(intent, 'a real aspect mismatch relocks (width kept, height recomputed)')
  if (intent) dispatch([intent])
  assert.equal(dispatchCalls.length, 1)
  const [{ type, id, props }] = dispatchCalls[0] as [{ type: string; id: string; props: { w: number; h: number } }]
  assert.equal(type, 'UpdateProps')
  assert.equal(id, 'shape:s1')
  assert.equal(props.w, 1280, 'width is kept — the relock always keeps width, matching legacy\'s share.ts poll')
  // 1280 / (1024/768) + 28-header = 1280 * 3/4 + 28 = 960 + 28 = 988.
  assert.equal(props.h, 988, 'height follows the video\'s true aspect + the fixed header band')
  console.log('ok: screenshareAspectRelockIntent — relocks w/h to the video\'s true intrinsic aspect')
}

// SINGLE-WRITER: a non-presenter viewer's attached video reports the same
// mismatch, but must never relock — every viewer would otherwise compute
// and dispatch the identical UpdateProps simultaneously.
{
  const intent = screenshareAspectRelockIntent({
    id: 'shape:s1',
    currentW: 1280,
    currentH: 748,
    videoWidth: 1024,
    videoHeight: 768,
    localParticipantId: 'p-bob',
    participantId: 'p-alice',
  })
  assert.equal(intent, null, 'a non-presenter viewer never relocks — single-writer is the presenter only')
  console.log('ok: screenshareAspectRelockIntent — single-writer: only the presenter relocks')
}

// RELOCK-LOOP GUARD: the video's dimensions already match the tile's
// current aspect (within epsilon) -> no-op, so a converged tile never
// re-dispatches on every subsequent (no-op) `resize` event.
{
  // 1280 wide tile, 720 video area (748 - 28 header) -> exactly 16:9.
  const intent = screenshareAspectRelockIntent({
    id: 'shape:s1',
    currentW: 1280,
    currentH: 748,
    videoWidth: 1920,
    videoHeight: 1080, // also 16:9 — same ratio, different absolute size
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
  })
  assert.equal(intent, null, 'no dispatch when the corrected box is within epsilon of the current one')
  console.log('ok: screenshareAspectRelockIntent — relock-loop guard: no-ops when already converged')
}

// No usable intrinsic video size yet (e.g. metadata not loaded) -> no-op.
{
  const intent = screenshareAspectRelockIntent({
    id: 'shape:s1',
    currentW: 1280,
    currentH: 748,
    videoWidth: 0,
    videoHeight: 0,
    localParticipantId: 'p-alice',
    participantId: 'p-alice',
  })
  assert.equal(intent, null, 'no usable video dimensions -> no-op')
  console.log('ok: screenshareAspectRelockIntent — no intrinsic video size yet -> no-op')
}

// House rule (see canvas-react/src/embed/embed-reconciler.test.ts): explicit
// exit — ScreenshareShape's import graph pulls in livekit-client (via
// screenshare/store.ts) at module scope, which can hold the event loop open.
process.exit(0)
