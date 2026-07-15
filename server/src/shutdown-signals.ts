/**
 * F2 graceful-shutdown signal handler, factored out of sync-server.ts so the
 * double-signal state machine is unit-testable (the entrypoint boots a real
 * server on import — importing it from a test is a non-starter, so the logic
 * lives here and sync-server.ts only wires process.on + real deps).
 *
 * Contract (locked by ./shutdown-signals.test.ts):
 *  - FIRST signal: run the full teardown (deps.close() — app.ts's close():
 *    stops the shadow/idle-sweep intervals, force-closes every ws client,
 *    persists + releases every canvas-v2 actor, closes the http server with
 *    its own bounded fallback) and exit(0) once it resolves. A rejecting
 *    close() exits 1 — never a hang either way (close() itself is internally
 *    bounded, see app.ts).
 *  - SECOND signal while teardown is in flight: the operator wants OUT now
 *    (e.g. close() is stuck on something its own bound didn't anticipate) —
 *    exit(1) immediately, no second close() attempted.
 * All effects are injected (close/exit/log/warn/error) so the test drives the
 * machine purely, with no real signals or process.exit.
 */

export interface ShutdownDeps {
	close(): Promise<void>
	exit(code: number): void
	log(msg: string): void
	warn(msg: string): void
	error(msg: string, err?: unknown): void
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
	let shuttingDown = false
	return (signal: string): void => {
		if (shuttingDown) {
			deps.warn(`ensembleworks sync server: received ${signal} again during shutdown — exiting immediately`)
			deps.exit(1)
			return
		}
		shuttingDown = true
		deps.log(`ensembleworks sync server: received ${signal}, shutting down gracefully...`)
		deps
			.close()
			.then(() => {
				deps.log('ensembleworks sync server: shutdown complete')
				deps.exit(0)
			})
			.catch((err) => {
				deps.error('ensembleworks sync server: shutdown hook threw — exiting anyway', err)
				deps.exit(1)
			})
	}
}
