/**
 * Discord plugin (client milestone B3): one overflow command-bar entry that
 * opens the bindings admin dialog. Mirrors framelink/plugin.tsx and
 * iframe/plugin.tsx — a plain ClientPlugin with a single barItems entry whose
 * onSelect opens a tldraw dialog via the passed-in helpers.addDialog.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { BindingsPanel } from './BindingsPanel'

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
	],
}
