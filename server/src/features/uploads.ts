import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { sanitizeAssetId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

export function createUploadsRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	router.put('/uploads/:id', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
		const id = sanitizeAssetId(req.params.id)
		if (!id) return void res.status(400).json({ error: 'bad asset id' })
		await writeFile(path.join(ctx.storage.uploadsDir, id), req.body)
		res.json({ ok: true })
	})

	router.get('/uploads/:id', async (req, res) => {
		const id = sanitizeAssetId(req.params.id)
		if (!id) return void res.status(400).json({ error: 'bad asset id' })
		try {
			res.send(await readFile(path.join(ctx.storage.uploadsDir, id)))
		} catch {
			res.status(404).json({ error: 'not found' })
		}
	})

	return router
}
