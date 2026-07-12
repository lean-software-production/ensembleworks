// Run: bun src/canvas-v2/crash-recovery.test.ts
//
// E3: the kill-9 crash-recovery rig. A real subprocess (crash-writer.ts) opens
// a DocumentActor + in-process client and writes numbered shapes in a tight
// loop; this test SIGKILLs it mid-write (no graceful shutdown, no final
// compact — the exact opposite of every other actor.test.ts scenario) and
// proves the durable state left behind is a genuine crash-consistent PREFIX:
// exactly ids 0..K contiguous, invariant-clean, and convergeable by a fresh
// client. Runs the whole cycle TWICE on the SAME directory to prove recovery
// is re-entrant (reopen → write more → kill again → recover again).
//
// Bounded waits only, everywhere: every wait below races against a deadline
// and fails loudly on timeout — never an unbounded sleep (see makeLineWaiter /
// withDeadline).
//
// GAP-VS-PREFIX DETECTABILITY (self-check finding, not itself committed —
// see the execution report for the full experiment): shape-id contiguity
// alone ("ids are exactly 0..K, no gaps") does NOT distinguish a legitimate
// crash truncation from a CORRUPTED middle-of-the-log gap. Every append here
// is one peer's (the in-process client's) own linear causal oplog history —
// deleting a MIDDLE row synthetically does not "skip" just that one op: Loro
// requires ops from a given peer to apply in causal order, so every row
// AFTER the deleted one reports `pending` on import and is never materialized
// at all. The visible result is ids 0..(gap position), which is EXACTLY what
// a genuine kill-9 at that same position would also look like — contiguity
// passes in both cases. The assertion that actually tells them apart is the
// row-count/shape-count cross-check below: for a given round, a genuine
// truncation always has (surviving rows this round − a one-time page row) ===
// (new materialized shapes this round), because every row that exists got
// applied; a corrupted gap leaves MORE rows on disk than ever got
// materialized (the pending ones are stuck, uncounted). "This round" matters
// because DocumentActor.close() ALWAYS compacts (regardless of the
// compactEvery threshold), so round 2's raw update rows are round-2-scoped,
// not cumulative — see assertValidPrefix's doc comment.
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
const MIN_APPENDS = 51 // "after N>50 appends observed" (the task's floor)
const READY_DEADLINE_MS = 10_000
const PROGRESS_DEADLINE_MS = 10_000
const EXIT_DEADLINE_MS = 10_000
const DRAIN_DEADLINE_MS = 1_000

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

/**
 * Spawn crash-writer, wait for READY + at least MIN_APPENDS durable appends
 * observed via its progress lines, then SIGKILL it mid-write. `startId`
 * continues a contiguous id range across rounds; `clientPeerId` MUST differ
 * per round on the same dir (see crash-writer.ts's usage doc — a restarted
 * counter under a REUSED client peerId would collide with a prior round's
 * oplog range, a rig bug rather than a recovery property).
 *
 * Returns the LAST count the writer ever printed (drained after confirming
 * the process is dead) — not just the first one that crossed MIN_APPENDS —
 * because this coroutine and the writer's own loop race independently: more
 * batches can complete between "we saw count=N cross the threshold" and
 * "SIGKILL actually lands". Using the true last-printed count is what makes
 * "recovered shapeCount ≤ lastObservedCount" a sound bound rather than a
 * lucky race.
 */
async function killMidWrite(
	dir: string,
	roomId: string,
	clientPeerId: bigint,
	startId: number,
): Promise<{ lastObservedCount: number }> {
	const proc = Bun.spawn([process.execPath, CRASH_WRITER, dir, roomId, String(clientPeerId), String(startId)], {
		stdout: 'pipe',
		stderr: 'inherit',
	})
	const waiter = makeLineWaiter(proc.stdout as ReadableStream<Uint8Array>)

	await waiter.waitFor((line) => line.trim() === 'READY', READY_DEADLINE_MS)

	let lastObservedCount = startId
	await waiter.waitFor((line) => {
		const m = /^count=(\d+)$/.exec(line.trim())
		if (!m) return false
		lastObservedCount = Number(m[1])
		return lastObservedCount - startId > MIN_APPENDS
	}, PROGRESS_DEADLINE_MS)

	proc.kill(9)
	await withDeadline(proc.exited, EXIT_DEADLINE_MS, 'crash-writer to exit after SIGKILL')
	assert.equal(proc.signalCode, 'SIGKILL', 'the writer was actually terminated by SIGKILL, not a graceful exit')

	// The process is confirmed dead — drain whatever it managed to flush to
	// the pipe before dying (see this function's doc comment for why this
	// matters for the ≤ bound).
	await waiter.drainRemaining((line) => {
		const m = /^count=(\d+)$/.exec(line.trim())
		if (m) lastObservedCount = Math.max(lastObservedCount, Number(m[1]))
	}, DRAIN_DEADLINE_MS)

	return { lastObservedCount }
}

