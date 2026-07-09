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
		const res = await fetch(`${this.base}/api/canvas/sticky`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...this.authHeaders() },
			body: JSON.stringify(input),
		})
		if (!res.ok) {
			throw new Error(`createSticky failed: ${res.status} ${await res.text()}`)
		}
		const body = (await res.json()) as { ok?: boolean; id?: string }
		if (!body.id) throw new Error('createSticky: response missing id')
		return body.id
	}

	// In prod the bot authenticates to the sync server with a Cloudflare Access
	// service-token pair (the established bot→server pattern). In dev/test these
	// env vars are absent and the call is a plain loopback POST.
	private authHeaders(): Record<string, string> {
		const id = process.env.CF_ACCESS_CLIENT_ID
		const secret = process.env.CF_ACCESS_CLIENT_SECRET
		return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {}
	}
}
