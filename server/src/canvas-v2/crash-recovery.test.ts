// Run: bun src/canvas-v2/crash-recovery.test.ts
//
// E3/H5: the kill-9 crash-recovery rig. A real subprocess (crash-writer.ts)
// opens a DocumentActor + in-process client and writes/deletes/prop-updates
// shapes; this test SIGKILLs it (no graceful shutdown, no final compact — the
// exact opposite of every other actor.test.ts scenario) and proves the
// durable state left behind is invariant-clean and convergeable. Runs THREE
// rounds on the SAME directory — mid-`put`, mid-`delete`, mid-`updateProps`
// (the embed-write path) — proving recovery is re-entrant across repeated
// kill/recover cycles, not just a one-shot property.
//
// DETERMINISTIC CRASH POINT (H5 hardening — replaces a real, if narrow, race
// a prior version of this rig had — flagged as a carried finding after D4 saw
// this test flake once on a full `bun run test` pass, then pass twice
// standalone + on the next full run). The prior design: crash-writer wrote
// shapes in batches of 5, printing a cumulative `count=<n>` line only once
// per BATCH; this test waited for `count` to cross a threshold, then killed.
// That is NOT a fixed-sleep race, but it has the same *shape* of race: a real
// SIGKILL can land at ANY instruction boundary the kernel schedules, entirely
// independent of the app's own batching — so between "we observed count=N"
// and "the process is actually dead", up to 4 MORE puts could have already
// landed durably on disk without ever being reported, silently violating this
// test's own "recovered count never exceeds what the writer ever printed"
// bound. That is almost certainly the actual shape of the flake: a rare
// mid-batch kill, not a mid-write torn SQLite row (a single INSERT is atomic
// by construction — see store.ts's `appendUpdate` — so there is no such thing
// as a torn *row*; what can vary is how much of the batch had committed by
// the time death actually occurred).
//
// The fix (crash-writer.ts): report progress at 1-op granularity, not
// 5-op-batch granularity, AND make the crash point deterministic BY
// CONSTRUCTION rather than a threshold race at all: crash-writer halts
// itself (prints `HALT`, then awaits a promise that never resolves — no
// further doc mutation, ever) once enough ops of a requested TYPE have
// landed. This test only sends SIGKILL after it has itself read that `HALT`
// line off the pipe, so the last durable op this round is unambiguously of
// the requested type, and nothing can happen between the halt and the actual
// kill because the writer is provably idle from that point on. See
// crash-writer.ts's file header for the full account. `drainRemaining` after
// confirmed death is asserted to find NOTHING new — a direct, in-test proof
// that the halt contract holds, not just an assumption.
//
// Bounded waits only, everywhere: every wait below races against a deadline
// and fails loudly on timeout — never an unbounded sleep (see makeLineWaiter /
// withDeadline). Subprocess + SQLite teardown is bounded too (H4 finding):
// EXIT_DEADLINE_MS bounds waiting for the killed process to be reaped, and
// every DocumentActor/CanvasV2Store opened here is closed before the next one
// opens the same file.
//
// EXACT REPLAY, NOT JUST A BOUND (possible because of the HALT design above):
// this test builds a "mirror" of every `op=` line it observes for a round —
// each is durable by the time it's printed (commit() synchronously drives
// persist()), and the HALT design guarantees NO further op can occur after
// the last one recorded — so replaying the mirror over the round's starting
// state predicts the recovered doc's state EXACTLY (ids AND props), not just
// a shape-count bound. Cross-checked against the raw durable row count too
// (CanvasV2Store.load()): a genuinely corrupted middle-of-the-log gap would
// leave MORE rows on disk than the mirror accounts for (Loro's pending
// machinery stalls every op after a missing causal parent, so those rows
// exist but never materialize) — this is the same gap-vs-prefix insight the
// original rig relied on, now checked as an exact equality rather than a
// bound, because the op count this round is now known exactly.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkInvariants } from '@ensembleworks/canvas-model'
import { dumpModel } from '@ensembleworks/canvas-doc'
import { SyncClientPeer, makePair } from '@ensembleworks/canvas-sync'
import { DocumentActor } from './actor.ts'
import { CanvasV2Store } from './store.ts'

const CRASH_WRITER = path.join(import.meta.dirname, 'crash-writer.ts')
const READY_DEADLINE_MS = 10_000
const HALT_DEADLINE_MS = 10_000
const EXIT_DEADLINE_MS = 10_000
const DRAIN_DEADLINE_MS = 1_000

