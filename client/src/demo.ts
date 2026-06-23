/**
 * Seeds the demo canvas described in the MVP plan: a terminal running
 * Claude Code, a dev-server terminal, a live iframe of the served app,
 * and a sticky-note retro corner — the layout for the 10-minute team demo.
 */
import { Editor, createShapeId, toRichText } from 'tldraw'

export function seedDemoCanvas(editor: Editor) {
	const center = editor.getViewportPageBounds().center
	const ox = center.x - 900
	const oy = center.y - 500

	editor.run(() => {
		editor.createShape({
			type: 'text',
			x: ox,
			y: oy - 90,
			props: {
				richText: toRichText('EnsembleWorks — team room'),
				size: 'xl',
				font: 'draw',
			},
		})

		// Mob station: Claude Code terminal + dev server terminal.
		editor.createShape({
			type: 'terminal',
			x: ox,
			y: oy,
			props: { w: 760, h: 460, sessionId: 'claude', title: 'claude code (mob here)' },
		})
		editor.createShape({
			type: 'terminal',
			x: ox,
			y: oy + 500,
			props: { w: 760, h: 320, sessionId: 'devserver', title: 'dev server' },
		})

		// Live view of the app the dev server serves, through the Caddy proxy.
		const appFrame = createShapeId()
		editor.createShape({
			id: appFrame,
			type: 'iframe',
			x: ox + 820,
			y: oy + 380,
			props: { w: 720, h: 540, url: '/dev/3000/', title: 'app preview (port 3000)' },
		})
		editor.createShape({
			type: 'arrow',
			x: ox + 770,
			y: oy + 620,
			props: {
				start: { x: 0, y: 0 },
				end: { x: 50, y: 40 },
				richText: toRichText('edit → refresh'),
			},
		})

		// Retro corner: a frame of stickies, deliberately far enough away that
		// spatial audio turns it into a separate huddle.
		const retroFrame = createShapeId()
		editor.createShape({
			id: retroFrame,
			type: 'frame',
			x: ox + 2400,
			y: oy,
			props: { w: 640, h: 520, name: 'Retro corner (second huddle)' },
		})
		const stickies: Array<{ x: number; y: number; text: string; color: string }> = [
			{ x: 40, y: 60, text: 'Went well', color: 'green' },
			{ x: 260, y: 60, text: 'Could improve', color: 'yellow' },
			{ x: 480, y: 60, text: 'Action items', color: 'violet' },
			{ x: 40, y: 280, text: 'add yours →', color: 'light-blue' },
		]
		for (const note of stickies) {
			editor.createShape({
				type: 'note',
				parentId: retroFrame,
				x: note.x,
				y: note.y,
				props: { richText: toRichText(note.text), color: note.color as any },
			})
		}

		editor.createShape({
			type: 'text',
			x: ox + 820,
			y: oy,
			props: {
				richText: toRichText(
					'How to drive:\n• double-click a terminal to type, Esc Esc to leave\n• paste http://localhost:<port> to embed a dev server\n• drag yourself near a huddle to hear it'
				),
				size: 'm',
				font: 'draw',
			},
		})
	})

	editor.zoomToFit({ animation: { duration: 400 } })
}
