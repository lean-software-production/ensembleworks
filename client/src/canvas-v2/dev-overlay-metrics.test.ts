// Run: bun src/canvas-v2/dev-overlay-metrics.test.ts
//
// useCanvasMetrics hook coverage (quality-review fix round) — the polling
// half of DevOverlay that DevOverlay.test.ts's renderToStaticMarkup cases
// CANNOT reach (static string rendering never runs effects; see
// CanvasV2App.test.ts's header for the same reasoning). Same rig as that
// file: happy-dom globals installed BEFORE any react-dom/client import
// (dynamic imports below), IS_REACT_ACT_ENVIRONMENT + act() for
// deterministic flushing, process.exit(0) at the end (happy-dom timers).
//
// NO <StrictMode> here, deliberately (a documented deviation from
// CanvasV2App.test.ts's own choice): StrictMode double-invokes every effect
// (mount -> simulated cleanup -> mount), which would double the initial
// fetch count and make every call-count assertion below off-by-N noise.
// This file asserts EXACT fetch/warn counts — the whole point of the
// dedupe/cleanup cases — so it uses a plain root. StrictMode-safety of the
// overall mount is CanvasV2App.test.ts's job, not this file's.
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).navigator = win.navigator
;(globalThis as any).location = win.location
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useCanvasMetrics } = await import('./DevOverlay.js')
type CanvasMetricsPayload = import('./DevOverlay.js').CanvasMetricsPayload

const PAYLOAD: CanvasMetricsPayload = { ok: true, sync: { r: { pendingImports: 1, malformedFrames: 0, tainted: null } }, evictions: {} }

/** A minimal Response stand-in — useCanvasMetrics only reads .ok/.status/.json(). */
function fakeResponse(ok: boolean, status: number, payload?: unknown): Response {
	return { ok, status, json: async () => payload } as unknown as Response
}

/** Probe component: runs the hook with injected seams and mirrors its result
 * into a data attribute the assertions can read. */
function Probe({ fetchImpl, intervalMs }: { fetchImpl: typeof fetch; intervalMs: number }) {
	const metrics = useCanvasMetrics(true, intervalMs, fetchImpl)
	return createElement('div', { 'data-metrics': metrics ? JSON.stringify(metrics) : 'null' })
}

const INTERVAL_MS = 20
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mount(fetchImpl: typeof fetch, intervalMs = INTERVAL_MS) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	return { container, root, render: () => act(async () => { root.render(createElement(Probe, { fetchImpl, intervalMs })) }) }
}

/** console.warn spy — counts calls, restores on dispose. */
function spyWarn() {
	const original = console.warn
	let count = 0
	console.warn = () => { count++ }
	return { count: () => count, restore: () => { console.warn = original } }
}

