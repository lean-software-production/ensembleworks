import { z } from 'zod'
import { whoamiSchema } from '../whoami.js'
import type { ToolDef } from './types.js'

export const kernelWhoami: ToolDef = {
	plugin: 'kernel',
	id: 'whoami',
	http: { method: 'GET', path: '/api/whoami' },
	help: "Resolve the caller's identity envelope (human/bot/anonymous + via).",
	zodInput: z.object({}),          // no params
	zodOutput: whoamiSchema,         // reused from contracts/src/whoami.ts
}

export const kernelParticipants: ToolDef = {
	plugin: 'kernel',
	id: 'participants',
	http: { method: 'GET', path: '/api/participants' },
	help: 'List live presence joined with captured Access identities.',
	zodInput: z.object({
		room: z.string().default('team'),
		page: z.string().optional().describe('restrict to one tldraw page'),
	}),
	zodOutput: z.object({
		room: z.string(),
		page: z.string().nullable(),
		participants: z.array(z.object({}).loose()),   // shape owned by presence.ts; kept loose in 3b
	}),
}

export const kernelTools: ToolDef[] = [kernelWhoami, kernelParticipants]
