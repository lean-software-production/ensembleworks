/**
 * Pasting/dropping a URL that points at the VM (http://localhost:3000, …)
 * auto-converts it into an iframe shape served through the Caddy dev proxy,
 * so "paste your dev server" is the whole workflow. Every other URL keeps
 * tldraw's default behaviour (bookmark/embed).
 *
 * Rendered as a child of <Tldraw> so it can use the UI hooks the default
 * handler needs.
 */
import { useEffect } from 'react'
import {
	createShapeId,
	defaultHandleExternalUrlContent,
	useEditor,
	useToasts,
	useTranslation,
} from 'tldraw'
import { toProxiedUrl } from './IframeShapeUtil'

export function PasteUrlHandler() {
	const editor = useEditor()
	const toasts = useToasts()
	const msg = useTranslation()

	useEffect(() => {
		editor.registerExternalContentHandler('url', async (info) => {
			// A paste/drop aimed at a focused widget (e.g. typing a localhost URL
			// into a terminal) must not be hijacked into a dev iframe — only the
			// bare-canvas paste should. The terminal also consumes Ctrl/Cmd+V at the
			// keystroke level; this is the belt-and-braces for drop/other paths.
			if (editor.getEditingShapeId()) return
			const proxied = toProxiedUrl(info.url)
			if (proxied !== info.url) {
				const point = info.point ?? editor.getViewportPageBounds().center
				const id = createShapeId()
				editor.createShape({
					id,
					type: 'iframe',
					x: point.x - 400,
					y: point.y - 300,
					props: { w: 800, h: 600, url: proxied, title: `dev ${info.url}` },
				})
				editor.setSelectedShapes([id])
				return
			}
			await defaultHandleExternalUrlContent(editor, info, { toasts, msg })
		})
	}, [editor, toasts, msg])

	return null
}
