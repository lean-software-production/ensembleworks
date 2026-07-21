// Run: bun contracts/src/session-manager.test.ts
// Locks the TmuxSession primitive: resize clamp/changed logic + a real-PTY
// round-trip (spawn a shell, read output, resize, kill, observe exit). No tmux
// needed here — the tmux path stays covered by server/src/relay-loopback.test.ts.
import assert from 'node:assert/strict'
import os from 'node:os'
import { canvasShellSpawnSpec, canvasTmuxSpawnSpec, openTmuxSession } from './session-manager.js'

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

// Token scrub (spec §4.2): canvasTmuxSpawnSpec must strip the connector's
// service-token credential vars from the spawned terminal env so a hosted
// canvas terminal can never read them — while preserving TERM and WITHOUT
// mutating process.env (a shallow copy is scrubbed, not the live env).
process.env.ENSEMBLEWORKS_TOKEN_ID = 'id-xxx'
process.env.ENSEMBLEWORKS_TOKEN_SECRET = 'shhh-machine-cred'
process.env.CF_ACCESS_CLIENT_ID = 'cf-id'
process.env.CF_ACCESS_CLIENT_SECRET = 'cf-secret'
process.env.EW_BENIGN_MARKER = 'keep-me' // a non-scrubbed parent var that the copy must carry through
const scrubbed = canvasTmuxSpawnSpec({ sessionId: 't1' })
for (const k of ['ENSEMBLEWORKS_TOKEN_ID', 'ENSEMBLEWORKS_TOKEN_SECRET', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
	assert.equal(k in scrubbed.env, false, `${k} must not leak into the spawn env`)
}
assert.equal(scrubbed.env.TERM, 'xterm-256color', 'scrub must not clobber TERM')
// Prove the parent env is actually carried through (not that TERM is set unconditionally):
// a non-scrubbed parent var survives the copy.
assert.equal(scrubbed.env.EW_BENIGN_MARKER, 'keep-me', 'non-scrubbed parent vars must survive the copy')
assert.equal(process.env.ENSEMBLEWORKS_TOKEN_SECRET, 'shhh-machine-cred', 'process.env must NOT be mutated (shallow copy scrubbed)')
delete process.env.ENSEMBLEWORKS_TOKEN_ID
delete process.env.ENSEMBLEWORKS_TOKEN_SECRET
delete process.env.CF_ACCESS_CLIENT_ID
delete process.env.CF_ACCESS_CLIENT_SECRET
delete process.env.EW_BENIGN_MARKER
console.log('ok: canvasTmuxSpawnSpec scrubs the service-token from the spawned terminal env')

// UTF-8 locale guarantee: a tmux client with no LC_CTYPE-affecting var in its
// env comes up non-UTF-8 and renders every non-Latin-1 glyph as "_" per cell
// (bit us on staging: systemd units don't inherit the host locale). The spawn
// spec must default LANG=C.UTF-8 when the parent env carries no locale — and
// must NOT override a locale the parent did set.
const savedLocale: Record<string, string | undefined> = {}
for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
	savedLocale[k] = process.env[k]
	delete process.env[k]
}
const bare = canvasTmuxSpawnSpec({ sessionId: 't2' })
assert.equal(bare.env.LANG, 'C.UTF-8', 'locale-less parent env must default LANG=C.UTF-8')
process.env.LANG = 'en_GB.UTF-8'
const localed = canvasTmuxSpawnSpec({ sessionId: 't3' })
assert.equal(localed.env.LANG, 'en_GB.UTF-8', 'a parent-set LANG must be preserved, not clobbered')
delete process.env.LANG
process.env.LC_ALL = 'en_US.UTF-8'
const lcAllOnly = canvasTmuxSpawnSpec({ sessionId: 't4' })
assert.equal('LANG' in lcAllOnly.env, false, 'LC_ALL alone counts as a locale — no LANG default injected')
delete process.env.LC_ALL
for (const [k, v] of Object.entries(savedLocale)) if (v !== undefined) process.env[k] = v
console.log('ok: canvasTmuxSpawnSpec guarantees a UTF-8 locale for the tmux client')

