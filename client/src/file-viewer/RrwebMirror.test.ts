// Run: bun src/file-viewer/RrwebMirror.test.ts
//
// Regression coverage for the "frozen mirror falls back instantly on an
// empty backlog" fix: a frozen (no live controller) mirror has no live
// stream to ever wait for, so an empty/missing backlog must call
// onFallback() immediately rather than sit through the FALLBACK_MS (2s)
// window that exists to give a genuinely live presenter's socket data time
// to arrive. Live mode must keep the timer.
//
// happy-dom + a REAL react-dom/client reconciler (same technique as
// canvas-v2's CanvasV2App.test.ts / IframeShape.test.ts's "THE REAL THING"
// layer) because RrwebMirror's fallback logic lives entirely inside a
// mount-time effect — renderToStaticMarkup never runs effects at all.
//
// DOM GLOBALS BEFORE REACT-DOM: happy-dom's window/document must be on
// globalThis before react-dom/client (which binds to `document` at
// createRoot time) or the RrwebMirror import runs — static `import`
// declarations hoist above any statement, so every import below is dynamic,
// after the globals are set.
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
const { RrwebMirror } = await import('./RrwebMirror.js')

type Backlog = { presentId: string | null; truncated: boolean; entries: unknown[] }

// Installs a fetch stub for one mount, returning a controllable backlog (or
// rejecting), and mounts RrwebMirror with the given `frozen` value. Returns
// the fallback-call flag plus a teardown that unmounts (cancelling any
// pending FALLBACK_MS timer via the effect's own cleanup) and restores fetch.
async function mount(opts: { frozen: boolean; backlog?: Backlog; fetchFails?: boolean }) {
	const realFetch = globalThis.fetch
	globalThis.fetch = (async () => {
		if (opts.fetchFails) throw new Error('network down')
		return { ok: true, json: async () => opts.backlog } as Response
	}) as typeof fetch

	let fellBack = false
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)

	await act(async () => {
		root.render(
			createElement(RrwebMirror, {
				roomId: 'room1',
				shapeId: 'shape:fv1',
				width: 400,
				height: 300,
				presenterName: '',
				presenterColor: '#3b82f6',
				onFallback: () => {
					fellBack = true
				},
				frozen: opts.frozen,
			})
		)
		// Flush the backlog fetch's microtask chain.
		await new Promise((r) => setTimeout(r, 0))
		await new Promise((r) => setTimeout(r, 0))
	})

	return {
		fellBack: () => fellBack,
		teardown: async () => {
			await act(async () => {
				root.unmount()
			})
			document.body.removeChild(container)
			globalThis.fetch = realFetch
		},
	}
}

async function main() {
	// Frozen + empty backlog (presentId: null, e.g. a never-presented shape,
	// or the frozen relay log doesn't exist) → falls back immediately, no
	// need to wait out FALLBACK_MS.
	{
		const m = await mount({ frozen: true, backlog: { presentId: null, truncated: false, entries: [] } })
		assert.equal(m.fellBack(), true, 'frozen + empty backlog falls back immediately')
		await m.teardown()
	}

	// Frozen + missing backlog (fetch failed) → same immediate fallback.
	{
		const m = await mount({ frozen: true, fetchFails: true })
		assert.equal(m.fellBack(), true, 'frozen + failed fetch falls back immediately')
		await m.teardown()
	}

	// Frozen + a REAL backlog (presentId set) → must NOT bail; the replayer
	// still needs its chance to build from the seeded events.
	{
		const m = await mount({
			frozen: true,
			backlog: { presentId: 'p1', truncated: false, entries: [{ seq: 0, event: { type: 4, data: {} } }] },
		})
		assert.equal(m.fellBack(), false, 'frozen + non-empty backlog does not bail early')
		await m.teardown()
	}

	// Live (not frozen) + empty backlog → the immediate-bail guard is
	// frozen-only; a live presenter's stream may still be in flight over the
	// socket, so this must NOT fall back before FALLBACK_MS elapses.
	{
		const m = await mount({ frozen: false, backlog: { presentId: null, truncated: false, entries: [] } })
		assert.equal(m.fellBack(), false, 'live + empty backlog keeps waiting for the socket stream')
		await m.teardown()
	}

	console.log('ok: RrwebMirror — frozen mirror bails on empty backlog, live mode keeps the fallback window')
}

await main()
