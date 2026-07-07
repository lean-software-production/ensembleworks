import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

// Mirrors VmStats in server/src/vm-stats.ts (readVmStats return).
const vmStats = z.object({
	cpu: z.object({
		load1: z.number(),
		cores: z.number(),
		pct: z.number(),
		pressure: z.number().nullable(),
	}),
	mem: z.object({
		usedBytes: z.number(),
		limitBytes: z.number().nullable(),
		highBytes: z.number().nullable(),
		usedPct: z.number(),
		pressure: z.number().nullable(),
		source: z.enum(['cgroup', 'host']),
	}),
})

export const avToken: ToolDef = {
	plugin: 'av',
	id: 'token',
	http: { method: 'GET', path: '/api/av/token' },
	help: 'Mint a LiveKit join token for a room (role member or scribe).',
	zodInput: z.object({
		room: z.string().min(1).describe('room id (required; sanitised server-side)'),
		identity: z.string().min(1).max(128).describe('participant identity (required)'),
		name: z.string().max(64).default('teammate').describe('display name'),
		role: z.enum(['member', 'scribe']).default('member').describe('scribe ⇒ subscribe-only token'),
	}),
	// enabled:false when LiveKit isn't configured; else the minted token + url.
	zodOutput: z.union([
		z.object({ enabled: z.literal(false) }),
		z.object({ enabled: z.literal(true), token: z.string(), url: z.string() }),
	]),
}

export const avKick: ToolDef = {
	plugin: 'av',
	id: 'kick',
	http: { method: 'POST', path: '/api/av/kick' },
	help: "Disconnect a user from the room's canvas + media session.",
	zodInput: z.object({
		room: z.string().min(1).describe('room id (required)'),
		userId: z.string().min(1).max(128).describe('presence userId to disconnect (required)'),
	}),
	zodOutput: z.object({ ok: z.literal(true), disconnected: z.number() }),
}

export const avPulse: ToolDef = {
	plugin: 'av',
	id: 'pulse',
	http: { method: 'POST', path: '/api/av/pulse' },
	help: 'Session heartbeat: report RTT, read back latencies + VM pressure.',
	zodInput: z.object({
		room,
		userId: z.string().max(128).optional(),
		rttMs: z.number().min(0).max(60_000).optional().describe('round-trip of the previous pulse, ms'),
	}),
	zodOutput: z.object({
		ok: z.literal(true),
		now: z.number(),
		vm: vmStats,
		latencies: z.record(z.string(), z.object({ rtt: z.number(), t: z.number() })),
	}),
}

export const avTools: ToolDef[] = [avToken, avKick, avPulse]
