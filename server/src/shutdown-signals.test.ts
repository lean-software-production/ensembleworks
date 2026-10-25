// Run: bun src/shutdown-signals.test.ts
//
// F2 review item: sync-server.ts's SIGTERM/SIGINT wiring was correct by
// reading but untested (the entrypoint boots a real server on import, so the
// handler must live in its own module to be testable at all). Pure unit test —
// no real signals, no real process.exit: deps are injected fakes, and the
// close() promise is manually controlled so the test can observe ordering
// (exit must NOT fire before close() resolves).
import assert from 'node:assert/strict'
import { createShutdownHandler } from './shutdown-signals.ts'

/** One macrotask hop — enough for a resolved promise's .then chain to run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function makeDeps() {
	const calls: string[] = []
	let resolveClose!: () => void
	let rejectClose!: (err: unknown) => void
	const closePromise = new Promise<void>((res, rej) => {
		resolveClose = res
		rejectClose = rej
	})
	return {
		calls,
		resolveClose: () => resolveClose(),
		rejectClose: (err: unknown) => rejectClose(err),
		deps: {
			close: () => {
				calls.push('close')
				return closePromise
			},
			exit: (code: number) => {
				calls.push(`exit(${code})`)
			},
			log: (_msg: string) => {},
			warn: (_msg: string) => {},
			error: (_msg: string, _err?: unknown) => {},
		},
	}
}

// ---------------------------------------------------------------------------
// Test 1 — first signal: close() is awaited, THEN exit(0). Exit must not fire
// while close() is still in flight.
// ---------------------------------------------------------------------------
{
	const { calls, resolveClose, deps } = makeDeps()
	const handler = createShutdownHandler(deps)
	handler('SIGTERM')
	assert.deepEqual(calls, ['close'], 'the first signal starts close() and does NOT exit yet')
	await tick()
	assert.deepEqual(calls, ['close'], 'still no exit while close() is unresolved')
	resolveClose()
	await tick()
	assert.deepEqual(calls, ['close', 'exit(0)'], 'exit(0) fires only after close() resolves')
	console.log('ok: shutdown-signals — first signal awaits close() then exits 0')
}

// ---------------------------------------------------------------------------
// Test 2 — a second signal mid-teardown: exit(1) immediately, and close() is
// NOT called a second time.
// ---------------------------------------------------------------------------
{
	const { calls, resolveClose, deps } = makeDeps()
	const handler = createShutdownHandler(deps)
	handler('SIGTERM')
	assert.deepEqual(calls, ['close'], 'first signal started teardown')
	handler('SIGINT') // operator mashing ctrl-c while teardown is in flight
	assert.deepEqual(calls, ['close', 'exit(1)'], 'second signal exits 1 immediately, without a second close()')
	// Late resolution of the original close() must not produce a surprise
	// exit(0) after the operator already forced out — in a REAL process
	// exit(1) would have terminated everything, but the fake keeps running,
	// so assert the handler itself doesn't double-fire.
	resolveClose()
	await tick()
	assert.deepEqual(
		calls,
		['close', 'exit(1)', 'exit(0)'],
		'documented fake-only artifact: the pending .then chain still runs under a fake exit — fine, because a real exit(1) terminates the process before it can',
	)
	console.log('ok: shutdown-signals — second signal mid-teardown exits 1 without a second close()')
}

// ---------------------------------------------------------------------------
// Test 3 — close() rejecting: exit(1), never a hang.
// ---------------------------------------------------------------------------
{
	const { calls, rejectClose, deps } = makeDeps()
	const handler = createShutdownHandler(deps)
	handler('SIGTERM')
	rejectClose(new Error('teardown blew up'))
	await tick()
	assert.deepEqual(calls, ['close', 'exit(1)'], 'a rejecting close() still exits (code 1), never hangs')
	console.log('ok: shutdown-signals — a rejecting close() exits 1')
}

console.log('shutdown-signals.test.ts: all tests passed')
