/**
 * Foreground supervision for the exec'd connector (decision #5): run, restart
 * on exit with the relay parity backoff — computeBackoff plus the >30s
 * healthy-duration reset, the same rule as the connector's own reconnect loop
 * (cli/src/connector/relay-client.ts runTransport) — until the signal aborts.
 * Timers/rng injected so tests drive the loop on a fake clock.
 */
import { computeBackoff, RELAY_HEALTHY_RESET_MS } from '@ensembleworks/contracts/relay-parity'
import type { Timers } from '../connector/relay-client.ts'

export interface SuperviseDeps {
	timers: Timers
	rng: () => number
}

/** Runs `runOnce` forever with backoff between exits; resolves once `signal`
 *  aborts (mid-run aborts resolve after the current runOnce settles — the
 *  caller kills its child on abort, so that settle is prompt). */
export async function supervise(runOnce: () => Promise<void>, deps: SuperviseDeps, signal: AbortSignal): Promise<void> {
	let attempt = 0
	while (!signal.aborted) {
		const start = deps.timers.now()
		try {
			await runOnce()
		} catch {
			/* child failure — the caller narrates; the loop only backs off */
		}
		if (signal.aborted) break
		if (deps.timers.now() - start > RELAY_HEALTHY_RESET_MS) attempt = 0
		attempt++
		await new Promise<void>((r) => {
			const settle = () => {
				deps.timers.clearTimeout(h)
				signal.removeEventListener('abort', onAbort)
				r()
			}
			const onAbort = () => settle()
			const h = deps.timers.setTimeout(settle, computeBackoff(attempt, deps.rng))
			signal.addEventListener('abort', onAbort)
		})
	}
}
