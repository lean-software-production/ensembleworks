import { useSync } from '@tldraw/sync'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	DefaultColorStyle,
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getDefaultUserPresence,
	getUserPreferences,
	react,
	setUserPreferences,
	type TLShapeId,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { computeStamp, type StampRecord } from '@ensembleworks/contracts'
import { assetStore } from './assetStore'
import { FramesDrawer } from './chrome/FramesDrawer'
import { presentingAtom } from './chrome/present'
import { getSettings, updateSettings } from './chrome/settings'
import { SidePanel } from './chrome/SidePanel'
import { hexForColor } from './colors'
import { fetchAccessGithubIdentity, resolveGithubLogin } from './githubIdentity'
import { presentStore } from './file-viewer/presentStore'
import { configureConnectionLog, flushConnectionLog, logConnectionEvent } from './av/connectionLog'
import { getFrameId, getIdentity, getRoomId } from './identity'
import { collectIcons, collectShapeUtils } from './kernel/plugin'
import { attachRoomHooks } from './kernel/roomHooks'
import { plugins } from './plugins'
import { components, uiOverrides } from './ui'

// Feature composition is registry-driven: every shape util, toolbar icon,
// overlay and room hook comes from the plugin list, in registry order.
// Module-level so the references stay stable across renders (the asset-url
// and shape-util props must not churn).
const customShapeUtils = collectShapeUtils(plugins)
const assetUrls = { icons: collectIcons(plugins) }

// One-time flag so we seed the color scheme only once per user. v2: the
// Wellmaintained paper-light theme replaced the original dark seed, so
// everyone gets re-seeded once onto paper.
const COLOR_SCHEME_SEEDED_KEY = 'ensembleworks.colorSchemeSeeded.v2'

const identity = getIdentity()
const roomId = getRoomId()

// One reactive shape-record query per store, cached so getUserPresence
// subscribes only to shape changes (and, via getDefaultUserPresence, our own
// cursor/camera/page) — never to other peers' presence churn — and so we
// don't allocate a fresh query on every recompute. computeStamp's parent walk
// only ever looks up shape parents, so shapes alone are sufficient.
let shapeQuery: { get: () => unknown[] } | null = null
let shapeQueryStore: unknown = null

// Keep tldraw presence, the sync connection and LiveKit on one stable ID.
setUserPreferences({
	...getUserPreferences(),
	id: identity.id,
	name: identity.name,
	color: hexForColor(identity.colorKey, false),
})

function wsBase(): string {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws'
	return `${proto}://${location.host}`
}

