/**
 * Outbound "post to Discord" helpers (client milestone E4). A pure body builder
 * kept free of tldraw/DOM so it runs under the logic-only bun test harness, plus
 * a thin fetch wrapper that fires the POST to the server mediator.
 */
import { buildFrameLink } from '../chrome/frameLink'

export interface DiscordPostBody {
	room: string
	kind: 'summary' | 'action-items' | 'decision' | 'frame-link'
	data: Record<string, unknown>
}

// Pure: build the POST body for a frame-link outbound post.
export function buildFrameLinkPost(
	origin: string,
	room: string,
	frameId: string,
	title: string
): DiscordPostBody {
	return { room, kind: 'frame-link', data: { title, url: buildFrameLink(origin, room, frameId) } }
}

// Fire the outbound post; returns the delivered count. Throws on non-ok.
export async function postToDiscord(body: DiscordPostBody): Promise<number> {
	const res = await fetch('/api/discord/post', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`postToDiscord failed: ${res.status}`)
	const json = (await res.json()) as { delivered?: number }
	return json.delivered ?? 0
}
