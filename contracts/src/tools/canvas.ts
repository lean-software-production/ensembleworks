import { z } from 'zod'
import { NOTE_COLORS, GEO_TYPES } from '../constants.js'   // relocated in Task 1
import type { ToolDef } from './types.js'

const room = z.string().default('team')
const okId = z.object({ ok: z.literal(true), id: z.string().nullable() })

export const canvasSticky: ToolDef = {
	plugin: 'canvas',
	id: 'sticky',
	http: { method: 'POST', path: '/api/canvas/sticky' },
	help: 'Post a sticky note, optionally parented to a fuzzy-matched frame.',
	zodInput: z.object({
		room,
		text: z.string().min(1).max(2000).describe('sticky body; trimmed, 1–2000 chars'),
		frame: z.string().optional().describe('fuzzy (case-insensitive substring) frame name'),
		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional().describe('defaults to yellow server-side'),
		author: z.string().optional().describe('voluntary display name; honoured only on anonymous/"none" instances — ignored when the caller is credentialed'),
	}),
	zodOutput: okId,
}

export const canvasShape: ToolDef = {
	plugin: 'canvas',
	id: 'shape',
	http: { method: 'POST', path: '/api/canvas/shape' },
	help:
		'Create/update/delete a diagram shape. create type ∈ geo|text|note|arrow|frame|line|draw|highlight. ' +
		'line/draw/highlight take --points (page coords, [[x,y],…] or [x,y,pressure], JSON or @file); ' +
		'draw takes --closed/--fill, line takes --spline line|cubic. ' +
		'update <id> --frame <name> reparents INTO a frame, --to-page reparents OUT to its page ' +
		'(both preserve page-position; correct for UNROTATED parents only), --rotate <rad>/--lock are riders. ' +
		'delete <frame-id> keeps children on the frame\'s page; --with-children cascades descendants + bindings.',
	zodInput: z.object({
		room,
		op: z.enum(['create', 'update', 'delete']).default('create'),
		// create
		type: z.enum(['geo', 'text', 'note', 'arrow', 'frame', 'line', 'draw', 'highlight']).optional(),
		frame: z.string().optional(),
		geo: z.enum(GEO_TYPES as [string, ...string[]]).optional(),
		fromId: z.string().optional().describe('arrow start shape id'),
		toId: z.string().optional().describe('arrow end shape id'),
		name: z.string().optional().describe('frame caption (props.name)'),
		points: z.array(z.array(z.number())).optional().describe('line/draw/highlight polyline/stroke points, page coords'),
		spline: z.enum(['line', 'cubic']).optional().describe('line only; default line'),
		closed: z.boolean().optional().describe('draw only; sets isClosed'),
		// update / delete
		id: z.string().optional().describe('required for update/delete'),
		rotate: z.number().optional().describe('set rotation in radians (exact)'),
		lock: z.boolean().optional().describe('set isLocked'),
		toPage: z.boolean().optional().describe("reparent OUT to the frame's page"),
		withChildren: z.boolean().optional().describe('frame delete: cascade descendants + bindings'),
		// shared
		text: z.string().optional(),
		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional(),
		fill: z.string().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: z.number().optional(),
		h: z.number().optional(),
		props: z.record(z.string(), z.unknown()).optional().describe('raw prop merge (update)'),
		author: z.string().optional().describe('voluntary display name; honoured only on anonymous/"none" instances — ignored when the caller is credentialed'),
	}),
	// create/update → { ok, id }; delete → { ok, deleted }. Union both success shapes.
	zodOutput: z.union([okId, z.object({ ok: z.literal(true), deleted: z.number() })]),
}

export const canvasFrames: ToolDef = {
	plugin: 'canvas',
	id: 'frames',
	http: { method: 'GET', path: '/api/canvas/frames' },
	help: 'List frames with child counts (notes/texts/images/terminals/iframes/drawings), nearest-cursor-first.',
	zodInput: z.object({ room }),
	zodOutput: z.object({
		ok: z.literal(true),
		sortedBy: z.object({
			userName: z.string(), page: z.string(), cursor: z.object({ x: z.number(), y: z.number() }),
		}).nullable(),
		frames: z.array(z.object({
			id: z.string(), name: z.string(), page: z.string().nullable(),
			x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(),
			notes: z.number(), texts: z.number(), images: z.number(),
			terminals: z.number(), iframes: z.number(), drawings: z.number(),
			dist: z.number().nullable().optional(),
		})),
	}),
}

export const canvasFrame: ToolDef = {
	plugin: 'canvas',
	id: 'frame',
	http: { method: 'GET', path: '/api/canvas/frame' },
	help: "Read one frame's stickies, text, images, terminals, iframes, drawings.",
	zodInput: z.object({ room, name: z.string().min(1).describe('fuzzy frame name') }),
	zodOutput: z.object({
		ok: z.literal(true),
		frame: z.object({ id: z.string(), name: z.string().optional(), page: z.string().nullable() }),
		sortedBy: z.object({ userName: z.string(), cursor: z.object({ x: z.number(), y: z.number() }) }).nullable(),
		notes: z.array(z.object({ id: z.string(), text: z.string(), color: z.string().optional() })),
		texts: z.array(z.object({ id: z.string(), text: z.string() })),
		images: z.array(z.object({
			id: z.string(), url: z.string().nullable(), name: z.string().nullable(),
			w: z.number().optional(), h: z.number().optional(),
		})),
		terminals: z.array(z.object({ id: z.string(), sessionId: z.string().optional(), title: z.string().optional(), status: z.string().nullable() })),
		iframes: z.array(z.object({ id: z.string(), url: z.string().optional(), title: z.string().optional() })),
		drawings: z.array(z.object({ id: z.string(), type: z.string(), text: z.string().optional() })),
	}),
}

export const canvasTools: ToolDef[] = [canvasSticky, canvasShape, canvasFrames, canvasFrame]
