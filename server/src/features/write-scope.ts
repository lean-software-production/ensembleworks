/**
 * Write-scope guard: rejects read-only service tokens on mutating requests
 * (403). Humans, read-write tokens, anonymous callers and "none" instances pass
 * untouched, so this is a no-op unless an operator configured a read-only token.
 * Mounted app-wide before the routers; WS upgrades bypass express and are
 * unaffected (that is the gateway-id binding slice).
 */
import type { RequestHandler } from 'express'
import { resolveWriteScope } from '../whoami.ts'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function createWriteScopeGuard(): RequestHandler {
	return async (req, res, next) => {
		if (READ_METHODS.has(req.method)) return next()
		if ((await resolveWriteScope(req.headers)) === 'read-only') {
			return void res.status(403).json({ error: 'read-only token: writes are not permitted' })
		}
		next()
	}
}
