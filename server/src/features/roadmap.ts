/**
 * Roadmap feature — GET /api/roadmap/doc lists/reads roadmap docs; POST
 * /api/roadmap/doc creates/replaces or applies targeted ops with ifRev
 * concurrency, bumping the rev prop on canvas shapes that reference the doc.
 */
import { slugify } from '@ensembleworks/contracts'
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { OpError, applyOps, type RoadmapOp } from '../roadmap-store.ts'

export function createRoadmapRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Roadmap (two-way roadmap control): the document lives in the roadmap
	// store, not the tldraw document — shapes hold only { roadmapId, rev }.
	// GET /api/roadmap/doc?room=[&name=] — without name: list; with name: full
	// document + rev (exact-id first, then fuzzy name match like /api/frame).
	router.get('/api/roadmap/doc', async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
		if (!name) {
			return void res.json({ ok: true, roadmaps: await ctx.storage.roadmaps.list(roomId) })
		}
		const found = await ctx.storage.roadmaps.get(roomId, name)
		if (!found) return void res.status(404).json({ error: 'roadmap not found' })
		res.json({
			ok: true,
			id: found.id,
			name: found.name,
			rev: found.rev,
			updated: found.updated,
			data: found.data,
		})
	})

	// POST /api/roadmap/doc — one write path for humans (canvas drags/status
	// clicks) and agents (CLI): an all-or-nothing op batch. Creates the
	// roadmap when the batch starts with replace and nothing matches `name`.
	// ifRev guards wholesale regenerate-and-push flows against clobbering
	// edits that landed since the caller last read (409 carries current rev).
	router.post('/api/roadmap/doc', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof body.name === 'string' ? body.name.trim() : ''
		if (!name) return void res.status(400).json({ error: 'name is required' })
		if (name.length > 128) return void res.status(400).json({ error: 'name must be 128 characters or fewer' })
		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

		// The store's lock serializes the whole read-modify-write; POST bodies
		// interleave across awaits, so without it two writers read the same rev.
		await ctx.storage.roadmaps.withLock(roomId, async () => {
			const existing = await ctx.storage.roadmaps.get(roomId, name)
			if (ifRev !== null && !existing) {
				return void res
					.status(409)
					.json({ error: `ifRev ${ifRev} given but no roadmap matches '${name}'` })
			}
			if (existing && ifRev !== null && ifRev !== existing.rev) {
				return void res
					.status(409)
					.json({ error: `stale ifRev ${ifRev} (current rev is ${existing.rev})`, rev: existing.rev })
			}

			let data
			try {
				data = applyOps(existing?.data ?? null, body.ops as RoadmapOp[])
			} catch (err) {
				if (err instanceof OpError) return void res.status(err.status).json({ error: err.message })
				return void res.status(400).json({ error: `invalid ops: ${err}` })
			}

			const id = existing?.id ?? slugify(name)
			if (!id) return void res.status(400).json({ error: 'name does not reduce to a valid id' })
			const rev = (existing?.rev ?? 0) + 1
			const updated = new Date().toISOString().slice(0, 10)
			data.meta.updated = updated // server-stamped; client-supplied values are ignored
			await ctx.storage.roadmaps.write(roomId, id, { name: existing?.name ?? name, rev, updated, data })

			// Rev fan-out: stamp the new rev onto every shape bound to this roadmap
			// so tldraw sync broadcasts "data changed" and open clients refetch over
			// HTTP (the /api/terminal/status mechanism).
			// Fan-out is best-effort; the store write already succeeded.
			let shapesUpdated = 0
			try {
				await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
					for (const record of store.getAll() as any[]) {
						if (
							record.typeName === 'shape' &&
							record.type === 'roadmap' &&
							record.props?.roadmapId === id
						) {
							store.put({ ...record, props: { ...record.props, rev } })
							shapesUpdated++
						}
					}
				})
			} catch (err) {
				console.warn(`[room ${roomId}] roadmap rev fan-out failed`, err)
			}
			res.json({ ok: true, id, rev, shapesUpdated })
		})
	})

	return router
}
