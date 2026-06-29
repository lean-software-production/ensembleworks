import { useSync } from '@tldraw/sync'
import { useMemo, useState } from 'react'
import {
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getUserPreferences,
	setUserPreferences,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { assetStore } from './assetStore'
import { getIdentity, getRoomId } from './identity'
import { IframeShapeUtil } from './iframe/IframeShapeUtil'
import { PasteUrlHandler } from './iframe/PasteUrlHandler'
import { NEKO_ICON_NAME, NEKO_TOOLBAR_ICON, NekoShapeUtil } from './neko/NekoShapeUtil'
import { TerminalShapeUtil } from './terminal/TerminalShapeUtil'
import { components, uiOverrides } from './ui'

const customShapeUtils = [TerminalShapeUtil, IframeShapeUtil, NekoShapeUtil]

// Register the custom neko toolbar icon (merged with tldraw's built-ins). Stable
// module-level reference so the asset-url memo doesn't churn each render.
const assetUrls = { icons: { [NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON } }

// One-time flag so we seed the color scheme only once per user. v2: the
// Wellmaintained paper-light theme replaced the original dark seed, so
// everyone gets re-seeded once onto paper.
const COLOR_SCHEME_SEEDED_KEY = 'ensembleworks.colorSchemeSeeded.v2'

const identity = getIdentity()
const roomId = getRoomId()

// Keep tldraw presence, the sync connection and LiveKit on one stable ID.
setUserPreferences({
	...getUserPreferences(),
	id: identity.id,
	name: identity.name,
	color: identity.color,
})

function wsBase(): string {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws'
	return `${proto}://${location.host}`
}

export function App() {
	const [wasKicked, setWasKicked] = useState(false)
	const store = useSync({
		uri: `${wsBase()}/sync/${roomId}?userId=${encodeURIComponent(identity.id)}`,
		assets: assetStore,
		shapeUtils: useMemo(() => [...defaultShapeUtils, ...customShapeUtils], []),
		bindingUtils: useMemo(() => [...defaultBindingUtils], []),
		onCustomMessageReceived(message) {
			if (message?.type === 'kicked') setWasKicked(true)
		},
	})

	const handleMount = useMemo(
		() => (editor: Editor) => {
			editor.user.updateUserPreferences({ name: identity.name, color: identity.color })

			// Terminals are easy to delete by accident (one stray Backspace on a
			// selected shape). Veto local deletions unless the user confirms. One
			// dialog covers the whole delete gesture: batch members reach the
			// handler microseconds apart, so a decision is reused (and its window
			// extended) while calls keep arriving within 250ms of the last one —
			// measured from when the dialog closed, since confirm() blocks for
			// however long the user thinks. The tmux session itself survives.
			let decision = false
			let decidedAt = 0
			const unregister = editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
				if (source !== 'user' || shape.type !== 'terminal') return
				const props = shape.props as { title?: string; sessionId?: string }
				if (Date.now() - decidedAt > 250) {
					decision = window.confirm(
						`Delete terminal "${props.title ?? ''}"` +
							` (and any other terminals in this selection)?\n\n` +
							`tmux sessions keep running on the VM — reattach with: ` +
							`tmux attach -t canvas-${props.sessionId ?? '<id>'}`
					)
				}
				decidedAt = Date.now()
				if (!decision) return false
			})
			// Default users to the paper-light canvas, but only once: tldraw
			// persists colorScheme in its own localStorage, so afterwards we leave
			// whatever the user chose via Preferences → Color scheme alone.
			if (!localStorage.getItem(COLOR_SCHEME_SEEDED_KEY)) {
				editor.user.updateUserPreferences({ colorScheme: 'light' })
				localStorage.setItem(COLOR_SCHEME_SEEDED_KEY, '1')
			}

			// React StrictMode mounts twice — without cleanup we'd register two
			// handlers and the user would get two dialogs per delete.
			return unregister
		},
		[]
	)

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw
				store={store}
				onMount={handleMount}
				deepLinks
				assetUrls={assetUrls}
				shapeUtils={customShapeUtils}
				overrides={uiOverrides}
				components={components}
			>
				<PasteUrlHandler />
			</Tldraw>
			{wasKicked && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						display: 'grid',
						placeItems: 'center',
						background: 'rgba(15,23,42,0.35)',
						zIndex: 10000,
					}}
				>
					<div
						style={{
							background: '#fafaf7',
							border: '1px solid rgba(15,23,42,0.22)',
							borderRadius: 4,
							padding: 24,
							boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
							fontFamily: 'system-ui, sans-serif',
							textAlign: 'center',
						}}
					>
						<strong>You were removed from this session.</strong>
						<div style={{ marginTop: 8, fontSize: 13 }}>Reload the page to rejoin.</div>
					</div>
				</div>
			)}
		</div>
	)
}
