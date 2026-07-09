export interface CreateStickyInput {
	room: string
	text: string
	frame?: string // fuzzy frame name (server-side substring match), optional
	color?: string
	author?: string
}

export class SyncServerClient {
	constructor(private base: string) {}

	async createSticky(input: CreateStickyInput): Promise<string> {
		// Inbound writes go to the sync server over loopback (SYNC_BASE defaults to
		// 127.0.0.1, both dev and prod). Same box, so no auth header today — the
		// sticky lands as an anonymous caller and the Discord author rides in the
		// `author` field. Proper internal-service auth over loopback (a scoped
		// identity that still lets terminal agents use the CLI) is tracked as its
		// own piece of work — see issue #24.
		const res = await fetch(`${this.base}/api/canvas/sticky`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		})
		if (!res.ok) {
			throw new Error(`createSticky failed: ${res.status} ${await res.text()}`)
		}
		const body = (await res.json()) as { ok?: boolean; id?: string }
		if (!body.id) throw new Error('createSticky: response missing id')
		return body.id
	}
}
