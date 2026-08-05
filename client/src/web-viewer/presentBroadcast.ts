/**
 * Presenter-side rrweb event batcher (spec:
 * 2026-07-27-file-viewer-rrweb-broadcast-design.md). Buffers ew-rrweb-event
 * payloads and flushes one POST per interval; on ~5 s of consecutive flush
 * failures fires onDegrade once (the shape reverts to scroll-fraction-only
 * present) and goes quiet. Clock/fetch/interval are injectable for tests.
 */

type PostJson = (url: string, body: unknown) => Promise<{ ok: boolean; truncated?: boolean }>

const defaultPostJson: PostJson = async (url, body) => {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`POST ${url} → ${res.status}`)
	let truncated = false
	try {
		const json = (await res.json()) as { truncated?: boolean } | null
		truncated = Boolean(json?.truncated)
	} catch {
		// present-stop's response (and any other) may carry no body worth parsing.
	}
	return { ok: true, truncated }
}

export function createPresentBroadcaster(opts: {
	roomId: string
	shapeId: string
	presentId: string
	postJson?: PostJson
	setIntervalFn?: typeof setInterval
	clearIntervalFn?: typeof clearInterval
	now?: () => number
	onDegrade?: () => void
	flushMs?: number
	failAfterMs?: number
}): { push(event: unknown): void; stop(): Promise<void> } {
	const postJson = opts.postJson ?? defaultPostJson
	const now = opts.now ?? Date.now
	const flushMs = opts.flushMs ?? 150
	const failAfterMs = opts.failAfterMs ?? 5000
	const setIntervalFn = opts.setIntervalFn ?? setInterval
	const clearIntervalFn = opts.clearIntervalFn ?? clearInterval

	let seq = 0
	let queue: { seq: number; event: unknown }[] = []
	let firstFailureAt: number | null = null
	let degraded = false
	let flushing = false
	let inFlight: Promise<void> | null = null

	async function flush(): Promise<void> {
		if (degraded || flushing || queue.length === 0) return
		flushing = true
		inFlight = (async () => {
			let sent: typeof queue = []
			try {
				sent = queue
				queue = []
				const result = await postJson('/api/canvas/web-viewer/present-events', {
					room: opts.roomId,
					shapeId: opts.shapeId,
					presentId: opts.presentId,
					entries: sent,
				})
				firstFailureAt = null
				// Server-side overflow/truncation: same degrade path as sustained
				// failure — stop posting and let the shape revert to scroll-fraction.
				if (result.truncated && !degraded) {
					degraded = true
					clearIntervalFn(timer)
					opts.onDegrade?.()
				}
			} catch {
				// Keep the queue (retry next tick); degrade after sustained failure.
				queue = [...sent, ...queue]
				if (firstFailureAt === null) firstFailureAt = now()
				else if (now() - firstFailureAt >= failAfterMs) {
					degraded = true
					clearIntervalFn(timer)
					opts.onDegrade?.()
				}
			} finally {
				flushing = false
				inFlight = null
			}
		})()
		await inFlight
	}

	const timer = setIntervalFn(() => void flush(), flushMs)

	return {
		push(event) {
			if (degraded) return
			queue.push({ seq: seq++, event })
		},
		async stop() {
			clearIntervalFn(timer)
			if (inFlight) await inFlight
			await flush()
			if (!degraded) {
				try {
					await postJson('/api/canvas/web-viewer/present-stop', {
						room: opts.roomId,
						shapeId: opts.shapeId,
						presentId: opts.presentId,
					})
				} catch {
					// Best effort — a failed present-stop just leaves the relay log as
					// the frozen last view (spec: it's retained until replaced, no TTL).
				}
			}
		},
	}
}
