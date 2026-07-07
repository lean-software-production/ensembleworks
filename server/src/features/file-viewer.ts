/**
 * file-viewer feature — POST /api/canvas/file-viewer.
 *   op:open     create a file-viewer shape pointing at a home-relative path
 *               (placement + attribution modelled on sticky).
 *   op:refresh  bump rev on every file-viewer shape matching the path — the
 *               "everyone look again" nudge (roadmap rev fan-out pattern).
 * v1 rejects `gateway` with 501 (the remote seam lands with the connector).
 */
import { fileOpen } from '@ensembleworks/contracts'
import { createShapeId } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import os from 'node:os'
import path from 'node:path'
import { STICKY_GRID_COLS, STICKY_GRID_STEP } from '../canvas/constants.ts'
import { findFrameByName } from '../canvas/frames-helper.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { schema } from '../schema.ts'
import { resolveAttribution } from '../kernel/attribution.ts'
import { resolveCaller } from '../whoami.ts'

const AGENT_HOME = () => process.env.ENSEMBLEWORKS_AGENT_HOME ?? os.homedir()

/** Home-relativise + validate. Returns the clean relative path or null. */
export function normalizeHomePath(raw: string): string | null {
	let p = raw.trim()
	if (!p) return null
	if (p.startsWith('~/')) p = p.slice(2)
	const home = AGENT_HOME()
	if (p.startsWith('/')) {
		if (p === home || p.startsWith(home + '/')) p = p.slice(home.length + 1)
		else return null // absolute outside home
	}
	// reject traversal anywhere
	if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
	return p
}

export function createFileViewerRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Canvas API (session MVP): lets agents pop a file open on the canvas and
	// nudge every open viewer to reload, whether or not the room is open.

	router.post(fileOpen.http.path, async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })

		const op = typeof body.op === 'string' ? body.op : ''
		if (op !== 'open' && op !== 'refresh') {
			return void res.status(400).json({ error: 'op must be open | refresh' })
		}

		// v1 has no remote transport; reject before touching the store so a
		// misconfigured gateway never creates/refreshes a local-only shape.
		const gateway = typeof body.gateway === 'string' ? body.gateway.trim() : ''
		if (gateway) {
			return void res.status(501).json({ error: 'remote files not yet supported (v1)' })
		}

		const rawPath = typeof body.path === 'string' ? body.path : ''
		const cleanPath = normalizeHomePath(rawPath)
		if (!cleanPath) {
			return void res
				.status(400)
				.json({ error: 'path must be a non-empty path within the agent home (no ../ traversal)' })
		}

		// ---- refresh ------------------------------------------------------------
		if (op === 'refresh') {
			let updated = 0
			await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
				for (const record of store.getAll() as any[]) {
					if (
						record.typeName === 'shape' &&
						record.type === 'file-viewer' &&
						record.props?.path === cleanPath
					) {
						store.put({ ...record, props: { ...record.props, rev: (record.props.rev ?? 0) + 1 } })
						updated++
					}
				}
			})
			return void res.json({ ok: true, updated })
		}

		// ---- open -----------------------------------------------------------------
		const frame = typeof body.frame === 'string' ? body.frame : null
		const title =
			typeof body.title === 'string' && body.title.trim() ? body.title.trim() : path.basename(cleanPath)

		// Attribution: stamp the real caller (credential wins; anonymous body.author
		// is a cosmetic badge only) — same rule as sticky, though the file-viewer
		// has no free-text surface to badge, so only meta.author is used.
		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)

		let createdId: string | null = null
		let frameFound = true
		await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
			const records = store.getAll() as any[]
			const shapes = records.filter((r) => r.typeName === 'shape')

			let parentId: string
			let x: number
			let y: number
			if (frame) {
				const target = findFrameByName(shapes, frame)
				if (!target) {
					frameFound = false
					return
				}
				parentId = target.id
				// Grid inside the frame, based on how many file-viewers it already holds.
				const count = shapes.filter((r) => r.type === 'file-viewer' && r.parentId === parentId).length
				x = 20 + (count % STICKY_GRID_COLS) * STICKY_GRID_STEP
				y = 20 + Math.floor(count / STICKY_GRID_COLS) * STICKY_GRID_STEP
			} else {
				// No frame: page origin area, offset by file-viewer count so tiles
				// don't stack exactly.
				parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				const count = shapes.filter((r) => r.type === 'file-viewer' && r.parentId === parentId).length
				x = count * 40
				y = count * 40
			}

			const siblings = shapes.filter(
				(r) => r.parentId === parentId && typeof r.index === 'string'
			)
			const topIndex = siblings.length ? siblings.sort(sortByIndex).at(-1)!.index : undefined
			const id = createShapeId()
			const viewer = (schema.types.shape as any).create({
				id,
				type: 'file-viewer',
				parentId,
				index: getIndexAbove(topIndex),
				x,
				y,
				meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
				props: {
					w: 720,
					h: 540,
					path: cleanPath,
					title,
					rev: 0,
				},
			})
			store.put(viewer)
			createdId = id
		})
		if (!frameFound) return void res.status(404).json({ error: 'frame not found' })
		res.json({ ok: true, id: createdId })
	})

	return router
}
