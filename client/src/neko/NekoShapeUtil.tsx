/**
 * A shared browser on the canvas, backed by a neko container on the VM (a real
 * Firefox on a virtual display, streamed over WebRTC with multiplayer control —
 * see docs/neko-poc-plan.md). Deliberately its OWN shape, not a flavour of the
 * generic iframe shape: neko brings its own auth, per-viewer identity, control
 * model and (soon) resize semantics, and keeping it isolated means the whole
 * feature can be enabled/disabled/reworked without touching anything else.
 *
 * Like the iframe shape, position + size are shared via tldraw sync while the
 * stream itself is per-user — but the loaded URL is personalised so each
 * teammate auto-joins under their own canvas identity (see buildNekoSrc).
 */
import { nekoShapeProps } from '@ensembleworks/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	stopEventPropagation,
	useEditor,
	useValue,
} from 'tldraw'
import { peekIdentity } from '../identity'
import { wm } from '../theme'

// The neko instance, served same-origin through Caddy's dedicated /shared-browser
// route (-> loopback :8090; see deploy/Caddyfile + ensembleworks-shared-browser
// .service). One shared browser for the whole room (singleton).
export const NEKO_DEFAULT_BASE = '/shared-browser/'
// Regular-member password (control hand-off, not admin). Rides in the per-viewer
// URL — acceptable on the tailnet where membership is the real auth boundary.
export const NEKO_USER_PASSWORD = 'neko'

// Toolbar icon: a browser-window glyph (line-art, echoing the shape's own header
// bar) registered as a custom tldraw icon. tldraw renders icons as a CSS mask, so
// this is a single-colour silhouette auto-tinted by the toolbar — supplied inline
// as a data URI (no asset file, no build step). Registered via <Tldraw assetUrls>
// in App.tsx and referenced by NEKO_ICON_NAME on the tool in ui.tsx.
export const NEKO_ICON_NAME = 'neko-browser'
const NEKO_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">' +
	'<rect x="3" y="5" width="18" height="14" rx="2.5"/>' +
	'<line x1="3" y1="9" x2="21" y2="9"/>' +
	'<circle cx="6.2" cy="7" r="1" fill="black" stroke="none"/>' +
	'<circle cx="9.2" cy="7" r="1" fill="black" stroke="none"/>' +
	'<circle cx="12.2" cy="7" r="1" fill="black" stroke="none"/></svg>'
