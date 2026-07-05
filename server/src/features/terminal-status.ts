import { isTerminalStatus, TERMINAL_STATUSES } from '@ensembleworks/contracts'
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

export function createTerminalStatusRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	router.post('/api/terminal-status', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
		const status = typeof body.status === 'string' ? body.status : ''
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!sessionId) return void res.status(400).json({ error: 'sessionId is required' })
		if (!isTerminalStatus(status)) {
			return void res
				.status(400)
				.json({ error: `status must be one of ${TERMINAL_STATUSES.join(' | ')}` })
		}
		let updated = 0
		await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
			for (const record of store.getAll() as any[]) {
				if (
					record.typeName === 'shape' &&
					record.type === 'terminal' &&
					record.props?.sessionId === sessionId
				) {
					store.put({ ...record, props: { ...record.props, status } })
					updated++
				}
			}
		})
		res.json({ ok: true, updated })
	})

	return router
}