// canvasShellSpawnSpec (EW Codespaces §6.1): the raw-login-shell spawn policy.
// Same env hygiene as canvasTmuxSpawnSpec (credential scrub, xterm-256color,
// C.UTF-8 guarantee), but the file is the user's shell and there is no tmux.
{
  const prev = {
    tokenId: process.env.ENSEMBLEWORKS_TOKEN_ID,
    tokenSecret: process.env.ENSEMBLEWORKS_TOKEN_SECRET,
    shell: process.env.SHELL,
    lang: process.env.LANG,
    lcAll: process.env.LC_ALL,
    lcCtype: process.env.LC_CTYPE,
  }
  try {
    process.env.ENSEMBLEWORKS_TOKEN_ID = 'tid'
    process.env.ENSEMBLEWORKS_TOKEN_SECRET = 'tsec'

    // Explicit opts win.
    const spec = canvasShellSpawnSpec({ shell: '/bin/bash', home: '/tmp' })
    assert.equal(spec.file, '/bin/bash', 'explicit shell wins')
    assert.deepEqual(spec.args, ['-l'], 'login shell, no tmux args')
    assert.equal(spec.cwd, '/tmp', 'explicit home wins')
    assert.equal(spec.env.TERM, 'xterm-256color')
    assert.equal(spec.env.COLORFGBG, '0;15')
    assert.ok(!('ENSEMBLEWORKS_TOKEN_ID' in spec.env), 'token id scrubbed')
    assert.ok(!('ENSEMBLEWORKS_TOKEN_SECRET' in spec.env), 'token secret scrubbed')

    // Shell default chain: $SHELL, then /bin/bash.
    process.env.SHELL = '/usr/bin/fish'
    assert.equal(canvasShellSpawnSpec().file, '/usr/bin/fish', 'defaults to $SHELL')
    delete process.env.SHELL
    assert.equal(canvasShellSpawnSpec().file, '/bin/bash', 'falls back to /bin/bash')

    // Locale guarantee (the LC_CTYPE foot-gun): no locale var → LANG=C.UTF-8;
    // an operator's own locale is never overridden.
    delete process.env.LANG
    delete process.env.LC_ALL
    delete process.env.LC_CTYPE
    assert.equal(canvasShellSpawnSpec().env.LANG, 'C.UTF-8', 'LANG guaranteed when no locale var set')
    process.env.LC_ALL = 'en_GB.UTF-8'
    assert.ok(!('LANG' in canvasShellSpawnSpec().env) || canvasShellSpawnSpec().env.LANG !== 'C.UTF-8', 'operator locale not overridden')
  } finally {
    for (const [k, v] of [
      ['ENSEMBLEWORKS_TOKEN_ID', prev.tokenId],
      ['ENSEMBLEWORKS_TOKEN_SECRET', prev.tokenSecret],
      ['SHELL', prev.shell],
      ['LANG', prev.lang],
      ['LC_ALL', prev.lcAll],
      ['LC_CTYPE', prev.lcCtype],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  console.log('ok: canvasShellSpawnSpec — shell resolution, env hygiene, locale guarantee')
}

// Round-trip a REAL shell through canvasShellSpawnSpec — no tmux involved:
// spawn, echo a marker, then `exit` and observe onExit. Shell is forced to
// bash for determinism (CI boxes may not set $SHELL).
{
  const spec = canvasShellSpawnSpec({ shell: 'bash', home: os.tmpdir() })
  const sh = openTmuxSession(spec, 80, 24)
  let acc = ''
  const ready = new Promise<void>((resolve) => {
    sh.onData((d) => {
      acc += d
      if (acc.includes('PTY_OK')) resolve()
    })
  })
  const gone = new Promise<void>((resolve) => sh.onExit(() => resolve()))
  sh.write('printf PTY_OK\r')
  await Promise.race([
    ready,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`no PTY_OK in 5s; got: ${acc.slice(-300)}`)), 5000)),
  ])
  sh.write('exit\r')
  await Promise.race([
    gone,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('shell did not exit in 5s')), 5000)),
  ])
  console.log('ok: raw shell round-trip through canvasShellSpawnSpec (no tmux)')
}

process.exit(0)
