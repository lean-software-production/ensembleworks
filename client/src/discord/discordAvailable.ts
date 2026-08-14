/**
 * Is the Discord bridge bot running? The bot's only HTTP face lives on the
 * server's loopback, so /api/discord/health answers on its behalf (any HTTP
 * response from the bot's port = up). Same cached-single-probe pattern as
 * neko/nekoAvailable.ts: probed once per session, hidden until confirmed.
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
		void fetch('/api/discord/health')
			.then((res) => (res.ok ? res.json() : { up: false }))
			.then((body: { up?: boolean }) => {
				available = body.up === true
			})
			.catch(() => {
				available = false
			})
			.then(() => {
				for (const cb of listeners) cb()
			})
	}
	return available ?? false
}

/** Reactive availability for the command bar's useAvailable slot. */
export function useDiscordAvailable(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot)
}
