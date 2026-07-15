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
// `screenshareContentFrom` + `screenshareStillTreatment`. Real mounting
// (LiveKit track attach/detach, suspend/resume) is G2-golden/H2 E2E
// territory — see TerminalShape.test.ts's identical note for the sibling
// heavy embed.
import assert from 'node:assert/strict'
import type { Shape } from '@ensembleworks/canvas-model'
import { screenshareContentFrom, screenshareStillTreatment } from './ScreenshareShape.js'

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
// House rule (see canvas-react/src/embed/embed-reconciler.test.ts): explicit
// exit — ScreenshareShape's import graph pulls in livekit-client (via
// screenshare/store.ts) at module scope, which can hold the event loop open.
process.exit(0)