export function App() {
	const [wasKicked, setWasKicked] = useState(false)
	const [editor, setEditor] = useState<Editor | null>(null)
	const store = useSync({
		uri: `${wsBase()}/sync/${roomId}?userId=${encodeURIComponent(identity.id)}`,
		assets: assetStore,
		shapeUtils: useMemo(() => [...defaultShapeUtils, ...customShapeUtils], []),
		bindingUtils: useMemo(() => [...defaultBindingUtils], []),
		onCustomMessageReceived(message) {
			if (message?.type === 'kicked') setWasKicked(true)
		},
		// Publish the client-computed spatial stamp (contracts/src/stamp.ts)
		// on our presence record so the server just reads a field (transcript
		// stamping, proximity-ordered reads). Reactive: recomputes when our own
		// selection/cursor/camera/page change or when any shape changes — scoped
		// to shape records (see shapeQuery above) so other peers' cursor movement
		// doesn't trigger it. Also publishes `presenting` (chrome/present.ts,
		// spec §5 "Present"): reading presentingAtom inside this reactive
		// derivation means flipping the atom republishes presence too — same
		// mechanism as the stamp's reactive inputs, just a second one. Riding
		// this existing channel means Present needs no server changes.
		getUserPresence(store, user) {
			const defaults = getDefaultUserPresence(store, user)
			if (!defaults) return null
			// Rebuild the cached query only if the store instance changed (remount).
			if (shapeQueryStore !== store) {
				shapeQueryStore = store
				shapeQuery = store.query.records('shape')
			}
			const stamp = computeStamp(shapeQuery!.get() as unknown as StampRecord[], {
				currentPageId: defaults.currentPageId,
				cursor: defaults.cursor,
				camera: defaults.camera ?? null,
				screenBounds: defaults.screenBounds ?? null,
				selectedShapeIds: defaults.selectedShapeIds,
			})
			// Merge two presenter tokens next to the spatial stamp — both ride
			// this presence blob so neither needs server changes:
			//   fileViewerPresent (file-viewer/presentStore): shapeId + scroll
			//     fraction the file-viewer follow uses. Null when not presenting
			//     (a valid JsonValue — followers treat "no token" and "null
			//     token" alike).
			//   presenting (chrome/present.ts, canvas-controls spec §5): a bare
			//     boolean for the canvas Present mode's viewer-follow.
			// Both read tldraw atoms inside this reactive derivation, so flipping
			// either (or scrolling while idle) re-emits presence — same tracking
			// mechanism as the stamp's inputs.
			return {
				...defaults,
				meta: { stamp, fileViewerPresent: presentStore.get(), presenting: presentingAtom.get() },
			}
		},
	})

	// Connection telemetry (spec §2): configure the beacon once, flush on the way
	// out (the last events are usually the interesting ones), and log every tldraw
	// sync status transition — online/offline mark the moments remote presence is
	// wiped ("everyone vanished"). Pairs with the LiveKit events in useLiveKitRoom.
	useEffect(() => {
		configureConnectionLog({ roomId, userId: identity.id })
		const onHide = () => flushConnectionLog()
		window.addEventListener('pagehide', onHide)
		return () => window.removeEventListener('pagehide', onHide)
	}, [])

	// Auto-fill the GitHub avatar handle from the Cloudflare Access identity —
	// the first slice of the GitHub-keyed identity design (Milestone A, the
	// id→login lookup it lists under future polish). Only behind Access:
	// get-identity 404s off it (local dev / Codespaces) → no-op. Only fills when
	// the field is empty, so a manual value (or a prior auto-fill) always wins.
	// Fire-and-forget and bounded, so it never blocks canvas load. Writing
	// settings.githubHandle re-renders the tile (useSettings), so the avatar
	// lights up on its own — no other wiring needed.
	useEffect(() => {
		if (getSettings().githubHandle) return
		let cancelled = false
		void (async () => {
			const gh = await fetchAccessGithubIdentity()
			if (cancelled || !gh) return
			const login = await resolveGithubLogin(gh.numericId)
			if (cancelled || !login) return
			// Re-check: the user may have typed a handle during the async gap.
			if (!getSettings().githubHandle) updateSettings({ githubHandle: login })
		})()
		return () => {
			cancelled = true
		}
	}, [])

	const syncStatus = store.status === 'synced-remote' ? store.connectionStatus : store.status
	const lastSyncStatus = useRef<string | null>(null)
	useEffect(() => {
		if (syncStatus === lastSyncStatus.current) return
		lastSyncStatus.current = syncStatus
		logConnectionEvent('sync', String(syncStatus))
	}, [syncStatus])

	// Deep-link (frameLink spec): with `?frame=<shapeId>` in the URL, zoom the
	// camera to that frame exactly once. The shape may not have synced in yet, so
	// watch reactively — getShapePageBounds returns undefined until it hydrates,
	// so it doubles as the "has it arrived?" check — then zoom and stop. Plain
	// zoomToBounds (not enterFocus): a link recipient must not be trapped behind
	// a camera lock + matte.
	const didDeepLink = useRef(false)
	useEffect(() => {
		if (!editor || didDeepLink.current) return
		const frameId = getFrameId()
		if (!frameId) return
		// Assumes the target frame is on the current page (rooms are single-page today);
		// a cross-page target would zoom the current page to empty space.
		const dispose = react('deep-link frame', () => {
			if (didDeepLink.current) return
			const bounds = editor.getShapePageBounds(frameId as TLShapeId)
			if (!bounds) return
			didDeepLink.current = true
			editor.zoomToBounds(bounds, { inset: 16, animation: { duration: 220 } })
		})
		return dispose
	}, [editor])

	const handleMount = useMemo(
		() => (editor: Editor) => {
			// Debug/e2e hook: headless probes (docs/headless-browser.md) drive
			// the canvas through this. Harmless in production.
			;(window as unknown as { __ewEditor?: Editor }).__ewEditor = editor
			// Flows the Editor instance to the App-level side panel, which lives
			// outside tldraw's React context (plan: split layout, Task 2).
			setEditor(editor)
			// Default users to the paper-light canvas, but only once: tldraw
			// persists colorScheme in its own localStorage, so afterwards we leave
			// whatever the user chose via Preferences → Color scheme alone.
			if (!localStorage.getItem(COLOR_SCHEME_SEEDED_KEY)) {
				editor.user.updateUserPreferences({ colorScheme: 'light' })
				localStorage.setItem(COLOR_SCHEME_SEEDED_KEY, '1')
			}
			// Hex is derived from the theme as settled at mount time; a later
			// Preferences → Color scheme toggle won't re-tint the cursor until
			// the next reload or colour pick.
			const isDark = editor.user.getIsDarkMode()
			editor.user.updateUserPreferences({
				name: identity.name,
				color: hexForColor(identity.colorKey, isDark),
			})
			// New stickies/geo/draw/text the user creates start in their colour.
			// It's a default, not a lock — tldraw's style panel still overrides
			// per shape. Re-applied when they change colour (AvOverlay picker).
			editor.setStyleForNextShapes(DefaultColorStyle, identity.colorKey)

			// Feature room hooks (the terminal delete-veto, the screenshare
			// after-delete) come from the plugin registry. React StrictMode
			// mounts twice — the returned cleanup keeps hooks from doubling up.
			return attachRoomHooks(editor, plugins)
		},
		[]
	)

	return (
		<div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
			<div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
				<Tldraw
					store={store}
					onMount={handleMount}
					deepLinks
					assetUrls={assetUrls}
					shapeUtils={customShapeUtils}
					overrides={uiOverrides}
					components={components}
				>
					{plugins.map((plugin) => {
						const Overlay = plugin.Overlay
						return Overlay ? <Overlay key={plugin.id} /> : null
					})}
				</Tldraw>
			</div>
			{editor && <SidePanel editor={editor} />}
			{/* Frames drawer flies out to the LEFT of the side panel; an App-level
			    sibling so it can anchor to the panel's live width (see FramesDrawer). */}
			{editor && <FramesDrawer editor={editor} />}
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
