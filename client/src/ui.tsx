/**
 * UI customisation: a "New terminal" toolbar button that drops a terminal
 * shape (backed by a fresh tmux session) at the viewport centre.
 */
import {
	DefaultMainMenu,
	DefaultMainMenuContent,
	DefaultToolbar,
	DefaultToolbarContent,
	Editor,
	TLComponents,
	TLUiOverrides,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	createShapeId,
	useEditor,
	useTools,
} from 'tldraw'
import { AvOverlay } from './av/AvOverlay'
import { seedDemoCanvas } from './demo'
import { seedSessionCanvas } from './session/seedSessionCanvas'
import { toProxiedUrl } from './iframe/IframeShapeUtil'
import { NEKO_DEFAULT_BASE, NEKO_DEFAULT_H, NEKO_DEFAULT_W, NEKO_ICON_NAME } from './neko/NekoShapeUtil'

export function createTerminalShape(editor: Editor) {
	// Short, human-typeable ID — it is also the tmux session name suffix, so
	// `ssh vm` + `tmux attach -t canvas-<id>` works.
	const sessionId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'terminal',
		x: x - 360,
		y: y - 220,
		props: { w: 720, h: 440, sessionId, title: 'terminal' },
	})
	editor.setSelectedShapes([id])
}

export function createDevServerShape(editor: Editor) {
	const input = window.prompt('Dev server port (or full URL):', '3000')?.trim()
	if (!input) return
	const url = /^\d+$/.test(input) ? `/dev/${input}/` : toProxiedUrl(input)
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'iframe',
		x: x - 400,
		y: y - 300,
		props: { w: 800, h: 600, url, title: `dev server ${input}` },
	})
	editor.setSelectedShapes([id])
}

export function createNekoShape(editor: Editor) {
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'neko',
		x: x - NEKO_DEFAULT_W / 2,
		y: y - NEKO_DEFAULT_H / 2,
		props: { w: NEKO_DEFAULT_W, h: NEKO_DEFAULT_H, base: NEKO_DEFAULT_BASE, title: 'shared browser' },
	})
	editor.setSelectedShapes([id])
}

export const uiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		tools['terminal'] = {
			id: 'terminal',
			icon: 'tool-frame',
			label: 'New terminal',
			readonlyOk: false,
			onSelect() {
				createTerminalShape(editor)
			},
		}
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
		return tools
	},
}

function ToolbarWithTerminal() {
	const tools = useTools()
	return (
		<DefaultToolbar>
			<DefaultToolbarContent />
			{tools['terminal'] && <TldrawUiMenuItem {...tools['terminal']} />}
			{tools['dev-server'] && <TldrawUiMenuItem {...tools['dev-server']} />}
			{tools['neko'] && <TldrawUiMenuItem {...tools['neko']} />}
		</DefaultToolbar>
	)
}

function MainMenuWithDemo() {
	const editor = useEditor()
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
					label="About: augmented sessions"
					icon="external-link"
					onSelect={() => {
						window.open('/about.html', '_blank')
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
