/**
 * Extract the presenter (if any) of a given shape from collaborator presence.
 * When several peers carry a token for the shape (presence tokens can't be
 * cleared across users), the LATEST toggle wins: largest `ts` — true
 * last-writer-wins per spec §5. Missing/non-numeric ts counts as 0.
 */
export interface PresenceLike {
	userId: string
	userName: string
	meta?: unknown
}

export interface PresenterInfo {
	userId: string
	userName: string
	fraction: number
}

export function presenterFor(peers: readonly PresenceLike[], shapeId: string): PresenterInfo | null {
	let best: PresenterInfo | null = null
	let bestTs = -1
	for (const p of peers) {
		const m = (
			p.meta as { fileViewerPresent?: { shapeId?: unknown; fraction?: unknown; ts?: unknown } } | undefined
		)?.fileViewerPresent
		if (!m || m.shapeId !== shapeId || typeof m.fraction !== 'number') continue
		const ts = typeof m.ts === 'number' ? m.ts : 0
		if (ts > bestTs) {
			bestTs = ts
			best = { userId: p.userId, userName: p.userName, fraction: m.fraction }
		}
	}
	return best
}