/**
 * Opens a fresh DocumentActor on `dir`/`roomId` (the crash-recovery load path)
 * and asserts its state is a valid PREFIX: invariant-clean, shape ids exactly
 * 0..K contiguous, the row-count/shape-count cross-check holds (see the
 * file-level doc comment on gap-vs-prefix detectability), and a fresh client
 * converges to it. `baselineShapeCount` is the shape count BEFORE this
 * round's writer started (0 for round 1) — needed because THIS function
 * closes its own `recovered` actor at the end, and `DocumentActor.close()`
 * ALWAYS compacts once (regardless of the compactEvery threshold — see
 * actor.ts's close() doc comment and actor.test.ts's Test 6), folding that
 * round's rows into a snapshot before the next round's writer ever opens the
 * file. So the raw `updates` rows visible here are always round-scoped, not
 * cumulative — the cross-check below is written against that fact. Returns
 * the recovered (cumulative) shape count.
 */
function assertValidPrefix(
	dir: string,
	roomId: string,
	baselineShapeCount: number,
	lastObservedCount: number,
): { shapeCount: number } {
	const recovered = new DocumentActor({ dir, roomId, peerId: 1n })
	const model = dumpModel(recovered.peer.doc)
	assert.deepEqual(checkInvariants(model), [], 'recovered doc is invariant-clean')

	const numericIds = model.shapes.map((s) => Number(s.id.replace('shape:', ''))).sort((a, b) => a - b)
	const shapeCount = numericIds.length
	assert.ok(shapeCount > 0, 'the crash left SOME durable shapes behind')
	assert.ok(shapeCount <= lastObservedCount, 'recovered count never exceeds what the writer ever printed')
	assert.deepEqual(
		numericIds,
		Array.from({ length: shapeCount }, (_, i) => i),
		`recovered shape ids must be exactly 0..${shapeCount - 1}, contiguous (a valid PREFIX) — got ${JSON.stringify(numericIds)}`,
	)

	// The gap-detecting cross-check: crash-writer disables autonomous
	// compaction (COMPACT_EVERY is far above this rig's op volume), so every
	// successful op this round is exactly one durable SQLite row, and there
	// is exactly one page-put row EVER, on round 1 only (crash-writer's
	// listPages() guard skips it once the page already exists from a prior
	// round's snapshot). A genuine truncation therefore has, for THIS round,
	// (surviving rows − a one-time page row) === (new materialized shapes
	// this round), exactly. A corrupted gap does not (see this file's header
	// comment): Loro's pending machinery would leave MORE rows on disk than
	// ever got applied.
	const store = new CanvasV2Store(dir, roomId)
	const { updates } = store.load()
	const pageRowsThisRound = baselineShapeCount === 0 ? 1 : 0
	assert.equal(
		updates.length - pageRowsThisRound,
		shapeCount - baselineShapeCount,
		'durable row count this round (minus a one-time page-put row) must equal NEW materialized shapes this round, exactly — a mismatch would mean a gap',
	)
	store.close()

	// A fresh client requestSync()s and converges to the recovered state.
	const [serverTransport, clientTransport] = makePair()
	recovered.connect(serverTransport)
	const client = new SyncClientPeer({ peerId: 999n, transport: clientTransport })
	client.requestSync()
	assert.deepEqual(
		client.doc.listShapes().map((s) => s.id).sort(),
		recovered.peer.doc.listShapes().map((s) => s.id).sort(),
		'a fresh client converges to the recovered server state',
	)

	recovered.close()
	return { shapeCount }
}

// ---------------------------------------------------------------------------
// Two full kill-9 cycles on the same directory: proves recovery is re-entrant.
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-crash-'))
	const roomId = 'crash-room'

	const round1 = await killMidWrite(dir, roomId, 2n, 0)
	const { shapeCount: k1 } = assertValidPrefix(dir, roomId, 0, round1.lastObservedCount)
	console.log(`crash-recovery: round 1 — recovered a valid prefix of ${k1} shape(s) (writer last printed ${round1.lastObservedCount})`)

	const round2 = await killMidWrite(dir, roomId, 3n, k1)
	const { shapeCount: k2 } = assertValidPrefix(dir, roomId, k1, round2.lastObservedCount)
	assert.ok(k2 > k1, 'the second round durably added more shapes on top of the first')
	console.log(
		`crash-recovery: round 2 — recovered a valid prefix of ${k2} shape(s) (writer last printed ${round2.lastObservedCount}) — recovery is re-entrant`,
	)

	rmSync(dir, { recursive: true, force: true })
}

console.log('ok: crash-recovery — kill -9 mid-write, replay append-log, converge (x2, re-entrant)')
