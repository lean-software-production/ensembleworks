/**
 * Seeds the augmented-session canvas: per crew a drafting frame with Min
 * Specs template stickies, a launch pad, an agent terminal, a preview
 * iframe, an advice bench with a reviewer-agent prompt, a painted ring and
 * a client parking spot — plus shared Brief Lessons / 25/10 frames and the
 * far-off pair huddles. All geometry comes from computeSessionLayout.
 */
import { Editor, createShapeId, toRichText } from 'tldraw'
import { computeSessionLayout } from './layout'

const REVIEWER_PROMPT =
	'Reviewer agent (Wise Crowds):\n' +
	'You are a consultant reviewing this crew’s work in progress.\n' +
	'1. Read the drafting frame and the latest output.\n' +
	'2. Ask one clarifying question.\n' +
	'3. Offer advice as stickies in the Advice frame — the crew is free to ignore it.'

export function seedSessionCanvas(editor: Editor) {
	const center = editor.getViewportPageBounds().center
	const layout = computeSessionLayout({ crews: 3, center })

	editor.run(() => {
		editor.createShape({
			type: 'text',
			x: center.x - 600,
			y: center.y - 2700,
			props: {
				richText: toRichText('Augmented session — crews, benches & huddles'),
				size: 'xl',
				font: 'draw',
			},
		})

		for (const zone of layout.crews) {
			// Painted ring: dashed ellipse marking the full-volume huddle radius.
			editor.createShape({
				type: 'geo',
				x: zone.center.x - zone.ringRadius,
				y: zone.center.y - zone.ringRadius,
				props: {
					w: 2 * zone.ringRadius,
					h: 2 * zone.ringRadius,
					geo: 'ellipse',
					dash: 'dashed',
					fill: 'none',
				},
			})

			// Drafting table: Min Specs template stickies.
			const draftingFrame = createShapeId()
			editor.createShape({
				id: draftingFrame,
				type: 'frame',
				x: zone.draftingTable.x,
				y: zone.draftingTable.y,
				props: { w: 600, h: 700, name: `Drafting — ${zone.name} (Min Specs)` },
			})
			const stickies: Array<{ x: number; y: number; text: string; color: string }> = [
				{ x: 40, y: 60, text: 'must: …', color: 'green' },
				{ x: 40, y: 280, text: 'must: …', color: 'green' },
				{ x: 320, y: 60, text: 'must-not: …', color: 'red' },
				{ x: 320, y: 280, text: 'must-not: …', color: 'red' },
			]
			for (const note of stickies) {
				editor.createShape({
					type: 'note',
					parentId: draftingFrame,
					x: note.x,
					y: note.y,
					props: { richText: toRichText(note.text), color: note.color as any },
				})
			}

			// Launch pad: where the crew assembles the prompt to send.
			editor.createShape({
				type: 'frame',
				x: zone.launchPad.x,
				y: zone.launchPad.y,
				props: { w: 600, h: 280, name: `Launch pad — ${zone.name}` },
			})

			// Agent terminal — off-screen from the drafting table at working zoom.
			editor.createShape({
				type: 'terminal',
				x: zone.terminal.x,
				y: zone.terminal.y,
				props: {
					w: 600,
					h: 380,
					sessionId: zone.name,
					title: `${zone.name} — agent terminal`,
				},
			})

			// Bench: live preview of the app under construction.
			editor.createShape({
				type: 'iframe',
				x: zone.benchPreview.x,
				y: zone.benchPreview.y,
				props: { w: 600, h: 420, url: '/dev/3000/', title: `${zone.name} preview (port 3000)` },
			})

			// Bench: advice frame for reviewer stickies.
			editor.createShape({
				type: 'frame',
				x: zone.benchAdvice.x,
				y: zone.benchAdvice.y,
				props: { w: 520, h: 420, name: `Advice — ${zone.name}` },
			})

			// Reviewer-agent prompt template, parked next to the advice frame.
			editor.createShape({
				type: 'text',
				x: zone.benchAdvice.x,
				y: zone.benchAdvice.y + 460,
				props: { richText: toRichText(REVIEWER_PROMPT), size: 's', font: 'draw' },
			})

			// Client parking spot, just outside the painted ring.
			editor.createShape({
				type: 'text',
				x: zone.parkingSpot.x - 140,
				y: zone.parkingSpot.y - 20,
				props: { richText: toRichText('⊗ client parks here'), size: 'm', font: 'draw' },
			})
		}

		// Shared frames in the middle of the room.
		editor.createShape({
			type: 'frame',
			x: layout.briefLessons.x,
			y: layout.briefLessons.y,
			props: { w: 700, h: 500, name: 'Brief lessons' },
		})
		editor.createShape({
			type: 'frame',
			x: layout.ranking.x,
			y: layout.ranking.y,
			props: { w: 700, h: 460, name: '25/10 ranking' },
		})

		// Pair huddles: far enough away that spatial audio makes them private.
		layout.pairHuddles.forEach((huddle, i) => {
			editor.createShape({
				type: 'frame',
				x: huddle.x - 350,
				y: huddle.y - 250,
				props: { w: 700, h: 500, name: `Pair huddle ${i + 1}` },
			})
		})
	})

	editor.zoomToFit({ animation: { duration: 400 } })
}