type OpType = 'put' | 'delete' | 'updateProps'
interface MirrorEntry {
	readonly type: OpType
	readonly id: string
	readonly value?: number
}

/**
 * Reads newline-delimited stdout from a spawned process. `waitFor` lets a
 * caller wait (bounded by a deadline) for the next line matching a predicate,
 * throwing loudly on timeout rather than hanging the suite. `drainRemaining`
 * keeps reading (also bounded) without requiring a match — used AFTER the
 * child is confirmed dead, to pick up any trailing lines it managed to print
 * before SIGKILL landed.
 */
function makeLineWaiter(stdout: ReadableStream<Uint8Array>) {
	const reader = stdout.getReader()
	const decoder = new TextDecoder()
	let buf = ''

	function takeBufferedLine(): string | undefined {
		const idx = buf.indexOf('\n')
		if (idx < 0) return undefined
		const line = buf.slice(0, idx)
		buf = buf.slice(idx + 1)
		return line
	}

	async function waitFor(predicate: (line: string) => boolean, deadlineMs: number): Promise<string> {
		const readLoop = (async (): Promise<string> => {
			for (;;) {
				let line = takeBufferedLine()
				while (line !== undefined) {
					if (predicate(line)) return line
					line = takeBufferedLine()
				}
				const { value, done } = await reader.read()
				if (done) {
					throw new Error(`crash-writer stdout ended before a matching line arrived (buffer: ${JSON.stringify(buf)})`)
				}
				buf += decoder.decode(value, { stream: true })
			}
		})()
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(`timed out after ${deadlineMs}ms waiting for a matching stdout line (buffer so far: ${JSON.stringify(buf)})`),
					),
				deadlineMs,
			)
		})
		try {
			return await Promise.race([readLoop, timeout])
		} finally {
			clearTimeout(timer)
		}
	}

	/** Best-effort drain, bounded by `deadlineMs`: collects every remaining
	 * line into `onLine`, stopping on stream end OR the deadline — whichever
	 * comes first. Never throws (both outcomes are expected, not failures):
	 * called only after the writer is confirmed dead, so "no more output"
	 * is the normal case, not a hang. */
	async function drainRemaining(onLine: (line: string) => void, deadlineMs: number): Promise<void> {
		const deadline = Date.now() + deadlineMs
		for (;;) {
			let line = takeBufferedLine()
			while (line !== undefined) {
				onLine(line)
				line = takeBufferedLine()
			}
			const remaining = deadline - Date.now()
			if (remaining <= 0) return
			let result: { value?: Uint8Array; done: boolean }
			try {
				result = await Promise.race([
					reader.read(),
					new Promise<{ value: undefined; done: true }>((resolve) =>
						setTimeout(() => resolve({ value: undefined, done: true }), remaining),
					),
				])
			} catch {
				return
			}
			if (result.done || !result.value) return
			buf += decoder.decode(result.value, { stream: true })
		}
	}

	return { waitFor, drainRemaining }
}

