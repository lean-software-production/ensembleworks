import type { Embed } from './adapter.ts'

export type OutboundPayload =
	| { kind: 'summary'; room: string; data: { text: string } }
	| { kind: 'action-items'; room: string; data: { items: { text: string; owner?: string }[] } }
	| { kind: 'decision'; room: string; data: { text: string } }
	| { kind: 'frame-link'; room: string; data: { title: string; url: string } }

export function formatPayload(payload: OutboundPayload): Embed {
	switch (payload.kind) {
		case 'summary':
			return { title: `Session summary — ${payload.room}`, description: payload.data.text }
		case 'decision':
			return { title: `Decision — ${payload.room}`, description: payload.data.text }
		case 'action-items':
			return {
				title: `Action items — ${payload.room}`,
				description: payload.data.items
					.map((it) => `- [ ] ${it.text}${it.owner ? ` (@${it.owner})` : ''}`)
					.join('\n'),
			}
		case 'frame-link':
			return { title: payload.data.title, url: payload.data.url, description: `Open in ${payload.room}` }
	}
}
