/**
 * Store-scoped canvas migrations (spec:
 * 2026-08-05-web-viewer-unification-design.md): retype `file-viewer` shapes
 * to `web-viewer` (adding the source discriminator, kind defaulting to
 * 'file'), and convert retired `iframe` shapes into plain text shapes whose
 * text is the URL, link-formatted. Registered on BOTH sides — the server's
 * createTLSchema and the client's useSync — so snapshots and live stores
 * migrate identically.
 */
import { createMigrationSequence } from '@tldraw/store'

/** Minimal tiptap-JSON doc: one paragraph, one link-marked text node. */
function urlRichText(url: string) {
	return {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', class: null } }] },
				],
			},
		],
	}
}

export const webViewerMigrations = createMigrationSequence({
	sequenceId: 'com.ensembleworks.web-viewer',
	retroactive: true,
	sequence: [
		{
			id: 'com.ensembleworks.web-viewer/1',
			scope: 'store',
			up(store: Record<string, any>) {
				for (const [id, rec] of Object.entries(store)) {
					if (!rec || rec.typeName !== 'shape') continue
					if (rec.type === 'file-viewer') {
						rec.type = 'web-viewer'
						rec.props = { ...rec.props, kind: 'file' }
					} else if (rec.type === 'iframe') {
						const { w, url, title } = rec.props ?? {}
						store[id] = {
							typeName: 'shape',
							id: rec.id,
							type: 'text',
							x: rec.x,
							y: rec.y,
							rotation: rec.rotation ?? 0,
							index: rec.index,
							parentId: rec.parentId,
							isLocked: rec.isLocked ?? false,
							opacity: rec.opacity ?? 1,
							meta: rec.meta ?? {},
							props: {
								color: 'black',
								size: 'm',
								font: 'draw',
								textAlign: 'start',
								w: typeof w === 'number' ? w : 400,
								richText: urlRichText(typeof url === 'string' ? url : String(title ?? '')),
								scale: 1,
								autoSize: false,
							},
						}
					}
				}
			},
		},
	],
})