/** Race a promise against a bounded deadline; throws loudly (never hangs). */
function withDeadline<T>(p: Promise<T>, deadlineMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${deadlineMs}ms waiting for ${label}`)), deadlineMs)
	})
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

const OP_LINE_RE = /^op=(put|delete|updateProps) id=(\S+) n=(\d+)(?: value=(\d+))?$/

/**
 * Spawn crash-writer for exactly one round of `crashAfter`-typed ops, wait
 * for its deterministic HALT sentinel (see this file's header — NOT a
 * count/timing race), then SIGKILL it. Returns the exact mirror of every op
 * this round performed (see header's "EXACT REPLAY" note) — every entry here
 * is guaranteed durable, and the HALT contract guarantees nothing MORE
 * happened, so the mirror is the complete round, not an approximation.
 */
async function runRoundToHalt(
	dir: string,
	roomId: string,
	clientPeerId: bigint,
	startId: number,
	crashAfter: OpType,
): Promise<{ mirror: MirrorEntry[] }> {
	const proc = Bun.spawn(
		[process.execPath, CRASH_WRITER, dir, roomId, String(clientPeerId), String(startId), crashAfter],
		{ stdout: 'pipe', stderr: 'inherit' },
	)
	const waiter = makeLineWaiter(proc.stdout as ReadableStream<Uint8Array>)

	await waiter.waitFor((line) => line.trim() === 'READY', READY_DEADLINE_MS)

	// Accumulate every `op=` line into the mirror while watching for the bare
	// `HALT` sentinel — a non-matching (`op=`) line returns false so waitFor
	// keeps reading; HALT returns true and stops it.
	const mirror: MirrorEntry[] = []
	await waiter.waitFor((line) => {
		const trimmed = line.trim()
		const m = OP_LINE_RE.exec(trimmed)
		if (m) {
			mirror.push({ type: m[1] as OpType, id: m[2]!, value: m[4] !== undefined ? Number(m[4]) : undefined })
			return false
		}
		return trimmed === 'HALT'
	}, HALT_DEADLINE_MS)

	// The writer is now permanently idle (blocked on a promise that never
	// resolves — crash-writer.ts's haltForever contract). Kill it: no op can
	// have happened between the HALT line above and this signal, which is the
	// whole point of the HALT design — the crash point is pinned BY
	// CONSTRUCTION, not by a timing guess.
	proc.kill(9)
	await withDeadline(proc.exited, EXIT_DEADLINE_MS, 'crash-writer to exit after SIGKILL')
	assert.equal(proc.signalCode, 'SIGKILL', 'the writer was actually terminated by SIGKILL, not a graceful exit')

	// Best-effort, BOUNDED drain (never an unbounded wait — H4 teardown-hang
	// finding): expected to find NOTHING new, since the writer never emits
	// anything after HALT. Asserting that in-test is a direct proof the halt
	// contract actually held for this run, not just an assumption.
	const strayLines: string[] = []
	await waiter.drainRemaining((line) => strayLines.push(line), DRAIN_DEADLINE_MS)
	assert.deepEqual(
		strayLines,
		[],
		'the writer must not emit anything after HALT — a stray line here would mean the crash point was not actually pinned deterministically',
	)

	return { mirror }
}

/** Replays `mirror` (one round's exact op sequence — see header) on top of
 * `baseline` (the alive-shape-id -> props map going INTO this round) to
 * predict the round's exact outcome. */
function applyMirror(baseline: ReadonlyMap<string, Record<string, unknown>>, mirror: readonly MirrorEntry[]): Map<string, Record<string, unknown>> {
	const alive = new Map(baseline)
	for (const entry of mirror) {
		if (entry.type === 'put') alive.set(entry.id, {})
		else if (entry.type === 'delete') alive.delete(entry.id)
		else if (entry.type === 'updateProps') alive.set(entry.id, { ...(alive.get(entry.id) ?? {}), touched: entry.value })
	}
	return alive
}

/**
 * Opens a fresh DocumentActor on `dir`/`roomId` (the crash-recovery load
 * path) and asserts its state EXACTLY matches `expectedAlive` (ids AND
 * props), is invariant-clean, cross-checks the durable row count against
 * `opsThisRound` (the gap-vs-prefix detector — see file header), and
 * converges a fresh client to it (props included — a torn UpdateProps write
 * or a half-applied delete would show up here as a client whose converged
 * state doesn't match the invariant-clean server it just synced from).
 * `pageRowsThisRound` is 1 only for the very first round ever run against a
 * fresh directory (the one-time page-put row); `DocumentActor.close()`
 * always compacts once, so every later round's raw row count is
 * round-scoped, never cumulative (see actor.ts's close() doc comment).
 */
function assertRecovered(
	dir: string,
	roomId: string,
	expectedAlive: ReadonlyMap<string, Record<string, unknown>>,
	opsThisRound: number,
	pageRowsThisRound: number,
	roundLabel: string,
): void {
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const model = dumpModel(recovered.peer.doc)
	assert.deepEqual(checkInvariants(model), [], `${roundLabel}: recovered doc is invariant-clean`)

	const recoveredIds = model.shapes.map((s) => s.id).sort()
	const expectedIds = Array.from(expectedAlive.keys()).sort()
	assert.deepEqual(
		recoveredIds,
		expectedIds,
		`${roundLabel}: recovered shape ids must exactly match the mirrored op sequence replayed over the prior round's state`,
	)
	for (const s of model.shapes) {
		assert.deepEqual(s.props, expectedAlive.get(s.id), `${roundLabel}: recovered props for ${s.id} must match the mirrored op sequence exactly`)
	}

	// Gap-vs-prefix detector, now an EXACT equality (see file header): a
	// genuine crash truncation has durable-rows-this-round === ops the mirror
	// recorded, exactly (every row that exists got applied — nothing pending).
	// A corrupted middle gap would leave MORE rows than materialized (Loro's
	// pending machinery stalls everything causally after the hole).
	const store = new CanvasV2Store(dir, roomId)
	const { updates } = store.load()
	assert.equal(
		updates.length - pageRowsThisRound,
		opsThisRound,
		`${roundLabel}: durable row count this round (minus a one-time page-put row) must equal the mirrored op count exactly — a mismatch would mean a corrupted gap, not a clean crash truncation`,
	)
	store.close()

	// A fresh client requestSync()s and converges to the recovered state,
	// props included.
	const [serverTransport, clientTransport] = makePair()
	recovered.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 999n, transport: clientTransport })
	client.requestSync()
	const convergedIds = client.doc.listShapes().map((s) => s.id).sort()
	assert.deepEqual(convergedIds, recoveredIds, `${roundLabel}: a fresh client converges to the recovered server state`)
	for (const s of client.doc.listShapes()) {
		assert.deepEqual(s.props, expectedAlive.get(s.id), `${roundLabel}: fresh client's converged props for ${s.id} must match too — no torn text/prop container survives`)
	}

	recovered.close()
}