export const NEKO_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(NEKO_ICON_SVG)}`

/**
 * Compose the per-viewer neko URL from the shared base + this user's name:
 *   - usr/pwd → the neko client auto-logs-in (no login box) under their name
 *   - embed=1 → bare, chrome-free, still-interactive stream (hides the menu)
 * Pure + location-free so it unit-tests in node; the name is percent-encoded.
 * Stream audio is muted by default (autoplay policy) and toggled via the header
 * button; the chat.mp3 notification is silenced separately (see SilentAudio).
 */
export function buildNekoSrc(base: string, viewerName: string): string {
	const q = `usr=${encodeURIComponent(viewerName)}&pwd=${encodeURIComponent(NEKO_USER_PASSWORD)}&embed=1`
	return base.includes('?') ? `${base}&${q}` : `${base}?${q}`
}

/**
 * neko shows its branded login window (the "n.eko" logo) while auto-login + the
 * WebRTC stream come up. The iframe is same-origin (served under /dev/8090/ with
 * allow-same-origin), so we inject this into its document to suppress that splash
 * — leaving a clean black→stream transition. Auto-login runs in JS regardless of
 * the overlay's visibility, so hiding it changes nothing functional.
 */
export const NEKO_SPLASH_CSS = '.connect{display:none!important}'

/**
 * A no-op stand-in for the iframe's `Audio` constructor. neko plays a `chat.mp3`
 * notification on every chat/event — including the "{name} connected" join, which
 * replays on every reconnect. We assign this onto the iframe's `contentWindow`
 * from the parent (same-origin) so neko's `new Audio("chat.mp3").play()` does
 * nothing. Surgical: the WebRTC stream plays through a `<video>` element, not
 * `new Audio()`, so stream audio (toggled via the header button) is unaffected.
 * Done parent-side because an injected `<script>` doing the same silently didn't
 * take effect. neko's own `mute_chat` param doesn't stick either (it persists in
 * neko's localStorage).
 */
function SilentAudio() {
	return {
		play: () => Promise.resolve(),
		pause: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		load: () => {},
	}
}

// The neko stream is 1280x720 (NEKO_DESKTOP_SCREEN). Lock the shape so the video
// area stays 16:9 and never letterboxes; the header is a fixed pixel band on top,
// so total height = videoWidth * ratio + header.
export const NEKO_VIDEO_RATIO = 720 / 1280
export const NEKO_HEADER_HEIGHT = 28
// Default size: a 2000px-wide video at 16:9, plus the header — a large, readable
// shared browser by default (2.5x the original 800px draft).
export const NEKO_DEFAULT_W = 2000
export const NEKO_DEFAULT_H = Math.round(NEKO_DEFAULT_W * NEKO_VIDEO_RATIO + NEKO_HEADER_HEIGHT)

/**
 * Lock a freely-resized box to the stream's aspect ratio (no letterbox). Drives
 * off whichever dimension the drag changed more, so corner and side handles all
 * feel responsive rather than one axis being inert. Pure → unit-tested.
 */
export function lockNekoAspect(
	w: number,
	h: number,
	prevW: number,
	prevH: number
): { w: number; h: number } {
	if (Math.abs(h - prevH) > Math.abs(w - prevW)) {
		return { w: (h - NEKO_HEADER_HEIGHT) / NEKO_VIDEO_RATIO, h }
	}
	return { w, h: w * NEKO_VIDEO_RATIO + NEKO_HEADER_HEIGHT }
}

export interface NekoShapeProps {
	w: number
	h: number
	base: string
	title: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		neko: NekoShapeProps
	}
}

export type NekoShape = TLBaseShape<'neko', NekoShapeProps>

const HEADER_HEIGHT = NEKO_HEADER_HEIGHT

export class NekoShapeUtil extends BaseBoxShapeUtil<NekoShape> {
	static override type = 'neko' as const
	static override props = nekoShapeProps

	override getDefaultProps(): NekoShape['props'] {
		return { w: NEKO_DEFAULT_W, h: NEKO_DEFAULT_H, base: NEKO_DEFAULT_BASE, title: 'shared browser' }
	}

	// Lock to the stream's aspect ratio so the browser always fills the shape.
	override isAspectRatioLocked() {
		return true
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: NekoShape, info: TLResizeInfo<NekoShape>) {
		const next = resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
		const locked = lockNekoAspect(next.props.w, next.props.h, shape.props.w, shape.props.h)
		return { ...next, props: { ...next.props, ...locked } }
	}

	override component(shape: NekoShape) {
		return <NekoShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: NekoShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function NekoShapeComponent({ shape }: { shape: NekoShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const frameRef = useRef<HTMLIFrameElement>(null)
	const { base, title, w, h } = shape.props
	// The src is per-viewer: each teammate loads neko under their own canvas name.
	// peekIdentity() never prompts (the name is already set by canvas-render time).
	const src = useMemo(() => buildNekoSrc(base, peekIdentity().name), [base])

	// Reach into the same-origin iframe's <video> directly from the parent — this
	// runs as parent script (no injected <script>, no console) so it's robust.
	const getVideo = (): HTMLVideoElement | null => {
		try {
			return frameRef.current?.contentDocument?.querySelector('video') ?? null
		} catch {
			return null
		}
	}

	// Audio is muted until the user opts in, and we ENFORCE that. neko (on an
	// origin the browser treats as "engaged") auto-unmutes the stream on connect,
	// and that auto-unmute is what makes the re-attach "plop" audible. So while
	// the user prefers muted we re-mute neko's auto-unmute — instantly via the
	// <video>'s volumechange event, with a polled backstop — and while they prefer
	// unmuted we re-assert that across reconnects. embed mode hides neko's own
	// unmute overlay, so this header toggle is the control. Muting is always
	// recoverable, so this can never get stuck silent (unlike disabling the track).
	const prefMuted = useRef(true)
	const [muted, setMuted] = useState(true)
	useEffect(() => {
		let managed: HTMLVideoElement | null = null
		const enforce = () => {
			const v = managed
			if (v) {
				if (prefMuted.current) {
					if (!v.muted) v.muted = true
				} else if (v.muted) {
					v.muted = false
					if (v.volume === 0) v.volume = 1
					v.play?.().catch(() => {})
				}
			}
			setMuted(prefMuted.current)
		}
		const id = setInterval(() => {
			const v = getVideo()
			if (v !== managed) {
				managed?.removeEventListener('volumechange', enforce)
				managed = v
				managed?.addEventListener('volumechange', enforce)
			}
			enforce()
		}, 400)
		return () => {
			clearInterval(id)
			managed?.removeEventListener('volumechange', enforce)
		}
	}, [])

	const toggleMute = () => {
		prefMuted.current = !prefMuted.current
		const v = getVideo()
		if (v) {
			v.muted = prefMuted.current
			if (!prefMuted.current) {
				if (v.volume === 0) v.volume = 1
				v.play?.().catch(() => {})
			}
		}
		setMuted(prefMuted.current)
	}

	// neko's player measures its container only on a window 'resize' event. On
	// first mount it can latch onto a transient layout — the flicker that a manual
	// shape-resize later clears. Same-origin lets us dispatch the same event into
	// the iframe to force a clean re-measure as neko mounts and the stream arrives.
	const nudgeNekoLayout = () => {
		try {
			frameRef.current?.contentWindow?.dispatchEvent(new Event('resize'))
		} catch {
			/* contentWindow not reachable yet — the next nudge (or a real resize) covers it */
		}
	}

	// Reach into the same-origin iframe to (1) silence neko's join/chat sound and
	// (2) hide its branded connect splash. Guarded — content* may be null briefly,
	// and either failure is cosmetic only.
	const onFrameLoad = () => {
		try {
			// (1) Parent-side: no-op the iframe's Audio constructor (kills chat.mp3).
			const win = frameRef.current?.contentWindow
			if (win) (win as unknown as { Audio: unknown }).Audio = SilentAudio
			// (2) Hide neko's branded connect splash.
			const doc = frameRef.current?.contentDocument
			if (doc && !doc.getElementById('ew-neko-splash')) {
				const style = doc.createElement('style')
				style.id = 'ew-neko-splash'
				style.textContent = NEKO_SPLASH_CSS
				doc.head.appendChild(style)
			}
		} catch {
			/* content* not reachable yet — harmless, sound/splash just show */
		}
		// Re-measure across neko's async mount + WebRTC stream start (which can be
		// a couple of seconds on a cold connect).
		for (const delay of [0, 250, 750, 1500, 3000]) setTimeout(nudgeNekoLayout, delay)
	}

	return (
		<HTMLContainer
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: w,
				height: h,
				borderRadius: 4,
				overflow: 'hidden',
				background: '#000',
				border: isEditing ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ruleStrong}`,
				boxShadow: wm.shadowPaper,
				pointerEvents: isEditing ? 'all' : 'none',
			}}
		>
			<div
				onPointerDown={isEditing ? stopEventPropagation : undefined}
				style={{
					height: HEADER_HEIGHT,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0 10px',
					background: wm.panel,
					color: wm.inkMuted,
					fontFamily: wm.mono,
					fontSize: 10,
					borderBottom: `1px solid ${wm.rule}`,
					userSelect: 'none',
				}}
			>
				<span
					style={{
						color: wm.ink,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 1.5,
						whiteSpace: 'nowrap',
					}}
				>
					{title}
				</span>
				<span style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>shared browser · neko</span>
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, pointerEvents: 'all' }}>
					<NekoHeaderButton
						label={muted ? '🔇' : '🔊'}
						title={muted ? 'Unmute audio' : 'Mute audio'}
						onClick={toggleMute}
					/>
					<NekoHeaderButton
						label="↻"
						title="Reload"
						onClick={() => {
							if (frameRef.current) frameRef.current.src = src
						}}
					/>
					<NekoHeaderButton
						label="↗"
						title="Open in new tab"
						onClick={() => window.open(src, '_blank', 'noopener')}
					/>
				</span>
				{!isEditing && <span style={{ opacity: 0.6 }}>double-click to drive</span>}
			</div>
			<iframe
				ref={frameRef}
				src={src}
				title={title}
				onLoad={onFrameLoad}
				allow="autoplay; clipboard-read; clipboard-write"
				style={{ flex: 1, minHeight: 0, border: 'none', width: '100%' }}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-pointer-lock"
			/>
		</HTMLContainer>
	)
}

function NekoHeaderButton(props: { label: string; title: string; onClick: () => void }) {
	return (
		<button
			title={props.title}
			onPointerDown={stopEventPropagation}
			onClick={props.onClick}
			style={{
				border: 'none',
				background: 'transparent',
				cursor: 'pointer',
				fontSize: 13,
				color: wm.inkMuted,
				padding: '0 2px',
			}}
		>
			{props.label}
		</button>
	)
}
