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
	help: 'List registered remote terminal gateways (codespaces carry repo/branch/inputPolicy).',
	zodInput: z.object({}),
	zodOutput: z.object({
		gateways: z.array(z.object({
			gatewayId: z.string(),
			label: z.string(),
			relayOnly: z.literal(true),
			connectedAt: z.number(),
			repo: z.string().optional(),
			branch: z.string().optional(),
			inputPolicy: z.enum(['locked', 'shared']),
			owner: z.string(),
			viewerIsOwner: z.boolean(),
		})),
	}),
}

export const terminalInputPolicy: ToolDef = {
	plugin: 'terminal',
	id: 'input-policy',
	http: { method: 'POST', path: '/api/terminal/input-policy' },
	help: 'Set a gateway input policy (owner only): locked (viewers read-only) or shared.',
	zodInput: z.object({
		gatewayId: z.string().min(1).describe('registered gateway id (required)'),
		policy: z.enum(['locked', 'shared']),
	}),
	zodOutput: z.object({
		ok: z.literal(true),
		gatewayId: z.string(),
		policy: z.enum(['locked', 'shared']),
	}),
}

export const terminalTools: ToolDef[] = [terminalStatus, terminalList, terminalInputPolicy]
