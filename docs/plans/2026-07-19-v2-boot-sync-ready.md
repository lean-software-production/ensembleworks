# v2 Boot Sync-Ready Signal — Replace the Fixed 400ms Settle Sleep

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the unconditional 400ms boot sleep in the v2 canvas engine
(`CanvasV2App.boot()`) and replace it with a real sync-readiness signal, so a
dogfood room proceeds the instant sync completes instead of paying a fixed tax
that doesn't even guarantee what it waits for.

**Architecture:** Add an additive protocol frame `Frame.SyncDone = 4`. The
server (`SyncServerPeer.handleFrame`) sends it immediately after the backfill
`Update` reply to a `SyncRequest`. The client (`SyncClientPeer`) exposes
`ready(): Promise<void>` that resolves when `SyncDone` is received (after the
preceding backfill Update has already been imported — frames dispatch
synchronously and in order). `CanvasV2App.boot()` replaces `await delay(...)`
with `await Promise.race([peer.ready(), delay(cap)])` — the timer becomes a
safety CAP for a pathological non-signalling transport, not a fixed wait.

**Why it's deploy-safe:** `protocol.ts` has no versioning and BOTH peers
deliberately ignore unknown frame tags, so an additive frame degrades
gracefully (old client + new server and vice versa). Client and server are
co-deployed from this one repo; there are no third-party peers.

**Tech stack:** Bun workspaces; TypeScript. Packages touched: `canvas-sync`
(protocol + peers, clean-room — never imports server/tldraw/ws/client) and
`client/src/canvas-v2` (the dogfood mount). No `server`-workspace code changes:
the room host wraps `SyncServerPeer` as a black box, so `SyncDone` emission
comes for free.

---

## Toolchain notes (read before starting)

- **Run one test file:** `bun <path>` (e.g. `bun canvas-sync/src/protocol.test.ts`).
  This is the fast per-task loop.
