/**
 * Transcript feature — POST /api/scribe/transcript appends a line (stamped with the
 * speaker's live cursor/frame when present); GET /api/scribe/transcript reads the
 * room's transcript.
 */
import { scribeSay, scribeTranscript } from '@ensembleworks/contracts'
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { getCursorRefs, rawUserId } from '../kernel/presence.ts'

export function createTranscriptRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Transcript (voice → text): the transcriber bot appends one entry per
	// spoken utterance; minutes/map agents poll the tail with ?since=. Each
	// entry is stamped with the speaker's live cursor + nearest frame when a
	// canvas tab is open — the scribe posts the raw LiveKit identity, which
	// equals the tldraw presence userId once its "user:" prefix is stripped.

	router.post(scribeSay.http.path, async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const identity = typeof body.identity === 'string' ? body.identity.slice(0, 128) : ''
		const name = typeof body.name === 'string' && body.name ? body.name.slice(0, 64) : identity
		const text = typeof body.text === 'string' ? body.text.trim() : ''
		const t = typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : undefined
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!identity) return void res.status(400).json({ error: 'identity is required' })
		if (!text || text.length > 4000) {
			return void res.status(400).json({ error: 'text must be non-empty and at most 4000 chars' })
		}

		// Best-effort spatial stamp, computed by the speaker's own browser from
		// its CRDT replica and published as presence.meta.stamp — the server
		// just copies the field (contracts/src/stamp.ts owns the
		// semantics: cursor-inside-frame wins, else viewport centre). No live
		// tab, or a pre-stamp bundle, ⇒ unstamped entry. No server-side
		// geometry fallback by design.
		const room = ctx.rooms.getOrCreateRoom(roomId)
		const want = rawUserId(identity)
		const ref = getCursorRefs(room).find((r) => rawUserId(r.userId) === want) ?? null

		const entry = await ctx.storage.transcripts.append(roomId, {
			identity,
			name,
			text,
			t,
			page: ref?.currentPageId ?? null,
			cursor: ref?.stamp?.at ?? null,
			frame: ref?.stamp?.frame ?? null,
		})
		res.json({ ok: true, entry })
	})

	// GET /api/scribe/transcript?room=&since=&limit= — entries with t > since, oldest
	// first. `now` is the server clock so pollers can chain since=now without
	// trusting their own clock.
	router.get(scribeTranscript.http.path, async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const since = Number(req.query.since ?? 0)
		const limit = Number(req.query.limit ?? 1000)
		if (!Number.isFinite(since) || since < 0) {
			return void res.status(400).json({ error: 'since must be a ms-epoch number' })
		}
		if (!Number.isFinite(limit) || limit < 1) {
			return void res.status(400).json({ error: 'limit must be a positive number' })
		}
		const entries = await ctx.storage.transcripts.read(roomId, { since, limit })
		res.json({ ok: true, now: Date.now(), entries })
	})

	return router
}
