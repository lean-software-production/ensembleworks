// Run: bun contracts/src/session-manager.test.ts
// Locks the TmuxSession primitive: resize clamp/changed logic + a real-PTY
// round-trip (spawn a shell, read output, resize, kill, observe exit). No tmux
// needed here — the tmux path stays covered by server/src/relay-loopback.test.ts.
import assert from 'node:assert/strict'
import os from 'node:os'
import { openTmuxSession } from './session-manager.js'

const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>

// A shell that emits output immediately, then stays alive so we can resize it.
const s = openTmuxSession(
  { file: 'bash', args: ['--noprofile', '--norc', '-c', 'printf READY; sleep 2'], cwd: os.tmpdir(), env },
  80,
  24,
)
assert.equal(s.cols, 80, 'initial cols')
assert.equal(s.rows, 24, 'initial rows')

// Accumulate chunks (PTY output can arrive split) until we see the marker.
let acc = ''
const gotData = new Promise<string>((resolve) => {
  s.onData((d) => {
    acc += d
    if (acc.includes('READY')) resolve(acc)
  })
})
const exited = new Promise<void>((resolve) => s.onExit(() => resolve()))

await Promise.race([
  gotData,
  new Promise<string>((_, reject) => setTimeout(() => reject(new Error('no PTY "READY" in 2s')), 2000)),
])
assert.ok(acc.includes('READY'), 'shell output round-trips through the PTY')

// resize: clamp cols[20..500]/rows[5..200], integer-only, no-op when unchanged.
assert.equal(s.resize(120, 40), true, 'a real change applies')
assert.equal(s.cols, 120)
assert.equal(s.rows, 40)
assert.equal(s.resize(120, 40), false, 'unchanged size is a no-op')
assert.equal(s.resize(5, 2), true, 'below-min applies (clamped)')
assert.equal(s.cols, 20, 'cols clamps up to 20')
assert.equal(s.rows, 5, 'rows clamps up to 5')
assert.equal(s.resize(9999, 9999), true, 'above-max applies (clamped)')
assert.equal(s.cols, 500, 'cols clamps down to 500')
assert.equal(s.rows, 200, 'rows clamps down to 200')
assert.equal(s.resize(80.5, 24), false, 'non-integer is rejected')
assert.equal(s.cols, 500, 'rejected resize leaves size unchanged')

// kill → onExit fires.
s.kill()
await Promise.race([
  exited,
  new Promise<void>((_, reject) => setTimeout(() => reject(new Error('onExit did not fire in 2s')), 2000)),
])

console.log('ok: TmuxSession primitive')
process.exit(0)