// ---------------------------------------------------------------------------
// Three kill-9 rounds on the SAME directory — mid-put, mid-delete, and
// mid-updateProps (the embed-write path) — proving recovery stays correct
// across repeated (re-entrant) kill/recover cycles, not just once.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-crash-'))
	const roomId = 'crash-room'

	// Round 1 — mid-put. Leaves a large-enough surviving pool (see
	// crash-writer.ts's MIN_OPS_BEFORE_HALT.put) for the delete/updateProps
	// rounds below to each have plenty of material of their own.
	const round1 = await runRoundToHalt(dir, roomId, 2n, 0, 'put')
	assert.ok(round1.mirror.length > 50, 'round 1 performed more than the N>50 appends floor')
	const round1Alive = applyMirror(new Map(), round1.mirror)
	assertRecovered(dir, roomId, round1Alive, round1.mirror.length, 1, 'round 1 (mid-put)')
	console.log(`crash-recovery: round 1 (mid-put) — recovered ${round1Alive.size} shape(s), invariant-clean + convergeable`)

	// Round 2 — mid-delete. Re-entrant: fresh writer process, fresh
	// DocumentActor, same directory. Operates on round 1's survivors.
	const nextFreshId = round1.mirror.length // unused by a delete round, passed for hygiene
	const round2 = await runRoundToHalt(dir, roomId, 3n, nextFreshId, 'delete')
	assert.ok(round2.mirror.length > 50, 'round 2 performed more than the N>50 appends floor')
	assert.ok(round2.mirror.every((e) => e.type === 'delete'), 'round 2 is a pure mid-delete crash')
	const round2Alive = applyMirror(round1Alive, round2.mirror)
	assert.ok(round2Alive.size < round1Alive.size, 'the delete round durably removed shapes from round 1\'s surviving set')
	assertRecovered(dir, roomId, round2Alive, round2.mirror.length, 0, 'round 2 (mid-delete)')
	console.log(
		`crash-recovery: round 2 (mid-delete) — recovered ${round2Alive.size} shape(s) (down from ${round1Alive.size}), invariant-clean + convergeable — recovery is re-entrant`,
	)

	// Round 3 — mid-updateProps (the embed-write path: D1's UpdateProps
	// intent is what a terminal/screenshare/file-viewer write becomes at the
	// doc layer). Second re-entrant cycle on the same directory.
	const round3 = await runRoundToHalt(dir, roomId, 4n, nextFreshId, 'updateProps')
	assert.ok(round3.mirror.length > 50, 'round 3 performed more than the N>50 appends floor')
	assert.ok(round3.mirror.every((e) => e.type === 'updateProps'), 'round 3 is a pure mid-embed-write (UpdateProps) crash')
	const round3Alive = applyMirror(round2Alive, round3.mirror)
	assert.equal(round3Alive.size, round2Alive.size, 'an updateProps-only round changes no shape\'s existence, only its props')
	assert.ok(
		[...round3Alive.values()].some((props) => 'touched' in props),
		'at least one shape carries a durably-recovered UpdateProps write',
	)
	assertRecovered(dir, roomId, round3Alive, round3.mirror.length, 0, 'round 3 (mid-updateProps / embed-write)')
	console.log(
		`crash-recovery: round 3 (mid-updateProps) — recovered ${round3Alive.size} shape(s) with durable prop writes, invariant-clean + convergeable — recovery is re-entrant again`,
	)

	rmSync(dir, { recursive: true, force: true })
}

console.log('ok: crash-recovery — kill -9 mid-put / mid-delete / mid-updateProps, deterministic crash point, replay append-log, converge (re-entrant x3)')
process.exit(0)
