/**
 * Sticky feature — POST /api/canvas/sticky posts a note to the canvas, optionally
 * parented to a fuzzy-matched frame, with agent-author styling.
 */
import { createShapeId, toRichText } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import { NOTE_COLORS, STICKY_GRID_COLS, STICKY_GRID_STEP } from '../canvas/constants.ts'
import { findFrameByName } from '../canvas/frames-helper.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { schema } from '../schema.ts'

export function createStickyRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Canvas API (session MVP): lets agents post advice stickies, whether or
	// not the room is open.

	router.post('/api/canvas/sticky', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const text = typeof body.text === 'string' ? body.text.trim() : ''
		const frame = typeof body.frame === 'string' ? body.frame : null
		const color = typeof body.color === 'string' ? body.color : 'yellow'
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!text || text.length > 2000) {
			return void res.status(400).json({ error: 'text must be non-empty and at most 2000 chars' })
		}
		if (!NOTE_COLORS.includes(color)) {
			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
		}
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
				// Grid inside the frame, based on how many notes it already holds.
				const count = shapes.filter((r) => r.type === 'note' && r.parentId === parentId).length
				x = 20 + (count % STICKY_GRID_COLS) * STICKY_GRID_STEP
				y = 20 + Math.floor(count / STICKY_GRID_COLS) * STICKY_GRID_STEP
			} else {
				// No frame: page origin area, offset by note count so stickies
				// don't stack exactly.
				parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				const count = shapes.filter((r) => r.type === 'note' && r.parentId === parentId).length
				x = count * 40
				y = count * 40
			}

			const siblings = shapes.filter(
				(r) => r.parentId === parentId && typeof r.index === 'string'
			)
			const topIndex = siblings.length ? siblings.sort(sortByIndex).at(-1)!.index : undefined
			const id = createShapeId()
			const note = (schema.types.shape as any).create({
				id,
				type: 'note',
				parentId,
				index: getIndexAbove(topIndex),
				x,
				y,
				props: {
					richText: toRichText(text),
					color,
					labelColor: 'black',
					size: 'm',
					font: 'draw',
					// Multiplier on the label font size (1 = unadjusted). 0 would
					// render the text at 0px — i.e. an invisible label.
					fontSizeAdjustment: 1,
					align: 'middle',
					verticalAlign: 'middle',
					growY: 0,
					url: '',
					scale: 1,
					textFirstEditedBy: null,
				},
			})
			store.put(note)
			createdId = id
		})
		if (!frameFound) return void res.status(404).json({ error: 'frame not found' })
		res.json({ ok: true, id: createdId })
	})

	return router
}
