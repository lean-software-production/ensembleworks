/**
 * Refcounted shared poller of GET /api/terminal/list (~5s while any codespace
 * or gateway-backed terminal is mounted — decision log SP3 item 2). One
 * interval for the whole app regardless of subscriber count; stops when the
 * last subscriber unmounts. Factory-injected fetch + interval keep the core
 * bun-testable; the app singleton is at the bottom.
 */
import type { GatewayListEntry } from './gatewayView'

export type GatewayListListener = (gateways: GatewayListEntry[] | null) => void

export interface GatewayPoller {
	/** Starts polling on the first subscriber; the listener is called
	 * immediately with the cached list (null before the first fetch lands).
	 * Returns unsubscribe. */
	subscribe(listener: GatewayListListener): () => void
	/** Force an immediate refresh (e.g. right after a policy POST). */
	refresh(): Promise<void>
}

export function createGatewayPoller(
	fetchList: () => Promise<GatewayListEntry[]>,
	intervalMs: number
): GatewayPoller {
	const listeners = new Set<GatewayListListener>()
	let last: GatewayListEntry[] | null = null
	let timer: ReturnType<typeof setInterval> | null = null
	let inFlight: Promise<void> | null = null

	const refresh = (): Promise<void> => {
		if (inFlight) return inFlight
		inFlight = fetchList()
			.then((list) => {
				last = list
				for (const listener of listeners) listener(last)
			})
			.catch(() => {
				// Transient failure keeps the last good value — no flicker to
				// offline on one dropped poll.
			})
			.finally(() => {
				inFlight = null
			})
		return inFlight
	}

	return {
		subscribe(listener) {
			listeners.add(listener)
			listener(last)
			if (listeners.size === 1) {
				timer = setInterval(() => void refresh(), intervalMs)
				void refresh()
			}
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0 && timer) {
					clearInterval(timer)
					timer = null
				}
			}
		},
		refresh,
	}
}

async function fetchGatewayList(): Promise<GatewayListEntry[]> {
	const res = await fetch('/api/terminal/list')
	if (!res.ok) throw new Error(`list ${res.status}`)
	const body = (await res.json()) as { gateways?: GatewayListEntry[] }
	return body.gateways ?? []
}

/** The app-wide shared poller. */
export const gatewayPoller = createGatewayPoller(fetchGatewayList, 5000)
