import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

export const fileOpen: ToolDef = {
	plugin: 'file',
	id: 'open',
	http: { method: 'POST', path: '/api/canvas/file-viewer' },
	help: 'Open a file from the agent home on the canvas in a file-viewer control.',
	zodInput: z.object({
		op: z.literal('open').default('open'),
		room,
		path: z.string().min(1).describe('path relative to the agent home, e.g. my-repo/docs/report.html'),
		title: z.string().optional().describe('header title (defaults to the filename)'),
		frame: z.string().optional().describe('fuzzy frame name to place the control in'),
		gateway: z.string().optional().describe('remote gateway id (v1: rejected with 501)'),
	}),
	zodOutput: z.object({ ok: z.boolean(), id: z.string() }),
}

export const fileRefresh: ToolDef = {
	plugin: 'file',
	id: 'refresh',
	http: { method: 'POST', path: '/api/canvas/file-viewer' },
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
