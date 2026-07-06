/**
 * Frames feature — GET /api/canvas/frames lists frames with child counts,
 * proximity-ordered from the caller's cursor; GET /api/canvas/frame reads one
 * frame's stickies/text/images/embeds.
 */
import express from 'express'
import { findFrameByName } from '../canvas/frames-helper.ts'
import { pageIdOf, pagePoint, richTextToPlainText } from '../canvas/geometry.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { byProximity, getCursorRefs, pickCursor, sortPointOf } from '../kernel/presence.ts'

export function createFramesRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Read side (mirror of the write endpoints): let agents see what's on the
	// canvas. Both read from getCurrentSnapshot() so they work whether or not a
	// browser is connected, just like the write endpoints' updateStore().

	// GET /api/canvas/frames?room= — discovery: every frame with its child counts.
	// Frames on the active teammate's page are ordered nearest-cursor-first;
	// the rest keep document order (see sortedBy in the response).
	router.get('/api/canvas/frames', (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const room = ctx.rooms.getOrCreateRoom(roomId)
		const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
		const byId = new Map(records.map((r) => [r.id, r]))
		const shapes = records.filter((r) => r.typeName === 'shape')
		const cursor = pickCursor(getCursorRefs(room))

		const frames = shapes
			.filter((r) => r.type === 'frame')
			.map((f) => {
				const children = shapes.filter((r) => r.parentId === f.id)
				const countOf = (t: string) => children.filter((r) => r.type === t).length
				const pt = pagePoint(f, byId)
				return {
					pt,
					id: f.id,
					name: typeof f.props?.name === 'string' ? f.props.name : '',
					page: pageIdOf(f, byId),
					x: f.x,
					y: f.y,
					w: f.props?.w,
					h: f.props?.h,
					notes: countOf('note'),
					texts: countOf('text'),
					images: countOf('image'),
					terminals: countOf('terminal'),
					iframes: countOf('iframe'),
				}
			})

		// Only frames on the cursor's page can be ranked by it; others trail in
		// document order. byProximity strips `pt` and attaches `dist`.
		const ordered = cursor
			? [
					...byProximity(frames.filter((f) => f.page === cursor.currentPageId), cursor),
					...byProximity(frames.filter((f) => f.page !== cursor.currentPageId), null),
				]
			: byProximity(frames, null)

		res.json({
			ok: true,
			sortedBy: cursor ? { userName: cursor.userName, page: cursor.currentPageId, cursor: sortPointOf(cursor) } : null,
			frames: ordered,
		})
	})

	// GET /api/canvas/frame?room=&name= — the contents of one fuzzy-matched frame:
	// stickies, text, images (resolved to their /uploads URL), terminals,
	// iframes. Same case-insensitive name match as POST /api/canvas/sticky.
	router.get('/api/canvas/frame', (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		const name = typeof req.query.name === 'string' ? req.query.name : ''
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!name) return void res.status(400).json({ error: 'name is required' })
		const room = ctx.rooms.getOrCreateRoom(roomId)
		const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
		const byId = new Map(records.map((r) => [r.id, r]))
		const shapes = records.filter((r) => r.typeName === 'shape')
		const frame = findFrameByName(shapes, name)
		if (!frame) return void res.status(404).json({ error: 'frame not found' })

		const children = shapes.filter((r) => r.parentId === frame.id)
		const assetById = new Map(records.filter((r) => r.typeName === 'asset').map((a) => [a.id, a]))
		const byType = (t: string) => children.filter((r) => r.type === t)

		// A child's page-space point is the frame's point plus its own offset.
		const framePt = pagePoint(frame, byId)
		const ptOf = (c: any) => ({ x: framePt.x + (c.x ?? 0), y: framePt.y + (c.y ?? 0) })

		// Only a cursor on this frame's own page can rank its contents.
		const framePage = pageIdOf(frame, byId)
		const cursor = pickCursor(getCursorRefs(room), framePage ?? undefined)

		const notes = byProximity(
			byType('note').map((n) => ({
				pt: ptOf(n),
				id: n.id,
				text: richTextToPlainText(n.props?.richText),
				color: n.props?.color,
			})),
			cursor
		)
		const texts = byProximity(
			byType('text').map((t) => ({
				pt: ptOf(t),
				id: t.id,
				text: richTextToPlainText(t.props?.richText),
			})),
			cursor
		)
		const images = byProximity(
			byType('image').map((img) => {
				const asset = img.props?.assetId ? assetById.get(img.props.assetId) : null
				return {
					pt: ptOf(img),
					id: img.id,
					url: asset?.props?.src ?? null,
					name: asset?.props?.name ?? null,
					w: img.props?.w,
					h: img.props?.h,
				}
			}),
			cursor
		)

		res.json({
			ok: true,
			frame: { id: frame.id, name: frame.props?.name, page: framePage },
			sortedBy: cursor ? { userName: cursor.userName, cursor: sortPointOf(cursor) } : null,
			notes,
			texts,
			images,
			terminals: byType('terminal').map((t) => ({
				id: t.id,
				sessionId: t.props?.sessionId,
				title: t.props?.title,
				status: t.props?.status ?? null,
			})),
			iframes: byType('iframe').map((f) => ({
				id: f.id,
				url: f.props?.url,
				title: f.props?.title,
			})),
		})
	})

	return router
}
