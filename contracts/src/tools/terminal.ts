import { z } from 'zod'
import { TERMINAL_STATUSES } from '../constants.js'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

export const terminalStatus: ToolDef = {
	plugin: 'terminal',
	id: 'status',
	http: { method: 'POST', path: '/api/terminal/status' },
	help: 'Set the status light on the terminal shape(s) with a session id.',
	zodInput: z.object({
		room,
		sessionId: z.string().min(1).describe('terminal shape sessionId prop (required)'),
		status: z.enum(TERMINAL_STATUSES),
	}),
	zodOutput: z.object({ ok: z.literal(true), updated: z.number() }),
}

export const terminalList: ToolDef = {
	plugin: 'terminal',
	id: 'list',
	http: { method: 'GET', path: '/api/terminal/list' },
	help: 'List registered remote terminal gateways.',
	zodInput: z.object({}),
	zodOutput: z.object({
		gateways: z.array(z.object({
			gatewayId: z.string(),
			label: z.string(),
			relayOnly: z.literal(true),
			connectedAt: z.number(),
		})),
	}),
}

export const terminalTools: ToolDef[] = [terminalStatus, terminalList]
