import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

// Mirrors RoadmapDoc + its nested interfaces in server/src/roadmap-store.ts.
// (The store validates structure/keys; the manifest only describes the shape.)
const roadmapMetric = z.object({ key: z.string(), text: z.string(), done: z.boolean() })
const roadmapFeature = z.object({ key: z.string(), text: z.string(), status: z.string() })
const roadmapInitiative = z.object({
	key: z.string(),
	title: z.string(),
	status: z.string(),
	statement: z.string().optional(),
	metrics: z.array(roadmapMetric).optional(),
	features: z.array(roadmapFeature).optional(),
})
const roadmapOutcome = z.object({
	key: z.string(),
	zone: z.string(),
	status: z.string(),
	title: z.string(),
	why: z.string().optional(),
	initiatives: z.array(roadmapInitiative).optional(),
})
const roadmapDoc = z.object({
	meta: z.object({
		title: z.string(),
		revision: z.string().optional(),
		updated: z.string().optional(),
	}),
	outcomes: z.array(roadmapOutcome),
})

// RoadmapOp vocabulary (replace | set | move) — server/src/roadmap-store.ts.
const roadmapOp = z.discriminatedUnion('op', [
	z.object({ op: z.literal('replace'), data: roadmapDoc }),
	z.object({ op: z.literal('set'), key: z.string(), fields: z.record(z.string(), z.unknown()) }),
	z.object({ op: z.literal('move'), key: z.string(), zone: z.string().optional(), index: z.number().int().optional() }),
])

export const roadmapWrite: ToolDef = {
	plugin: 'roadmap',
	id: 'write',
	http: { method: 'POST', path: '/api/roadmap/doc' },
	help: 'Create/replace or apply targeted ops to a roadmap doc (ifRev).',
	zodInput: z.object({
		room,
		name: z.string().min(1).max(128).describe('roadmap name (required); a new doc must start with a replace op'),
		ifRev: z.number().optional().describe('optimistic-concurrency guard; 409 on mismatch'),
		ops: z.array(roadmapOp).min(1).describe('all-or-nothing op batch'),
	}),
	zodOutput: z.object({
		ok: z.literal(true),
		id: z.string(),
		rev: z.number(),
		shapesUpdated: z.number(),
	}),
}

export const roadmapRead: ToolDef = {
	plugin: 'roadmap',
	id: 'read',
	http: { method: 'GET', path: '/api/roadmap/doc' },
	help: 'List roadmaps (no name) or read one (name) with its rev.',
	zodInput: z.object({
		room,
		name: z.string().optional().describe('omit to list; provide (exact id or fuzzy name) to read one'),
	}),
	// No name → { ok, roadmaps: [...] }; with name → the full doc. Union both.
	zodOutput: z.union([
		z.object({
			ok: z.literal(true),
			roadmaps: z.array(z.object({
				id: z.string(), name: z.string(), rev: z.number(), updated: z.string(),
			})),
		}),
		z.object({
			ok: z.literal(true),
			id: z.string(),
			name: z.string(),
			rev: z.number(),
			updated: z.string(),
			data: roadmapDoc,
		}),
	]),
}

export const roadmapTools: ToolDef[] = [roadmapWrite, roadmapRead]
