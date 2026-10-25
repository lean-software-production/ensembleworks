// @ts-check
/**
 * Loopback TCP probe, shared by the engine (health polls, doctor) and the
 * host controller (port-offset auto-pick). Kept out of dev-main.mjs because
 * that module's top level runs engine-only gates (Bun version, dev.env).
 */
import { connect } from 'node:net'

/** @param {string} host @param {number} port @param {number} timeoutMs */
function probeAddr(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const sock = connect({ port, host })
		/** @param {boolean} ok */
		const done = (ok) => {
			sock.destroy()
			resolve(ok)
		}
		sock.once('connect', () => done(true))
		sock.once('error', () => done(false))
		sock.setTimeout(timeoutMs, () => done(false))
	})
}

/**
 * Node 22 binds localhost-listening services (vite) to ::1 while others sit
 * on 127.0.0.1 — a port is "taken" when EITHER loopback family answers.
 * @param {number} port
 */
export async function probePort(port, timeoutMs = 1000) {
	const results = await Promise.all([
		probeAddr('127.0.0.1', port, timeoutMs),
		probeAddr('::1', port, timeoutMs),
	])
	return results.some(Boolean)
}
