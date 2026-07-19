// Run: bun src/presence.test.ts
import assert from 'node:assert/strict'
import { PresenceStore, type Presence } from './presence.js'

// NOTE: a plain `function` declaration, not `(x, y) => ({...})`. A parenthesized-
// object arrow body immediately followed (even across blank lines) by a
// top-level bare block `{ ... }` trips a genuine tsc 5.7 parser quirk here —
// probe-confirmed with tsc directly: it mis-lexes the FIRST simple-literal
// property value in the object (e.g. `foo: null` or even `foo: 1`) as if it
// were reinterpreting the block that follows, throwing bogus "'null' is a
// reserved word" / "'=>' expected" errors at parse time. Property values that
// are non-trivial expressions (arrays, spreads) don't trigger it, which is
// what let server-peer.test.ts's `base`/`shape`/`normalize` helpers dodge it
// unnoticed. Sidestepped entirely by using a function declaration.
function cursorAt(x: number, y: number): Presence {
  return { cursor: { x, y }, viewport: null, stamp: null, presenting: [] }
}

// NOTE: every store created below is .destroy()ed at the end of its block.
// EphemeralStore runs a periodic expiry-cleanup timer while non-empty
// (probe-confirmed: an un-destroyed store held this process open for ~45s
// after the last assertion) — destroy() releases it so the suite exits fast.

// --- (1) two stores cross-wired: A's local publish reaches B, and vice versa ---
{
  const a = new PresenceStore('peerA')
  const b = new PresenceStore('peerB')
  a.onLocalUpdate((bytes) => b.apply(bytes))
  b.onLocalUpdate((bytes) => a.apply(bytes))

  a.publish(cursorAt(1, 2))
  assert.deepEqual(b.all()['peerA']?.cursor, { x: 1, y: 2 }, "B sees A's published cursor")

  b.publish(cursorAt(9, 9))
  assert.deepEqual(a.all()['peerB']?.cursor, { x: 9, y: 9 }, "A sees B's published cursor")

  // Both keys visible on both sides (merge, not overwrite).
  assert.deepEqual(Object.keys(a.all()).sort(), ['peerA', 'peerB'])
  assert.deepEqual(Object.keys(b.all()).sort(), ['peerA', 'peerB'])

  a.destroy()
  b.destroy()
}

// --- (2) same key published twice: LWW keeps the latest value ---
// TIMING-DEPENDENT (probe-confirmed): EphemeralStore's LWW timestamp has
// millisecond granularity. Two set() calls back-to-back in the same tick can
// land in the same millisecond, and Loro's tie-break for equal timestamps is
// NOT "last call wins" (probe: publishing (1,1) then (2,2) with no delay
// non-deterministically kept (1,1)). A tiny sleep guarantees distinct
// timestamps so this asserts genuine LWW-by-recency rather than racing an
// internal tie-break we don't control. This is the one place in this suite
// that depends on wall-clock progression rather than pure logic.
{
  const a = new PresenceStore('peerA')
  const b = new PresenceStore('peerB')
  a.onLocalUpdate((bytes) => b.apply(bytes))

  a.publish(cursorAt(1, 1))
  await Bun.sleep(2)
  a.publish(cursorAt(2, 2))

  assert.deepEqual(b.all()['peerA']?.cursor, { x: 2, y: 2 }, 'the latest publish wins (LWW)')
  assert.equal(Object.keys(b.all()).length, 1, 'still a single entry for the repeatedly-published key')

  a.destroy()
  b.destroy()
}

// --- (3) encodeAll()/apply bootstraps a fresh third store to full state ---
{
  const a = new PresenceStore('peerA')
  const b = new PresenceStore('peerB')
  a.onLocalUpdate((bytes) => b.apply(bytes))
  b.onLocalUpdate((bytes) => a.apply(bytes))

  a.publish(cursorAt(3, 3))
  b.publish(cursorAt(4, 4))

  const c = new PresenceStore('peerC')
  c.apply(a.encodeAll())

  assert.deepEqual(c.all()['peerA']?.cursor, { x: 3, y: 3 }, 'bootstrap carries peerA state')
  assert.deepEqual(c.all()['peerB']?.cursor, { x: 4, y: 4 }, 'bootstrap carries peerB state')
  assert.deepEqual(Object.keys(c.all()).sort(), ['peerA', 'peerB'], 'no extra/missing keys from the snapshot')

  a.destroy()
  b.destroy()
  c.destroy()
}

// --- (4) fuller payload shape: viewport/stamp/presenting round-trip untouched ---
{
  const a = new PresenceStore('peerA')
  const b = new PresenceStore('peerB')
  a.onLocalUpdate((bytes) => b.apply(bytes))

  const full: Presence = {
    cursor: { x: 5, y: 6 },
    viewport: { x: 0, y: 0, w: 800, h: 600, z: 1 },
    stamp: { at: { x: 7, y: 8 } },
    presenting: ['shape:a', 'shape:b'],
  }
  a.publish(full)

  assert.deepEqual(b.all()['peerA'], full, 'the full presence payload round-trips through onLocalUpdate/apply')

  a.destroy()
  b.destroy()
}

// --- (5) pilot 5: `editing` round-trips through onLocalUpdate/apply AND
// survives an encodeAll()/apply() bootstrap, exactly like the other fields
// (mirrors case (4)'s live round-trip and case (3)'s bootstrap pattern) ---
{
  const a = new PresenceStore('peerA')
  const b = new PresenceStore('peerB')
  a.onLocalUpdate((bytes) => b.apply(bytes))

  const editing: Presence = { cursor: null, viewport: null, stamp: null, presenting: [], editing: 'shape:note1' }
  a.publish(editing)

  assert.deepEqual(b.all()['peerA'], editing, "editing round-trips through onLocalUpdate/apply, live")

  const c = new PresenceStore('peerC')
  c.apply(a.encodeAll())
  assert.equal(c.all()['peerA']?.editing, 'shape:note1', 'editing survives an encodeAll()/apply() bootstrap too')

  // Ending the edit (editing: null) round-trips as null, not a missing key.
  await Bun.sleep(2)
  a.publish({ ...editing, editing: null })
  assert.equal(b.all()['peerA']?.editing, null, 'editing: null round-trips (end-of-edit) — not left stuck at the prior shape id')

  a.destroy()
  b.destroy()
  c.destroy()
}

// NOTE: no timeout-expiry assertions here (wall-clock, non-deterministic) —
// EphemeralStore's internal timer is out of scope for this deterministic suite.

console.log('ok: presence')
