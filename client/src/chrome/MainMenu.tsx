/**
 * The EnsembleWorks main menu (☰) and its About dialog, rendered inside the
 * command bar (canvas-controls spec §4).
 */
import {
	DefaultMainMenu,
	DefaultMainMenuContent,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	useDialogs,
} from 'tldraw'
import { plugins } from '../plugins'

function AboutDialog(_props: { onClose: () => void }) {
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>EnsembleWorks</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ maxWidth: 420 }}>
				<p style={{ margin: '0 0 12px' }}>Multi-player Agentic Workspace for Teams</p>
				<p style={{ margin: 0, opacity: 0.7 }}>
					Version <code>{__APP_VERSION__}</code>
				</p>
			</TldrawUiDialogBody>
		</>
	)
}

function AboutMenuItem() {
	const { addDialog } = useDialogs()
	return (
		<TldrawUiMenuItem
			id="about-sessions"
			label="About"
			icon="info-circle"
			onSelect={() => {
				addDialog({ component: AboutDialog })
			}}
		/>
	)
}

export function EnsembleMainMenu() {
	return (
		<DefaultMainMenu>
			<DefaultMainMenuContent />
			<TldrawUiMenuGroup id="ensembleworks-demo">
				{plugins.map((plugin) => {
					const Items = plugin.MenuItems
					return Items ? <Items key={plugin.id} /> : null
				})}
				<AboutMenuItem />
			</TldrawUiMenuGroup>
		</DefaultMainMenu>
	)
}
