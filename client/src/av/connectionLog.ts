/**
 * Client connection-telemetry log. Buffers connection-lifecycle events from both
 * planes and flushes them to POST /api/telemetry/connection with sendBeacon —
 * batched (~5s debounce), fire-and-forget: the beacon must NEVER make a bad
 * connection worse, so a failed send is dropped, never retried, never thrown.
 * Also mirrored to console.debug for live devtools reading. See spec §2.
 */
export interface ClientConnEvent {
	ts: number
	roomId: string
	userId: string
	plane: 'livekit' | 'sync' | 'lock'
	event: string
	detail?: unknown
}

interface ConnectionLogOpts {
	send: (events: ClientConnEvent[]) => void
	now?: () => number
	debounceMs?: number
	schedule?: (fn: () => void, ms: number) => unknown
	cancel?: (handle: unknown) => void
}

export function createConnectionLog(opts: ConnectionLogOpts) {
	const now = opts.now ?? Date.now
	const debounceMs = opts.debounceMs ?? 5000
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
	const buf: ClientConnEvent[] = []
	let timer: unknown = null

	function flush() {
		if (timer !== null) {
			cancel(timer)
			timer = null
		}
		if (buf.length === 0) return
		const batch = buf.splice(0, buf.length)
		try {
			opts.send(batch)
		} catch {
			/* fire-and-forget: never let telemetry surface an error */
		}
	}

	function log(e: Omit<ClientConnEvent, 'ts'> & { ts?: number }) {
		buf.push({ ...e, ts: e.ts ?? now() })
		if (timer === null) timer = schedule(flush, debounceMs)
	}

	return { log, flush }
}

// --- Module singleton wired to the real beacon --------------------------------

let ctxRoomId = ''
let ctxUserId = ''

export function configureConnectionLog(ctx: { roomId: string; userId: string }) {
	ctxRoomId = ctx.roomId
	ctxUserId = ctx.userId
}

const singleton = createConnectionLog({
	send: (events) => {
		try {
			// application/json so express.json() parses the beacon body server-side.
			const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' })
			navigator.sendBeacon('/api/telemetry/connection', blob)
		} catch {
			/* drop */
		}
	},
})

export function logConnectionEvent(plane: 'livekit' | 'sync' | 'lock', event: string, detail?: unknown) {
	if (!ctxRoomId) return
	console.debug(`[conn] ${plane} ${event}`, detail ?? '')
	singleton.log({ roomId: ctxRoomId, userId: ctxUserId, plane, event, detail })
}

export function flushConnectionLog() {
	singleton.flush()
}
