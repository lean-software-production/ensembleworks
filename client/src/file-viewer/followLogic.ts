/** Extract the presenter (if any) of a given shape from collaborator presence. */
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
	for (const p of peers) {
		const m = (p.meta as { fileViewerPresent?: { shapeId?: unknown; fraction?: unknown } } | undefined)
			?.fileViewerPresent
		if (!m || m.shapeId !== shapeId || typeof m.fraction !== 'number') continue
		return { userId: p.userId, userName: p.userName, fraction: m.fraction }
	}
	return null
}
