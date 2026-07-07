import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

// Mirrors TranscriptEntry in server/src/transcript-store.ts.
const transcriptEntry = z.object({
	id: z.string(),
	t: z.number().describe('ms epoch, server-stamped on append'),
	identity: z.string(),
	name: z.string(),
	text: z.string(),
	page: z.string().nullable(),
	cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
	frame: z.object({ name: z.string(), dist: z.number() }).nullable(),
})

export const scribeSay: ToolDef = {
	plugin: 'scribe',
	id: 'say',
	http: { method: 'POST', path: '/api/scribe/transcript' },
	help: "Append a transcript line (stamped with the speaker's cursor/frame).",
	zodInput: z.object({
		room,
		identity: z.string().min(1).max(128).describe('LiveKit identity == tldraw presence userId (required)'),
		name: z.string().max(64).optional().describe('display name; defaults to identity'),
		text: z.string().min(1).max(4000).describe('utterance; trimmed server-side, 1–4000 chars'),
		t: z.number().optional().describe('ms epoch; server-stamped when omitted'),
	}),
	zodOutput: z.object({ ok: z.literal(true), entry: transcriptEntry }),
}

export const scribeTranscript: ToolDef = {
	plugin: 'scribe',
	id: 'transcript',
	http: { method: 'GET', path: '/api/scribe/transcript' },
	help: "Read the room's transcript tail (since/limit, oldest first).",
	zodInput: z.object({
		room,
		since: z.number().min(0).default(0).describe('ms epoch; entries with t > since'),
		limit: z.number().min(1).default(1000),
	}),
	zodOutput: z.object({
		ok: z.literal(true),
		now: z.number(),
		entries: z.array(transcriptEntry),
	}),
}

export const scribeTools: ToolDef[] = [scribeSay, scribeTranscript]
