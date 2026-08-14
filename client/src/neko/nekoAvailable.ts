/**
 * Is the shared browser (neko) actually running? Caddy always mounts the
 * /shared-browser/* route, so when the container is off the route answers
 * 502 — one HEAD probe at first use distinguishes the two. Result is cached
 * for the session (the service is a permanent systemd unit: it doesn't
 * flap, and a stale "up" only re-shows a button whose shape would 502,
 * today's behaviour anyway).
 */
import { useSyncExternalStore } from 'react'

let available: boolean | null = null
let probeStarted = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
	listeners.add(cb)
	return () => listeners.delete(cb)
}

function getSnapshot(): boolean {
	if (!probeStarted) {
		probeStarted = true
		void fetch('/shared-browser/', { method: 'HEAD' })
			.then((res) => {
				available = res.status < 500
			})
			.catch(() => {
				available = false
			})
			.then(() => {
				for (const cb of listeners) cb()
			})
	}
	// Hidden while the probe is in flight: appearing a beat late (enabled
	// hosts) is less jarring than flashing and vanishing on every load
	// (disabled hosts — the case that motivated this probe).
	return available ?? false
}

/** Reactive availability for the command bar's useAvailable slot. */
export function useNekoAvailable(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot)
}
