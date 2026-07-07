/**
 * Kernel UI assembly (canvas-controls spec §4/§6/§8): the EnsembleWorks
 * command bar claims tldraw's Toolbar slot, the style panel goes contextual
 * via InFrontOfTheCanvas, and navigation/menu/pages chrome is suppressed —
 * the side panel (chrome/SidePanel.tsx) owns page navigation now (spec §3,
 * Phase 2 cutover). Plugin-owned component slots (the A/V overlay claims
 * SharePanel) merge in from the registry.
 */
import { TLComponents, TLUiOverrides } from 'tldraw'
import { CommandBar } from './chrome/CommandBar'
import { ContextualStylePanel } from './chrome/ContextualStylePanel'
import { collectUiSlots } from './kernel/plugin'
import { plugins } from './plugins'

export const uiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		// S aliases V for select, so the bar's underlined accelerator ("s̲elect")
		// works without breaking tldraw muscle memory (spec §4).
		if (tools.select) tools.select = { ...tools.select, kbd: 'v,s' }
		// No plugin currently contributes a `tools` factory (barItems only model
		// one-shot actions) — kept as the deliberate extension point for future
		// armed/stateful tools.
		for (const plugin of plugins) {
			if (plugin.tools) Object.assign(tools, plugin.tools(editor))
		}
		return tools
	},
}

export const components: TLComponents = {
	Toolbar: CommandBar,
	StylePanel: null,
	MenuPanel: null,
	NavigationPanel: null,
	InFrontOfTheCanvas: ContextualStylePanel,
	...collectUiSlots(plugins),
}
