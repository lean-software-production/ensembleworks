/**
 * Discord plugin (client milestones B3 + E4): two overflow command-bar entries.
 * `discord-bindings` opens the bindings admin dialog; `post-frame-link` posts a
 * deep link to the selected frame out to Discord via the server mediator.
 * Mirrors framelink/plugin.tsx and iframe/plugin.tsx — a plain ClientPlugin
 * whose onSelect handlers use the passed-in editor / helpers.addDialog.
 */
import { getRoomId } from '../identity'
import type { ClientPlugin } from '../kernel/plugin'
import { BindingsPanel } from './BindingsPanel'
import { buildFrameLinkPost, postToDiscord } from './postAction'

export const discordPlugin: ClientPlugin = {
	id: 'discord',
	barItems: [
		{
			id: 'discord-bindings',
			label: 'discord bindings',
			icon: 'external-link',
			placement: 'overflow',
			onSelect: (_editor, helpers) =>
				helpers.addDialog({ id: 'discord-bindings', component: BindingsPanel }),
		},
		// TODO(ergonomics): trigger surface (chip vs widget vs page control) is an
		// open question — see docs/discord-bot-design.md
		{
			id: 'post-frame-link',
			label: 'post frame link to Discord',
			icon: 'share-1',
			placement: 'overflow',
			onSelect: (editor) => {
				const ids = editor.getSelectedShapeIds()
				if (ids.length !== 1) return
				const shape = editor.getShape(ids[0])
				if (!shape || shape.type !== 'frame') return
				const title =
					(typeof (shape.props as { name?: unknown }).name === 'string' &&
						(shape.props as { name?: string }).name!.trim()) ||
					'frame'
				const body = buildFrameLinkPost(location.origin, getRoomId(), shape.id, title)
				postToDiscord(body).catch(() => {})
			},
		},
	],
}