async function main() {
	// ==========================================================================
	// (a0) EXACTLY ONE IMMEDIATE SCRAPE ON MOUNT: asserted with an interval far
	// too long to ever fire during the test, so the exact count is
	// deterministic. (It used to be asserted on the 20ms-interval mount below,
	// which raced real mount/act wall-clock time against the first interval
	// tick and flaked ~30% on a loaded machine.)
	// ==========================================================================
	{
		let calls = 0
		const fetchImpl = (async () => { calls++; return fakeResponse(true, 200, PAYLOAD) }) as unknown as typeof fetch
		const { container, root, render } = mount(fetchImpl, 60_000)
		await render()
		await act(async () => { await wait(5) }) // flush the immediate first scrape's microtasks
		assert.equal(container.querySelector('div')!.getAttribute('data-metrics'), JSON.stringify(PAYLOAD), 'a successful scrape sets the payload')
		assert.equal(calls, 1, 'exactly one immediate scrape on mount (interval too long to have fired)')
		await act(async () => { root.unmount() })
		container.remove()
		console.log('ok: useCanvasMetrics — exactly one immediate scrape on mount')
	}

	// ==========================================================================
	// (a) HAPPY PATH + INTERVAL CLEANUP ON UNMOUNT: an ok response sets the
	// payload; polling continues on the interval; unmount clears the interval
	// (the fetch count STOPS growing).
	// ==========================================================================
	{
		let calls = 0
		const fetchImpl = (async () => { calls++; return fakeResponse(true, 200, PAYLOAD) }) as unknown as typeof fetch
		const { container, root, render } = mount(fetchImpl)
		await render()
		await act(async () => { await wait(5) }) // flush the immediate first scrape's microtasks
		assert.equal(container.querySelector('div')!.getAttribute('data-metrics'), JSON.stringify(PAYLOAD), 'a successful scrape sets the payload')
		assert.ok(calls >= 1, 'the immediate scrape ran (exact count is (a0)\'s job — a real 20ms interval may already have ticked here)')

		await act(async () => { await wait(INTERVAL_MS * 3) })
		const callsWhileMounted = calls
		assert.ok(callsWhileMounted >= 2, `the interval keeps polling while mounted (saw ${callsWhileMounted} calls)`)

		await act(async () => { root.unmount() })
		await wait(INTERVAL_MS * 3)
		assert.equal(calls, callsWhileMounted, 'unmount clears the interval — the fetch count stops growing')
		container.remove()
		console.log('ok: useCanvasMetrics — happy path + interval cleanup on unmount')
	}

	// ==========================================================================
	// (b) REJECTING FETCH: swallowed (never thrown into React), metrics stays
	// null, and the warn fires ONCE for the whole streak (dedupe per
	// failure-state change, not per poll).
	// ==========================================================================
	{
		let calls = 0
		const fetchImpl = (async () => { calls++; throw new Error('network down') }) as unknown as typeof fetch
		const warn = spyWarn()
		const { container, root, render } = mount(fetchImpl)
		await render()
		await act(async () => { await wait(INTERVAL_MS * 4) }) // several failing polls
		assert.ok(calls >= 3, `precondition: several polls happened (saw ${calls})`)
		assert.equal(container.querySelector('div')!.getAttribute('data-metrics'), 'null', 'a rejecting fetch never sets metrics')
		assert.equal(warn.count(), 1, `an unchanged failure streak warns exactly ONCE, not once per poll (saw ${warn.count()})`)
		await act(async () => { root.unmount() })
		warn.restore()
		container.remove()
		console.log('ok: useCanvasMetrics — rejecting fetch swallowed, warned once per streak')
	}

	// ==========================================================================
	// (c) NON-OK RESPONSE: warned (the quality-review nit — it used to return
	// silently), deduped the same way; a SUCCESS resets the dedupe so a
	// RELAPSE warns again; a DIFFERENT failure (500 -> 404) also warns.
	// ==========================================================================
	{
		// Scripted outcomes, one per poll, holding the last one forever.
		const script: Array<() => Response> = [
			() => fakeResponse(false, 500), // warn #1 (http 500)
			() => fakeResponse(false, 500), // deduped
			() => fakeResponse(false, 404), // warn #2 (different failure)
			() => fakeResponse(true, 200),  // success — sets payload, resets dedupe
			() => fakeResponse(false, 500), // warn #3 (relapse after success)
			() => fakeResponse(false, 500), // deduped
		]
		let call = 0
		const fetchImpl = (async () => {
			const step = script[Math.min(call, script.length - 1)]!
			call++
			const r = step()
			return r.ok ? fakeResponse(true, 200, PAYLOAD) : r
		}) as unknown as typeof fetch
		const warn = spyWarn()
		const { container, root, render } = mount(fetchImpl)
		await render()
		await act(async () => { await wait(INTERVAL_MS * 8) }) // enough polls to run the whole script
		assert.ok(call >= script.length, `precondition: the whole outcome script ran (saw ${call} polls)`)
		assert.equal(container.querySelector('div')!.getAttribute('data-metrics'), JSON.stringify(PAYLOAD), 'the mid-script success set the payload (and a later failure keeps the LAST GOOD payload, never clears it)')
		assert.equal(warn.count(), 3, `non-ok warns, deduped per failure-state change: 500 (warn), 500 (deduped), 404 (warn — different), ok (reset), 500 (warn — relapse), 500 (deduped) => 3 warns, saw ${warn.count()}`)
		await act(async () => { root.unmount() })
		warn.restore()
		container.remove()
		console.log('ok: useCanvasMetrics — non-ok warns, deduped per failure-state change, reset on success')
	}

	console.log('ok: dev-overlay-metrics.test.ts — all cases passed')
}

main()
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
	.finally(() => {
		process.exit(0)
	})