- **Full test suite:** `bun run test` (which runs `bun scripts/run-tests.ts`,
  globbing `**/src/**/*.test.ts` + `scripts/*.test.ts`). NOTE: `bun test`
  (Bun's own runner) is NOT the same thing — always use `bun run test`.
- **Typecheck (repo-wide):** `bun run typecheck`.
- **`CLAUDE.md` is a symlink to `AGENTS.md`** — never edit both; edit `AGENTS.md`
  if you must (you won't need to here).
- **Clean-room boundary (`canvas-sync/src/boundary.test.ts`):** every
  non-`.test.ts` file under `canvas-sync/src/` is text-scanned — it must not
  import `ws`/`express`/`server`/`@tldraw/*` and must not call
  `Date.now(`/`Math.random(`. `.test.ts` files are exempt (may inject/measure
  freely) and MAY import `@ensembleworks/canvas-model`/`canvas-doc`.
  **`canvas-sync` must never import client code** (e.g. `bootstrap-page.ts`) —
  the reverse (client importing canvas-sync) is fine.
- **ux-contract presence gate (`scripts/ux-contract-presence.test.ts`):** a diff
  touching `client/src/canvas-v2/` (which this one does) must either co-touch
  the interaction-contracts module OR carry a `ux-contract: none — <reason>`
  line in the PR body. This work is boot sequencing, not a gesture/observable
  surface, so we take the **opt-out** (see Task 8 for the exact line). Because
  of this, the full-suite run in Tasks 6–8 must set `UX_CONTRACT_PR_BODY` (the
  gate's real-diff check reads it) — Tasks 1–5 touch only `canvas-sync` (not an
  interaction-bearing path), so verify those with the single-file command.
- **Commit frequently**, conventional-commit messages, exact `git add` of the
  files each task names (so no intentionally-red-then-fixed file is ever
  committed mid-red).
- **RED-first is non-negotiable:** for each implementation task, write the
  failing test, run it, confirm it fails with the expected message, THEN
  implement, THEN confirm green, THEN commit. Record the verbatim RED output in
  your execution notes. If a RED proves unreachable, STOP and report — do not
  force it.

**Placement decision for the required race-demonstration RED (requirement from
the assessment):** it lives in `canvas-sync` (Task 3), using a gated transport
plus the empty-doc page-bootstrap logic **replicated inline** (via
`canvas-model`'s `canonicalPageId`) — this respects the clean-room boundary
(`canvas-sync` cannot import client-side `resolvePageId`) and is fully
deterministic. A second, client-layer confirmation using the REAL
`resolvePageId` lands in Task 6.

---

## Task 0 — Verify the branch (no code change)

The repo owner's instruction was "pull main and branch off of it for the fix."
This was already done: `main` was pulled after PR #47 merged and branch
`fix/v2-boot-sync-ready` was created from it. Confirm rather than redo.

**Steps:**

```
git fetch origin
git status
git rev-parse --abbrev-ref HEAD
```

**Expected:** `On branch fix/v2-boot-sync-ready`, `nothing to commit, working
tree clean`, and the branch name `fix/v2-boot-sync-ready`. (HEAD should be at
`release: 0.21.0` = commit `0334c7e`.) If any of that is wrong, STOP and report.

No commit for this task.

---

## Task 1 — Add `Frame.SyncDone = 4` to the protocol

### 1a — RED: extend the protocol round-trip test

Edit `canvas-sync/src/protocol.test.ts` line 6 — add `Frame.SyncDone` to the
round-trip loop:

```ts
for (const tag of [Frame.Update, Frame.Presence, Frame.SyncRequest, Frame.SyncDone]) {
```

Run:

```
bun canvas-sync/src/protocol.test.ts
```

**EXPECT FAIL** — `Frame.SyncDone` is `undefined`, so the encoded tag byte is
coerced to `0` and the round-trip assertion fails, roughly:

```
AssertionError [ERR_ASSERTION]: tag round-trips for Frame undefined
  0 !== undefined
```

### 1b — GREEN: define the frame

Edit `canvas-sync/src/protocol.ts` line 4:

```ts
export const Frame = { Update: 1, Presence: 2, SyncRequest: 3, SyncDone: 4 } as const
```

Run `bun canvas-sync/src/protocol.test.ts` → **EXPECT PASS** (`ok: protocol`).

### 1c — Commit

```
git add canvas-sync/src/protocol.ts canvas-sync/src/protocol.test.ts
git commit -m "feat(canvas-sync): add additive Frame.SyncDone tag to the sync protocol"
```

---

## Task 2 — Server sends `SyncDone` after the backfill reply

### 2a — RED: pin the reply sequence

Add this case to `canvas-sync/src/server-peer.test.ts`, just before the final
`console.log('ok: server-peer')`:

```ts
// --- (new) a SyncRequest is answered with the backfill Update THEN a SyncDone
// signal — so a client can proceed the instant it's caught up (ready()) rather
// than guessing with a fixed settle timer. ---
{
  const server = new SyncServerPeer({ peerId: 77n })
  server.doc.putPage({ id: 'page:p', name: 'P' })
  server.doc.putShape(shape('shape:seed'))
  server.doc.commit()

  const [serverEnd, clientEnd] = makePair()
  server.connect(serverEnd)
  const tags: number[] = []
  clientEnd.onMessage((frame) => tags.push(decode(frame).tag))
  clientEnd.send(encode(Frame.SyncRequest, LoroCanvasDoc.create({ peerId: 771n }).versionBytes()))

  assert.deepEqual(
    tags,
    [Frame.Update, Frame.SyncDone],
    'a SyncRequest is answered with the backfill Update followed by a SyncDone signal',
  )
}
```

(`LoroCanvasDoc`, `decode`, `Frame`, `encode`, `makePair`, `shape` are all
already imported at the top of that file.)

Run:

```
bun canvas-sync/src/server-peer.test.ts
```

**EXPECT FAIL** — the server only replies with the `Update` today:

```
AssertionError [ERR_ASSERTION]: a SyncRequest is answered with the backfill Update followed by a SyncDone signal
  [ 1 ] deepEqual [ 1, 4 ]
```

### 2b — GREEN: emit the signal

Edit `canvas-sync/src/server-peer.ts`. Add a module-level constant just after
the imports (before `export interface SyncServerOpts`):

```ts
/** Zero-length payload for signal-only frames (Frame.SyncDone carries no
 * bytes — its arrival IS the signal). */
const EMPTY_PAYLOAD = new Uint8Array(0)
```

Then in `handleFrame`, replace the `SyncRequest` branch (currently around
line 130):

```ts
    if (tag === Frame.SyncRequest) {
      // Reply with exactly the delta this client is missing.
      from.send(encode(Frame.Update, this.doc.exportUpdate(payload)))
    }
```

with:

```ts
    if (tag === Frame.SyncRequest) {
      // Reply with exactly the delta this client is missing, then signal that
      // the backfill is complete (Frame.SyncDone). Ordering is load-bearing:
      // the Update is sent first, so a client awaiting readiness on the
      // following SyncDone has already imported the backfill by the time it
      // resolves (frames dispatch in order; handleFrame is synchronous per
      // frame). This is what lets SyncClientPeer.ready() replace the dogfood
      // mount's fixed settle timer.
      from.send(encode(Frame.Update, this.doc.exportUpdate(payload)))
      from.send(encode(Frame.SyncDone, EMPTY_PAYLOAD))
    }
```

Run `bun canvas-sync/src/server-peer.test.ts` → **EXPECT PASS**
(`ok: server-peer`).

Also run `bun canvas-sync/src/client-peer.test.ts` → **EXPECT PASS** — the
client currently ignores the new `SyncDone` frame (unknown-tag tolerance), so
existing convergence tests are unaffected. This is the deploy-safety property
in action.

### 2c — Commit

```
git add canvas-sync/src/server-peer.ts canvas-sync/src/server-peer.test.ts
git commit -m "feat(canvas-sync): server sends Frame.SyncDone after answering a SyncRequest"
```

---

## Task 3 — `SyncClientPeer.ready()` resolves on `SyncDone` (and the race demo)

This task also carries the **required deterministic race demonstration**: with
the backfill held, resolving the page id early bootstraps a redundant page;
gating on `ready()` first adopts the server's real page.

> ### CHANGE NOTE — 2026-07-19 (Task 3a: isolate per-demo servers — cross-demo contamination via pass-through sends)
>
> **What happened.** An implementer executing Task 3a hit a real defect in the
> plan's own test code (not in the `ready()` design, which is correct as
> written). The original 3a race block declared a SINGLE
> `const server = new SyncServerPeer({ peerId: 91n })` seeded with `page:xyz`
> and reused it for BOTH the unguarded and the guarded sub-demonstrations. The
> guarded assertion `existing === 'page:xyz'` failed:
>
> ```
> AssertionError: after ready(), the server page is visible and adopted
>   actual: "page:p", expected: "page:xyz"
> ```
>
> **The mechanism.** `gatedClientTransport` holds only server→client frames;
> **client→server sends pass straight through** (`send: (b) => raw.send(b)`).
> In the unguarded sub-demo, `clientA.doc.putPage({id:'page:p',...})` +
> `commit()` fires `subscribeLocalUpdates` synchronously, so that write reaches
> the SHARED server immediately — contaminating its doc with `page:p` BEFORE
> `clientB`'s handshake even runs. `clientB`'s backfill therefore carries BOTH
> pages, and `canonicalPageId` (lexicographically smallest) returns `page:p` <
> `page:xyz`, so the guarded demo adopts the wrong page. The implementer
> verified (scratch, uncommitted) that giving the guarded sub-demo its OWN
> server makes everything pass: `readyResolved` false while held, adopts
> `page:xyz`, no redundant page.
>
> **What changed (below).** 3a's sub-demo (b) is split into two sibling blocks,
> each with its OWN `SyncServerPeer` seeded identically with `page:xyz`:
> unguarded keeps `peerId: 91n`; guarded uses a fresh `peerId: 93n` (92n is
> Task 4's; 90/91 already used — 93n is collision-free). A comment makes the
> isolation's reason explicit (it is load-bearing, not incidental): local
> writes pass through the gate to the server synchronously, so a shared server
> would let one demo's bootstrap leak into the other's backfill. The unguarded
> assertion is unchanged (`['page:p','page:xyz']` after release stays correct
> with its own server). The initial RED is unchanged:
> `TypeError: client.ready is not a function` (sub-demo (a) reaches `ready()`
> first, before it exists); no other expected RED/GREEN text in Task 3 moves.
>
> **Other tasks re-checked for the same hazard — NOT exposed.** Task 4
> (reconnect, own server 92n): a single client + single server, one demo, and
> the client performs NO local writes before its handshakes, so the empty
> reconnect backfill it pushes carries nothing — no second demo to pollute.
> Task 6 (client-layer, own server 1n): a single client + single server, one
> demo, no local writes before `ready()`, and `resolvePageId` writes nothing
> because `page:xyz` is already visible after `ready()`. Neither shares a
> server across demos, so the contamination mechanism cannot arise.

### 3a — RED: the readiness signal + the race

First, edit the imports at the top of `canvas-sync/src/client-peer.test.ts`:

- change `import { checkInvariants } from '@ensembleworks/canvas-model'` to
  `import { canonicalPageId, checkInvariants } from '@ensembleworks/canvas-model'`
- change `import { Frame, encode } from './protocol.js'` to
  `import { Frame, encode, type Transport } from './protocol.js'`

Next, add this **module-scope helper** immediately after the imports (both
Task 3 and Task 4 use it):

```ts
/** A transport wrapper that HOLDS every server→client frame until release() —
 * client→server sends pass straight through. Lets a test freeze the backfill
 * mid-handshake deterministically (no timers), the same "defer a delivery"
 * idea soak.ts's deferred queue uses, scoped to one direction. */
function gatedClientTransport(raw: Transport): { transport: Transport; release: () => void } {
  let deliver: ((b: Uint8Array) => void) | null = null
  const held: Uint8Array[] = []
  let released = false
  raw.onMessage((b) => { if (released) deliver?.(b); else held.push(b) })
  return {
    transport: {
      send: (b) => raw.send(b),
      onMessage: (cb) => { deliver = cb },
      onClose: (cb) => raw.onClose(cb),
      close: () => raw.close(),
    },
    release: () => { released = true; for (const b of held.splice(0)) deliver?.(b) },
  }
}
```

Then add this case just before the final `console.log('ok: client-peer')`:

```ts
// --- (new) ready(): resolves on the server's backfill + SyncDone; empty room
// resolves promptly; and gating page-resolution on it avoids the redundant-page
// race the dogfood settle timer used to paper over. ---
{
  // (a) EMPTY brand-new room still resolves ready() promptly — the server
  // always answers a SyncRequest (even with an empty backfill) + SyncDone.
  {
    const server = new SyncServerPeer({ peerId: 90n })
    const [serverEnd, clientEnd] = makePair()
    server.connect(serverEnd)
    const client = new SyncClientPeer({ peerId: 901n, transport: clientEnd })
    let resolved = false
    client.ready().then(() => { resolved = true })
    await Promise.resolve() // flush microtasks
    assert.ok(resolved, 'ready() resolves for an empty room (server always sends a backfill reply + SyncDone)')
  }

  // (b) THE RACE. Each sub-demo gets its OWN server, seeded identically with a
  // real page 'page:xyz'. They MUST NOT share a server: gatedClientTransport
  // holds only server→client frames — a client's own writes (putPage + commit)
  // fire subscribeLocalUpdates synchronously and pass STRAIGHT THROUGH the gate
  // to the server. A shared server would therefore let the unguarded demo's
  // bootstrapped 'page:p' land on the server before the guarded demo's
  // handshake, contaminating its backfill so canonicalPageId (smallest id)
  // wrongly resolves to 'page:p'. The isolation is load-bearing, not
  // incidental. The page-bootstrap logic client/src/canvas-v2/bootstrap-page.ts
  // runs is replicated inline here (canonicalPageId → bootstrap 'page:p' iff no
  // page is visible) because canvas-sync must never import client code
  // (clean-room boundary).

  // Unguarded (the race): resolve BEFORE the backfill drains -> redundant page.
  {
    const server = new SyncServerPeer({ peerId: 91n })
    server.doc.putPage({ id: 'page:xyz', name: 'Real' })
    server.doc.commit()

    const [serverEndA, clientEndRawA] = makePair()
    server.connect(serverEndA)
    const gateA = gatedClientTransport(clientEndRawA)
    const clientA = new SyncClientPeer({ peerId: 911n, transport: gateA.transport })
    assert.equal(clientA.doc.listPages().length, 0, 'precondition: backfill held, client doc has no pages yet')
    if (!canonicalPageId(clientA.doc.listPages())) { clientA.doc.putPage({ id: 'page:p', name: 'Canvas' }); clientA.doc.commit() }
    gateA.release()
    assert.deepEqual(
      clientA.doc.listPages().map((p) => p.id).sort(),
      ['page:p', 'page:xyz'],
      'resolving the page id BEFORE the backfill drains bootstraps a redundant page:p — the race the fixed settle sleep only guessed at',
    )
  }

  // Guarded (the fix): await ready() first, then resolve -> adopts page:xyz.
  // Its OWN server (peerId 93n) so the unguarded demo's stray 'page:p' write
  // can never leak in (see the block comment above on pass-through sends).
  {
    const server = new SyncServerPeer({ peerId: 93n })
    server.doc.putPage({ id: 'page:xyz', name: 'Real' })
    server.doc.commit()

    const [serverEndB, clientEndRawB] = makePair()
    server.connect(serverEndB)
    const gateB = gatedClientTransport(clientEndRawB)
    const clientB = new SyncClientPeer({ peerId: 912n, transport: gateB.transport })
    const ready = clientB.ready()
    let readyResolved = false
    ready.then(() => { readyResolved = true })
    await Promise.resolve()
    assert.equal(readyResolved, false, 'ready() does NOT resolve while the backfill is held')
    gateB.release()
    await ready
    const existing = canonicalPageId(clientB.doc.listPages())
    if (!existing) { clientB.doc.putPage({ id: 'page:p', name: 'Canvas' }); clientB.doc.commit() }
    assert.equal(existing, 'page:xyz', 'after ready(), the server page is visible and adopted')
    assert.deepEqual(clientB.doc.listPages().map((p) => p.id), ['page:xyz'], 'no redundant page:p when page-resolution is gated on ready()')
  }
}
```

Run:

```
bun canvas-sync/src/client-peer.test.ts
```

**EXPECT FAIL** — `ready()` does not exist yet:

```
TypeError: client.ready is not a function
```

### 3b — GREEN: implement `ready()`

Edit `canvas-sync/src/client-peer.ts`.

Add two private fields to the class (near the other private fields, after
`private lastBackfillBytesValue = 0`):

```ts
  private syncDone!: Promise<void>
  private resolveSyncDone!: () => void
```

In the constructor, insert `this.armReady()` immediately before
`this.wireTransport(this.transport)`:

```ts
    this.unsubPresence = this.presence?.onLocalUpdate((bytes) => this.transport.send(encode(Frame.Presence, bytes)))
    // Arm the readiness promise BEFORE wiring the transport / sending the
    // SyncRequest: over a synchronous transport the server's SyncDone reply
    // lands inside requestSync(), so resolveSyncDone must already exist.
    this.armReady()
    this.wireTransport(this.transport)
    // Ask the server for anything we're missing.
    this.requestSync()
```

Add these two members (place them right after `requestSync()` / before
`reconnect()`):

```ts
  /** (Re)arm the readiness promise. Called from the constructor and from every
   * reconnect(), each of which sends a fresh Frame.SyncRequest — so ready()
   * always reflects the MOST RECENT handshake, never a stale one-shot resolve
   * left over from a prior connection. */
  private armReady(): void {
    this.syncDone = new Promise<void>((resolve) => { this.resolveSyncDone = resolve })
  }

  /** Resolves once the server has answered THIS peer's current SyncRequest with
   * its backfill Update and the closing Frame.SyncDone — i.e. this peer is
   * caught up to everything the server held at handshake time. Frames dispatch
   * synchronously and in order (the memory transport and a real WebSocket both
   * deliver in order; handleFrame is synchronous per frame), so by the time
   * SyncDone is handled the preceding backfill Update has already been
   * imported. The dogfood mount (CanvasV2App.boot) races this against a bounded
   * cap so it proceeds the instant sync completes instead of paying a fixed
   * settle delay. Re-armed on reconnect(), so it is never a one-shot lie. */
  ready(): Promise<void> { return this.syncDone }
```

In `handleFrame`, add a `SyncDone` branch after the `Presence` branch (before
the `// Unknown tags: deliberately ignored.` comment):

```ts
    } else if (tag === Frame.SyncDone) {
      // The server has finished answering our SyncRequest (its backfill Update
      // was sent just before this) — release anyone awaiting ready(). Resolving
      // an already-resolved promise is a harmless no-op, so a stray/duplicate
      // SyncDone is safe.
      this.resolveSyncDone()
    }
```

Run `bun canvas-sync/src/client-peer.test.ts` → **EXPECT PASS**
(`ok: client-peer`).

### 3c — Commit

```
git add canvas-sync/src/client-peer.ts canvas-sync/src/client-peer.test.ts
git commit -m "feat(canvas-sync): SyncClientPeer.ready() resolves on Frame.SyncDone"
```

---

## Task 4 — `reconnect()` re-arms `ready()`

### 4a — RED: re-arm on reconnect

Add this case to `canvas-sync/src/client-peer.test.ts` just before the final
`console.log('ok: client-peer')` (it reuses the module-scope
`gatedClientTransport` from Task 3):

```ts
// --- (new) reconnect() re-arms ready(): a fresh handshake means ready() awaits
// the NEW SyncDone, never a stale resolve from the prior connection. ---
{
  const server = new SyncServerPeer({ peerId: 92n })
  const [serverEnd1, clientEnd1] = makePair()
  server.connect(serverEnd1)
  const client = new SyncClientPeer({ peerId: 921n, transport: clientEnd1 })
  await client.ready() // initial handshake resolves (synchronous memory transport)

  // Reconnect onto a GATED transport so the new backfill is held.
  const [serverEnd2, clientEnd2Raw] = makePair()
  server.connect(serverEnd2)
  const gate = gatedClientTransport(clientEnd2Raw)
  client.reconnect(gate.transport)

  let reReady = false
  client.ready().then(() => { reReady = true })
  await Promise.resolve()
  assert.equal(reReady, false, 'ready() re-arms on reconnect: not resolved until the NEW backfill (SyncDone) arrives')
  gate.release()
  await Promise.resolve()
  assert.equal(reReady, true, 'ready() resolves once the reconnect handshake completes')
}
```

Run:

```
bun canvas-sync/src/client-peer.test.ts
```

**EXPECT FAIL** — `reconnect()` does not re-arm, so `ready()` returns the
already-resolved promise from the first handshake and resolves immediately:

```
AssertionError [ERR_ASSERTION]: ready() re-arms on reconnect: not resolved until the NEW backfill (SyncDone) arrives
  true !== false
```

### 4b — GREEN: re-arm inside `reconnect()`

Edit `canvas-sync/src/client-peer.ts` `reconnect()` — insert `this.armReady()`
after `this.wireTransport(this.transport)` and before `this.requestSync()`:

```ts
  reconnect(transport: Transport): void {
    this.transport.close() // idempotent if already dead; evicts a zombie from the server's client set
    this.transport = transport
    this.wireTransport(this.transport)
    this.armReady() // fresh SyncRequest ⇒ a fresh SyncDone to await; ready() must not lie about the new handshake
    this.requestSync()
    const backfill = this.doc.exportUpdate()
    this.lastBackfillBytesValue = backfill.byteLength
    this.transport.send(encode(Frame.Update, backfill))
  }
```

Run `bun canvas-sync/src/client-peer.test.ts` → **EXPECT PASS**
(`ok: client-peer`).

### 4c — Commit

```
git add canvas-sync/src/client-peer.ts canvas-sync/src/client-peer.test.ts
git commit -m "fix(canvas-sync): reconnect() re-arms ready() for the new handshake"
```

---

## Task 5 — Deploy-safety guard: an old peer ignores `SyncDone`

This is a **green guard** (not a RED→GREEN flip): the unknown-tag tolerance
already exists by design in both peers. We pin it so a future change can't
silently break the additive-frame deploy-safety property (guardrail c).

### 5a — Write the guard test

Add this case to `canvas-sync/src/server-peer.test.ts` just before the final
`console.log('ok: server-peer')`:

```ts
// --- (new) deploy-safety: a SyncDone frame delivered to a peer that does not
// handle it (an OLD build — here stood in by the server, which never treats
// SyncDone as inbound) is ignored: not counted malformed, no state change.
// This is what makes adding Frame.SyncDone safe to roll out (old client + new
// server, and vice versa, both degrade gracefully). ---
{
  const server = new SyncServerPeer({ peerId: 78n })
  server.doc.putPage({ id: 'page:p', name: 'P' })
  server.doc.commit()
  const pagesBefore = server.doc.listPages().length
  const [serverEnd, clientEnd] = makePair()
  server.connect(serverEnd)
  clientEnd.send(encode(Frame.SyncDone, new Uint8Array(0)))
  assert.equal(server.malformedFrames, 0, 'an unrecognized SyncDone frame is ignored, not counted malformed')
  assert.equal(server.doc.listPages().length, pagesBefore, 'an unrecognized SyncDone frame changes no state')
}
```

Run:

```
bun canvas-sync/src/server-peer.test.ts
```

**EXPECT PASS** immediately (`ok: server-peer`) — the server's `handleFrame`
`if/else-if` chain has no `SyncDone` branch, so the frame falls through to the
deliberate "unknown tags ignored" no-op. Confirm the pass; if it somehow
fails, STOP (it would mean the tolerance regressed).

### 5b — Commit

```
git add canvas-sync/src/server-peer.test.ts
git commit -m "test(canvas-sync): pin unknown-tag tolerance for Frame.SyncDone (deploy-safety)"
```

---

## Task 6 — Client-layer confirmation with the REAL `resolvePageId`

The mechanism is unit-proven in `canvas-sync` (Task 3). This adds a
client-layer test that exercises the ACTUAL `resolvePageId`
(`client/src/canvas-v2/bootstrap-page.ts`) consuming `ready()`, so the exact
sequence `boot()` will run is pinned. `ready()` already exists, so this is a
green confirmation (its sequencing RED counterpart is Task 3(b)).

### 6a — Write the confirmation test

Create `client/src/canvas-v2/boot-sync-ready.test.ts`:

```ts
// Run: bun src/canvas-v2/boot-sync-ready.test.ts
//
// Pins the boot sequencing fix at the client layer with the REAL resolvePageId
// (bootstrap-page.ts): once SyncClientPeer.ready() has resolved, the server's
// existing page is visible and adopted — no redundant 'page:p'. The underlying
// mechanism (Frame.SyncDone + ready()) is unit-proven in canvas-sync
// (client-peer.test.ts); this proves the client-side page-resolution consumes
// it correctly, the sequence CanvasV2App.boot() runs.
import assert from 'node:assert/strict'
import { SyncServerPeer, SyncClientPeer, makePair, type Transport } from '@ensembleworks/canvas-sync'
import { resolvePageId } from './bootstrap-page.js'

/** Holds every server→client frame until release() — see the same helper in
 * canvas-sync/src/client-peer.test.ts. */
function gatedClientTransport(raw: Transport): { transport: Transport; release: () => void } {
  let deliver: ((b: Uint8Array) => void) | null = null
  const held: Uint8Array[] = []
  let released = false
  raw.onMessage((b) => { if (released) deliver?.(b); else held.push(b) })
  return {
    transport: {
      send: (b) => raw.send(b),
      onMessage: (cb) => { deliver = cb },
      onClose: (cb) => raw.onClose(cb),
      close: () => raw.close(),
    },
    release: () => { released = true; for (const b of held.splice(0)) deliver?.(b) },
  }
}

const server = new SyncServerPeer({ peerId: 1n })
server.doc.putPage({ id: 'page:xyz', name: 'Real' })
server.doc.commit()

const [serverEnd, clientEndRaw] = makePair()
server.connect(serverEnd)
const gate = gatedClientTransport(clientEndRaw)
const peer = new SyncClientPeer({ peerId: 2n, transport: gate.transport })

const ready = peer.ready()
gate.release() // deliver the held backfill Update + SyncDone
await ready

const pageId = resolvePageId(peer.doc)
assert.equal(pageId, 'page:xyz', 'resolvePageId adopts the server page once ready() has resolved')
assert.deepEqual(
  peer.doc.listPages().map((p) => p.id),
  ['page:xyz'],
  'no redundant page:p bootstrapped when page-resolution is gated on ready()',
)
console.log('ok: boot-sync-ready — resolvePageId adopts the server page after ready(), no redundant page')
```

Run:

```
bun client/src/canvas-v2/boot-sync-ready.test.ts
```

**EXPECT PASS** — output ending `ok: boot-sync-ready — ...`. (This file has no
React/happy-dom and no timers, so it exits cleanly on its own; no
`process.exit` needed.)

### 6b — Commit

```
git add client/src/canvas-v2/boot-sync-ready.test.ts
git commit -m "test(client): pin resolvePageId adopting the server page after ready()"
```

---

## Task 7 — Wire `CanvasV2App.boot()` to the readiness signal

Replace the fixed sleep with a race against the readiness signal, and update
the doc comments so the settle timer's new meaning (a safety CAP) is honest.

### 7a — The boot change

Edit `client/src/canvas-v2/CanvasV2App.tsx`. Replace the settle line (currently
line 344):

```ts
			const peer = new SyncClientPeer({ peerId: randomPeerId(), transport, presence: presenceStore })
			await delay(props.settleMs ?? SETTLE_MS_DEFAULT)
			if (cancelled) {
```

with:

```ts
			const peer = new SyncClientPeer({ peerId: randomPeerId(), transport, presence: presenceStore })
			// Proceed the instant the server signals sync-complete: peer.ready()
			// resolves on Frame.SyncDone (sent right after the backfill Update), so
			// existing shapes are already imported by the time we resolve the page
			// id and build the Editor. The settle timer is now only a SAFETY CAP for
			// a pathological transport that never signals readiness — not a fixed
			// tax on every boot. Over a synchronous memory transport (tests) ready()
			// is already resolved here and delay(0) is an immediate Promise.resolve,
			// so both settle instantly; settleMs:0 semantics are unchanged.
			await Promise.race([peer.ready(), delay(props.settleMs ?? SETTLE_MS_DEFAULT)])
			if (cancelled) {
```

**Do not touch** the surrounding `if (cancelled) { presenceStore.destroy();
peer.close(); return }` guard (guardrail a — the StrictMode cancel path stays
identical), nor the ordering that publishes `window.__ew`/`setSession(s)` at the
END of `boot()` (guardrail b — unchanged; verify by reading, no edit).

### 7b — Update the doc comments to match reality

In the same file, replace the `SETTLE_MS_DEFAULT` declaration + comment
(currently lines 149-150):

```ts
/** See CONSTRUCTION SEQUENCE step 3 / bootstrap-page.ts's KNOWN RACE note. */
const SETTLE_MS_DEFAULT = 400
```

with:

```ts
/** SAFETY CAP for the boot handshake: boot() races SyncClientPeer.ready()
 * (resolves the instant the server sends Frame.SyncDone after its backfill)
 * against this timer, so a healthy room proceeds as soon as sync completes and
 * only a transport that never signals readiness waits the full cap. See
 * CONSTRUCTION SEQUENCE step 3 / bootstrap-page.ts's note. */
const SETTLE_MS_DEFAULT = 400
```

Replace CONSTRUCTION SEQUENCE step 3 in the module header (currently lines
23-27):

```
 *   3. A bounded SETTLE window (`settleMs`, prop-injectable, default
 *      `SETTLE_MS_DEFAULT`) before deciding the room's page id — see
 *      bootstrap-page.ts's KNOWN RACE note for exactly what this trades off
 *      and why. Tests pass `settleMs: 0` since an injected memory-transport
 *      handshake is already synchronous by the time `connect()` resolves.
```

with:

```
 *   3. Wait for sync readiness: race `peer.ready()` (resolves on the server's
 *      Frame.SyncDone, sent right after the backfill Update) against a bounded
 *      safety cap (`settleMs`, prop-injectable, default `SETTLE_MS_DEFAULT`),
 *      so boot proceeds the instant the room is caught up and the cap only
 *      bites if readiness never arrives. Tests pass `settleMs: 0`; over a
 *      synchronous memory transport ready() is already resolved by the time
 *      `connect()` resolves, so both settle instantly.
```

Replace the `settleMs` prop doc (currently lines 272-274):

```ts
	/** Test seam — see step 3 / bootstrap-page.ts's KNOWN RACE note.
	 * Production omits it (defaults to `SETTLE_MS_DEFAULT`); tests pass 0. */
	readonly settleMs?: number
```

with:

```ts
	/** Test seam — the boot readiness safety cap (see step 3 / SETTLE_MS_DEFAULT).
	 * Production omits it (defaults to `SETTLE_MS_DEFAULT`); tests pass 0. */
	readonly settleMs?: number
```

Finally, update the KNOWN RACE note in
`client/src/canvas-v2/bootstrap-page.ts` (lines 24-38) so it reflects that the
race is now gated. Replace that paragraph's opening — change the sentence that
begins "KNOWN RACE (documented, not hidden — v1 tradeoff): CanvasV2App calls
this ONCE, after a bounded "settle" window post-handshake ... not after a
protocol-guaranteed "you are now fully caught up" signal — canvas-sync's
SyncRequest/Update handshake has no such ack." to:

```
 * SYNC-READINESS (was a KNOWN RACE): CanvasV2App calls this ONCE, after
 * awaiting sync readiness — it races `SyncClientPeer.ready()` (which resolves
 * on the server's Frame.SyncDone, sent right after the backfill Update) against
 * a bounded safety cap. In the common case the backfill has already been
 * imported, so an existing room's real page is visible here and adopted. The
 * redundant-`page:p` bootstrap described below is now only reachable in the
 * pathological tail where readiness never arrives within the cap; it remains
```

Keep the rest of that paragraph (from "This is CORRECTNESS-NEUTRAL for
rendering ..." onward) as-is — it still accurately describes the fallback
behavior. Adjust wording only as needed to read cleanly after the new opening.

### 7c — Verify the existing suites are unaffected

Run the load-bearing integration suite and typecheck:

```
bun client/src/canvas-v2/CanvasV2App.test.ts
```

**EXPECT PASS** — every case still green (`ok: CanvasV2App.test.ts — all cases
passed`). This is the guardrail proof: StrictMode double-mount + cancelled
teardown (guardrail a), server-existing-shapes render, presence, delete/undo,
the dead-dogfood banner, and all three `settleMs: 0` call sites keep working
(guardrail: settleMs zeroable). If any case regresses, STOP and debug —
do not proceed.

Then:

```
bun run typecheck
```

**EXPECT PASS** (all workspaces typecheck).

Guardrail (e) — e2e `waitForBoot` (`e2e/lib/canvas-v2.ts:32-34`, keys off the
`select` toolbar button becoming visible, which only happens after
`setSession`): unaffected by this change (boot only gets faster, and the
toolbar still mounts at the same point in `boot()`). No e2e run is required in
this plan (e2e needs a live stack); record this as a reasoned no-op.

### 7d — Commit

```
git add client/src/canvas-v2/CanvasV2App.tsx client/src/canvas-v2/bootstrap-page.ts
git commit -m "perf(canvas-v2): replace fixed boot settle sleep with a sync-ready race"
```

---

## Task 8 — Full verification + PR

### 8a — Full typecheck and test suite

```
bun run typecheck
```

**EXPECT PASS.**

```
UX_CONTRACT_PR_BODY='ux-contract: none — v2 boot sequencing (remove fixed settle sleep, add Frame.SyncDone sync-ready signal); no gesture/observable interaction surface changed; pinned by the deterministic sync-ready tests in canvas-sync/src/client-peer.test.ts and client/src/canvas-v2/boot-sync-ready.test.ts' bun run test
```

**EXPECT PASS** — `all N suites passed`. The `UX_CONTRACT_PR_BODY` env is
required so the presence gate (`scripts/ux-contract-presence.test.ts`) sees the
opt-out marker for this diff (which touches `client/src/canvas-v2/`); without
it, that one suite correctly reports a violation reminding you to add the PR-body
line. (If you prefer, run the gate alone with the env to confirm:
`UX_CONTRACT_PR_BODY='ux-contract: none — ...' bun scripts/ux-contract-presence.test.ts`.)

### 8b — Push and open the PR

```
git push -u origin fix/v2-boot-sync-ready
gh pr create --fill
```

**The PR body MUST contain:**

1. A summary: "Removes the unconditional 400ms boot sleep in the v2 canvas
   engine and replaces it with a real sync-readiness signal (`Frame.SyncDone` +
   `SyncClientPeer.ready()`). The 400ms `settleMs` becomes a safety cap only.
   First step of the v2 performance-parity push."
2. Notes: additive protocol frame (deploy-safe — both peers ignore unknown
   tags; client + server co-deployed from this repo); no `server`-workspace
   code change (the room host wraps `SyncServerPeer` as a black box); the
   redundant-`page:p` race is now closed in the common case (gated on
   `ready()`), cap-bounded in the pathological tail.
3. The **required ux-contract opt-out line**, verbatim:

   ```
   ux-contract: none — v2 boot sequencing (remove fixed settle sleep, add Frame.SyncDone sync-ready signal); no gesture/observable interaction surface changed; pinned by the deterministic sync-ready tests in canvas-sync/src/client-peer.test.ts and client/src/canvas-v2/boot-sync-ready.test.ts
   ```

4. The recorded verbatim RED outputs from Tasks 1–4 (evidence of RED-first).
5. The standard footer:

   ```
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   ```

No commit for this task beyond what Tasks 1–7 already produced.

---

## Summary of files touched

- `canvas-sync/src/protocol.ts` — `Frame.SyncDone = 4` (+ `protocol.test.ts`).
- `canvas-sync/src/server-peer.ts` — emit `SyncDone` after the backfill reply
  (+ `server-peer.test.ts`: reply-sequence + deploy-safety guard).
- `canvas-sync/src/client-peer.ts` — `ready()` + `armReady()` + `SyncDone`
  handling + reconnect re-arm (+ `client-peer.test.ts`: ready/race/reconnect).
- `client/src/canvas-v2/CanvasV2App.tsx` — `Promise.race([peer.ready(),
  delay(cap)])` + doc comments.
- `client/src/canvas-v2/bootstrap-page.ts` — KNOWN RACE note updated.
- `client/src/canvas-v2/boot-sync-ready.test.ts` — new client-layer
  confirmation test.

No `server/`-workspace changes. No `e2e/` changes.
