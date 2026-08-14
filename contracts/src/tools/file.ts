import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

export const fileOpen: ToolDef = {
	plugin: 'file',
	id: 'open',
	http: { method: 'POST', path: '/api/canvas/web-viewer' },
	help: 'Open a file or local dev server on the canvas in a web-viewer control.',
	zodInput: z.object({
		op: z.literal('open').default('open'),
		room,
		path: z.string().optional().describe('path relative to the agent home, e.g. my-repo/docs/report.html'),
		title: z.string().optional().describe('header title (defaults to the filename)'),
		frame: z.string().optional().describe('fuzzy frame name to place the control in'),
		gateway: z.string().optional().describe('remote gateway id (v1: rejected with 501)'),
		port: z.number().int().min(1).max(65535).optional()
			.describe('local dev server port — creates a dev-source web viewer instead of a file'),
	}),
	zodOutput: z.object({ ok: z.boolean(), id: z.string() }),
}

export const fileRefresh: ToolDef = {
	plugin: 'file',
	id: 'refresh',
	http: { method: 'POST', path: '/api/canvas/web-viewer' },
	help: 'Reload every open file-viewer showing a path (bumps the synced rev).',
	zodInput: z.object({
		op: z.literal('refresh').default('refresh'),
		room,
		path: z.string().min(1).describe('the path whose viewers should reload'),
		gateway: z.string().optional().describe('remote gateway id (v1: rejected with 501)'),
	}),
	zodOutput: z.object({ ok: z.boolean(), updated: z.number() }),
}

export const fileTools: ToolDef[] = [fileOpen, fileRefresh]
