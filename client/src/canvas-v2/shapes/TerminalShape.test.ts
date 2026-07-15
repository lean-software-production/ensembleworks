// Run: bun src/canvas-v2/shapes/TerminalShape.test.ts
//
// TEST-HARNESS LIMITATION (stated once, applies to this whole file): xterm.js
// mounts a real Terminal against a DOM container and TerminalShape.tsx
// imports '@xterm/xterm/css/xterm.css' at module scope — neither survives a
// plain `bun run` (no DOM emulator in this house rig; see canvas-react's
// embed/EmbedHost.tsx TEST-HARNESS LIMITATION note for the project's general
// posture on this). So this file tests ONLY the pure half: `terminalContentFrom`,
// the props->render-input adapter. Real mounting (xterm opens, the WS
// connects, the deterministic grid resizes it, focus swallows keys) is
// unproven by ANY test in this repo yet — proving it is G2-golden/H2 E2E
// territory, exactly as this unit's plan anticipated ("terminal/screenshare
// shells may render placeholder frames statically — verify" — verified here:
// they do NOT, because of the xterm import above, and that's an honest,
// stated limitation rather than a forced/fragile static render).
import assert from 'node:assert/strict'
import type { Shape } from '@ensembleworks/canvas-model'
import { terminalContentFrom } from './TerminalShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:t1', kind: 'terminal', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

// Full props round-trip.
{
  const shape = shapeWithProps({ w: 900, h: 500, sessionId: 'canvas-abc', title: 'my term', gateway: 'gw-1', fontSize: 20 })
  const content = terminalContentFrom(shape)
  assert.deepEqual(content, { w: 900, h: 500, sessionId: 'canvas-abc', title: 'my term', gateway: 'gw-1', fontSize: 20 })
}

// Missing/malformed props fall back to the same defaults as the legacy
// ShapeUtil's getDefaultProps (minus the min-size clamp, which only applies
// server/creation-side).
{
  const content = terminalContentFrom(shapeWithProps({}))
  assert.equal(content.sessionId, 'default')
  assert.equal(content.title, 'terminal')
  assert.equal(content.gateway, undefined)
  assert.equal(content.fontSize, 16)
  assert.ok(content.w > 0 && content.h > 0)
}

// Malformed types (wrong runtime type in the untyped props bag) fall back
// rather than propagating garbage into the render.
{
  const content = terminalContentFrom(shapeWithProps({ w: 'nope', sessionId: 42, fontSize: null }))
  assert.equal(typeof content.w, 'number')
  assert.equal(content.sessionId, 'default')
  assert.equal(content.fontSize, 16)
}

console.log('ok: TerminalShape — terminalContentFrom adapter (pure half only; see header for the static-render limitation)')
// House rule (see canvas-react/src/embed/embed-reconciler.test.ts): explicit
// exit — TerminalShape's import graph pulls in @xterm/xterm (+ its css) at
// module scope, which can hold the event loop open after the last assertion.
process.exit(0)
