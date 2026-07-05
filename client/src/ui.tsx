/**
 * UI customisation: a "New terminal" toolbar button that drops a terminal
 * shape (backed by a fresh tmux session) at the viewport centre.
 */
import {
	DefaultMainMenu,
	DefaultMainMenuContent,
	DefaultToolbar,
	DefaultToolbarContent,
	TLComponents,
	TLUiOverrides,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	useDialogs,
	useEditor,
	useTools,
} from 'tldraw'
import { TerminalToolbarItem } from './terminal/TerminalToolbarItem'
import { AvOverlay } from './av/AvOverlay'
import { SCREENSHARE_ICON_NAME } from './screenshare/ScreenShareShapeUtil'
import { startScreenShare } from './screenshare/share'
import { useScreenShareAvailable } from './screenshare/store'
import { seedDemoCanvas } from './demo/seedDemoCanvas'
import { seedSessionCanvas } from './session/seedSessionCanvas'
import { createDevServerShape } from './iframe/createDevServerShape'
import { createNekoShape } from './neko/createNekoShape'
import { createRoadmapShape } from './roadmap/createRoadmapShape'
import { NEKO_ICON_NAME } from './neko/NekoShapeUtil'

export const uiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		tools['dev-server'] = {
			id: 'dev-server',
			icon: 'tool-embed',
			label: 'Embed dev server',
			readonlyOk: false,
			onSelect() {
				createDevServerShape(editor)
			},
		}
		tools['neko'] = {
			id: 'neko',
			icon: NEKO_ICON_NAME,
			label: 'New shared browser',
			readonlyOk: false,
			onSelect() {
				createNekoShape(editor)
			},
		}
		tools['roadmap'] = {
			id: 'roadmap',
			icon: 'tool-note',
			label: 'New roadmap',
			readonlyOk: false,
			onSelect() {
				createRoadmapShape(editor)
			},
		}
		tools['screenshare'] = {
			id: 'screenshare',
			icon: SCREENSHARE_ICON_NAME,
			label: 'Share screen',
			readonlyOk: false,
			onSelect() {
				void startScreenShare(editor)
			},
		}
		return tools
	},
}

function ToolbarWithTerminal() {
	const tools = useTools()
	const screenShareAvailable = useScreenShareAvailable()
	return (
		<DefaultToolbar>
			<DefaultToolbarContent />
			<TerminalToolbarItem />
			{tools['dev-server'] && <TldrawUiMenuItem {...tools['dev-server']} />}
			{tools['neko'] && <TldrawUiMenuItem {...tools['neko']} />}
			{tools['roadmap'] && <TldrawUiMenuItem {...tools['roadmap']} />}
			{screenShareAvailable && tools['screenshare'] && (
				<TldrawUiMenuItem {...tools['screenshare']} />
			)}
		</DefaultToolbar>
	)
}

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

function MainMenuWithDemo() {
	const editor = useEditor()
	const { addDialog } = useDialogs()
	return (
		<DefaultMainMenu>
			<DefaultMainMenuContent />
			<TldrawUiMenuGroup id="ensembleworks-demo">
				<TldrawUiMenuItem
					id="seed-demo"
					label="Seed demo layout"
					icon="duplicate"
					onSelect={() => seedDemoCanvas(editor)}
				/>
				<TldrawUiMenuItem
					id="seed-session"
					label="Seed session layout"
					icon="duplicate"
					onSelect={() => {
						seedSessionCanvas(editor)
					}}
				/>
				<TldrawUiMenuItem
					id="about-sessions"
					label="About"
					icon="info-circle"
					onSelect={() => {
						addDialog({ component: AboutDialog })
					}}
				/>
			</TldrawUiMenuGroup>
		</DefaultMainMenu>
	)
}

export const components: TLComponents = {
	Toolbar: ToolbarWithTerminal,
	MainMenu: MainMenuWithDemo,
	SharePanel: AvOverlay,
}
