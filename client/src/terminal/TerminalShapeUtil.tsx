/**
 * A live terminal as a tldraw shape.
 *
 * - Renders xterm.js inside an HTMLContainer, attached over WebSocket to the
 *   terminal gateway, which bridges to `tmux new -A -s canvas-{sessionId}`.
 * - Double-click to enter editing (keystrokes go to the PTY; tldraw suspends
 *   its shortcuts while a shape is being edited). Press Esc twice quickly or
 *   click away to go back to canvas navigation — a single Esc is forwarded to
 *   the terminal so vim/emacs/Claude Code keep working.
 * - The shape's width/height is the source of truth for the PTY grid. The grid
 *   (cols/rows) is a deterministic function of w/h and the base-font cell size,
 *   computed identically on every client (see ./grid), so there is no proposer
 *   race: the number every viewer derives for a given box is the same, hence
 *   scrolling, culling or zooming a terminal never resizes it for anyone. The
 *   gateway stays authoritative for the tmux PTY size and dedups identical sizes,
 *   so the redundant echoes from multiple viewers are harmless no-ops.
 */
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
	terminalShapeProps,
	type TermClientMessage,
	type TermServerMessage,
} from '@ensembleworks/contracts'
import { useEffect, useRef, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	useEditor,
	useValue,
} from 'tldraw'
import { paperTerminalTheme, wm } from '../theme'
import { type CellSize, gridFor, quantizeCell } from './grid'
import { FONT_SIZE_DEFAULT, fontSizeActionForKey, nextFontSize, ptyInputForKey } from './keys'
import { termWsUrl } from './wsUrl'

export interface TerminalShapeProps {
	w: number
	h: number
	sessionId: string
	title: string
	// Optional status light set by agents via POST /api/terminal/status.
	status?: string
	// Remote gateway id (spike): undefined = same-origin gateway, zero
	// migration for existing rooms. See /api/terminal/list.
	gateway?: string
	// Per-terminal base font size (px) — SHARED: one PTY grid per terminal, so
	// font size belongs to the terminal, not the viewer; changing it re-grids
	// for every client. Optional so existing rooms need no migration (= 16).
	fontSize?: number
}

// Register the shape in tldraw's global shape union (tldraw v5 pattern), so
// editor.createShape({ type: 'terminal', ... }) is fully typed.
declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		terminal: TerminalShapeProps
	}
}

export type TerminalShape = TLBaseShape<'terminal', TerminalShapeProps>

const MIN_W = 360
const MIN_H = 220
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

type TerminalConnection = 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'ended'

// The grid cell, from xterm's renderer-INDEPENDENT char measurement
// (_charSizeService: pure font metrics in CSS px). The render service's cell
// must NOT be used here: it is quantised to device pixels by the ACTIVE
// renderer — WebGL floors width (9.6px → 9.09 at DPR 1.1) while the DOM
// renderer draws true fractional advances — so a grid derived from it packs
// more columns than edit mode can fit (≈5% clipped at DPR 1.1). Width: charW
// is a safe upper bound for both renderers (WebGL ≤ charW, DOM = charW).
// Height: renderers round rows UP to at most charH + 1/DPR css px, so the
// grid uses charH + 1 — the deterministic safe bound; no renderer ever clips
// the last row, at the cost of ≤1px per row of bottom under-fill. This is the
// one input to the deterministic grid that must be *measured* rather than
// shared — quantised in ./grid so every client agrees on it (and, being pure
// font metrics, it no longer varies by renderer or DPR at all).
function xtermCell(term: Terminal): { width: number; height: number } | null {
	const cs = (
		term as unknown as {
			_core?: { _charSizeService?: { width?: number; height?: number } }
		}
	)._core?._charSizeService
	return cs?.width && cs?.height ? { width: cs.width, height: cs.height + 1 } : null
}

// The ACTIVE renderer's cell (CSS px) — used ONLY for the view-mode fill
// compensation; the shared grid must never read this (see xtermCell above).
function rendererCell(term: Terminal): { width: number; height: number } | null {
	const cell = (
		term as unknown as {
			_core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } }
		}
	)._core?._renderService?.dimensions?.css?.cell
	return cell?.width && cell?.height ? { width: cell.width, height: cell.height } : null
}

export class TerminalShapeUtil extends BaseBoxShapeUtil<TerminalShape> {
	static override type = 'terminal' as const
	static override props = terminalShapeProps

	override getDefaultProps(): TerminalShape['props'] {
		return { w: 720, h: 440, sessionId: 'default', title: 'terminal' }
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}
	override canScroll() {
		return true
	}
	override isAspectRatioLocked() {
		return false
	}

	override onResize(shape: TerminalShape, info: TLResizeInfo<TerminalShape>) {
		return resizeBox(shape, info, { minWidth: MIN_W, minHeight: MIN_H })
	}

	override component(shape: TerminalShape) {
		return <TerminalShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: TerminalShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

// Copy from inside a user gesture. The async Clipboard API is refused outside a
// gesture and, on some browsers, even inside one without a permission — so we
// lead with the synchronous textarea + execCommand('copy') trick, which works in
// any gesture everywhere, and also fire the async write as a belt-and-braces.
// Focus is restored to the terminal afterwards (execCommand steals it).
function copyInGesture(text: string, term: Terminal) {
	if (!text) return
	try {
		const ta = document.createElement('textarea')
		ta.value = text
		ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
		document.body.appendChild(ta)
		ta.select()
		document.execCommand('copy')
		ta.remove()
	} catch {
		/* execCommand unavailable — rely on the async write below */
	}
	navigator.clipboard?.writeText(text).catch(() => {})
	term.focus()
}

function TerminalShapeComponent({ shape }: { shape: TerminalShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	// Canvas zoom, but only tracked while this terminal is being edited — idle
	// terminals don't subscribe, so zooming the board doesn't re-render them all.
	// tldraw scales every shape by this factor; xterm's mouse→cell math assumes an
	// unscaled element, so we counter-scale the host below to keep selection exact.
	const editZoom = useValue('editZoom', () => (isEditing ? editor.getZoomLevel() : 1), [
		editor,
		isEditing,
	])
	// Shared base font (px). A ref shadows it for closures created at mount
	// (captureCell) — they must normalise against the CURRENT base font, not
	// the mount-time value.
	const baseFont = shape.props.fontSize ?? FONT_SIZE_DEFAULT
	const baseFontRef = useRef(baseFont)
	baseFontRef.current = baseFont

	const containerRef = useRef<HTMLDivElement>(null)
	const hostRef = useRef<HTMLDivElement>(null)
	const termRef = useRef<Terminal | null>(null)
	const wsRef = useRef<WebSocket | null>(null)
	const webglRef = useRef<WebglAddon | null>(null)
	// Base-font cell size (CSS px), measured once the web font is ready (null until
	// then). The deterministic grid divides the shape box by this; see ./grid.
	const [cellSize, setCellSize] = useState<CellSize | null>(null)
	const lastEscRef = useRef(0)
	// Most recent text tmux copied to us via OSC 52. The instant write can be
	// refused (no user gesture, or a browser that needs a permission), so we keep
	// it here to re-flush from the Ctrl/Cmd-Shift-C keystroke.
	const lastCopyRef = useRef('')
	const [connection, setConnection] = useState<TerminalConnection>('connecting')
	const [retryAttempt, setRetryAttempt] = useState(0)

	// Rename the terminal by double-clicking its floating title, like a frame.
	const [renaming, setRenaming] = useState(false)
	const [draftTitle, setDraftTitle] = useState(shape.props.title)
	const startRename = () => {
		setDraftTitle(shape.props.title)
		setRenaming(true)
	}
	const commitRename = () => {
		const next = draftTitle.trim()
		if (next && next !== shape.props.title) {
			editor.updateShape({ id: shape.id, type: shape.type, props: { title: next } })
		}
		setRenaming(false)
	}

	// Make the title a move handle, like a frame heading: drag it to translate
	// the shape. Intermediate moves are history-ignored; the final position is
	// recorded once so the whole drag is a single undo step. A 4px threshold lets
	// a stationary double-click still open the rename input.
	const beginTitleDrag = (startX: number, startY: number) => {
		editor.setSelectedShapes([shape.id])
		const origin = { x: shape.x, y: shape.y }
		let dragging = false
		const move = (clientX: number, clientY: number, record: boolean) => {
			const zoom = editor.getZoomLevel()
			const x = origin.x + (clientX - startX) / zoom
			const y = origin.y + (clientY - startY) / zoom
			const apply = () => editor.updateShape({ id: shape.id, type: shape.type, x, y })
			if (record) apply()
			else editor.run(apply, { history: 'ignore' })
		}
		const onMove = (ev: PointerEvent) => {
			if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
			if (!dragging) {
				dragging = true
				// Force a grabbing cursor everywhere for the duration of the drag.
				// tldraw's select tool re-sets the canvas cursor on every pointer
				// move, so a global !important class is more reliable than setCursor.
				document.body.classList.add('ew-dragging')
			}
			move(ev.clientX, ev.clientY, false)
		}
		const onUp = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', onMove)
			window.removeEventListener('pointerup', onUp)
			if (dragging) {
				move(ev.clientX, ev.clientY, true)
				document.body.classList.remove('ew-dragging')
			}
		}
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
	}

	// Mount xterm + gateway connection once per tmux session.
	useEffect(() => {
		const container = containerRef.current
		const host = hostRef.current
		if (!container || !host) return

		const term = new Terminal({
			fontSize: baseFontRef.current,
			fontFamily: wm.mono,
			// tmux owns scrollback (mouse on → wheel enters copy-mode, 50k line
			// history). A local xterm buffer would fight it for wheel events.
			scrollback: 0,
			theme: paperTerminalTheme,
		})
		// OSC 52: with `set-clipboard on`, tmux sends us the text whenever it's
		// copied (mouse drag, double/triple click, vi `y`). Two gotchas handled
		// here: (1) tmux uses an EMPTY selection field (`OSC 52 ; ; <base64>`), not
		// `c`, and xterm's default provider only honours `c` — so it silently
		// dropped every copy; we accept empty too. (2) It arrives off a websocket
		// with no user gesture, so the immediate write only lands on permissive
		// browsers; we also stash it for the Ctrl/Cmd-Shift-C keystroke to re-flush.
		const isClipboard = (selection: string) => selection === 'c' || selection === ''
		const clipboardProvider: IClipboardProvider = {
			readText: (selection) =>
				isClipboard(selection) && navigator.clipboard ? navigator.clipboard.readText() : '',
			writeText: (selection, text) => {
				if (!isClipboard(selection)) return
				lastCopyRef.current = text
				navigator.clipboard?.writeText(text).catch(() => {})
			},
		}
		term.loadAddon(new ClipboardAddon(undefined, clipboardProvider))
		// xterm renders into an inner host so we can counter-scale it against the
		// canvas zoom without disturbing the padded frame box (containerRef).
		term.open(host)
		// Bootstrap the spawn size synchronously (so the PTY starts ~right and the
		// WS URL below carries it); the deterministic effect refines it to the exact
		// grid once the web font's cell is measured. fontSize is the base font here,
		// so the measured cell is already at base scale.
		const bootCell = xtermCell(term)
		if (bootCell) {
			const { cols, rows } = gridFor(
				shape.props.w,
				shape.props.h,
				quantizeCell(bootCell.width, bootCell.height)
			)
			term.resize(cols, rows)
		}
		termRef.current = term

		let disposed = false
		let ended = false
		let attempt = 0
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null

		const clearReconnectTimer = () => {
			if (reconnectTimer) clearTimeout(reconnectTimer)
			reconnectTimer = null
		}

		const connect = () => {
			if (disposed || ended) return
			clearReconnectTimer()
			const previous = wsRef.current
			if (previous && previous.readyState < WebSocket.CLOSING) previous.close()

			setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
			setRetryAttempt(attempt)
			const ws = new WebSocket(
				termWsUrl(shape.props.sessionId, term.cols, term.rows, shape.props.gateway)
			)
			ws.binaryType = 'arraybuffer'
			wsRef.current = ws

			ws.onopen = () => {
				attempt = 0
				setRetryAttempt(0)
				// The deterministic-grid effect re-asserts our size on (re)connect — it
				// keys on the connection state — so there's nothing to push here.
			}
			ws.onclose = () => {
				if (wsRef.current !== ws) return
				wsRef.current = null
				if (disposed || ended) return
				attempt++
				setConnection('disconnected')
				setRetryAttempt(attempt)
				const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
				const delay = exponential * (0.8 + Math.random() * 0.4)
				reconnectTimer = setTimeout(connect, delay)
			}
			ws.onerror = () => ws.close()
			ws.onmessage = (ev) => {
				if (typeof ev.data === 'string') {
					let msg: TermServerMessage
					try {
						msg = JSON.parse(ev.data)
					} catch {
						return
					}
					if ((msg.type === 'resize' || msg.type === 'attached') && msg.cols && msg.rows) {
						if (msg.type === 'attached') {
							// The gateway replays recent output after every attach. Clear the
							// stale local screen first so reconnects do not duplicate it.
							term.reset()
							setConnection('live')
						}
						term.resize(msg.cols, msg.rows)
					} else if (msg.type === 'exit') {
						ended = true
						setConnection('ended')
						term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n')
					}
				} else {
					term.write(new Uint8Array(ev.data))
				}
			}
		}

		const reconnectNow = () => {
			if (disposed || ended || (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN)) return
			connect()
		}
		const reconnectWhenVisible = () => {
			if (document.visibilityState !== 'visible') return
			// Returning to the tab is the cheap moment to discard a possibly-rotten
			// WebGL glyph atlas (silent corruption never fires onContextLoss) —
			// clearTextureAtlas re-rasterises every glyph on the next frame.
			try {
				term.clearTextureAtlas()
			} catch {
				/* renderer variance — a repaint miss is not worth crashing over */
			}
			reconnectNow()
		}

		window.addEventListener('online', reconnectNow)
		document.addEventListener('visibilitychange', reconnectWhenVisible)

		// Connect now (using the bootstrap grid baked into the WS URL above). The
		// deterministic-grid effect corrects the size to the exact cell-derived grid
		// once the web font is measured. Reconnect/visibility handlers reuse connect().
		connect()

		// Measure the base-font cell that the deterministic grid divides by. JetBrains
		// Mono loads async (Google Fonts, display=swap); reassigning fontFamily forces
		// xterm's char remeasure. Every client measures the same font at the same size
		// and quantises identically (see ./grid), so they all derive the same grid —
		// nothing is *proposed* from a local measurement, so a late font load on one
		// viewer can never resize anyone else.
		const captureCell = () => {
			if (disposed) return
			const cell = xtermCell(term)
			if (!cell) return
			// Normalise to the base font: the zoom effect may have scaled fontSize, but
			// the grid must be zoom-invariant.
			const scale = (term.options.fontSize ?? baseFontRef.current) / baseFontRef.current
			setCellSize(quantizeCell(cell.width / scale, cell.height / scale))
		}
		document.fonts
			.load('16px "JetBrains Mono"')
			.then(() => {
				if (disposed) return
				term.options.fontFamily = 'monospace'
				term.options.fontFamily = wm.mono
				captureCell()
			})
			.catch(captureCell)
		// The symbols fallback needs the same treatment: canvas fillText neither
		// waits for web fonts nor reliably triggers a unicode-range download, and
		// the WebGL atlas caches whatever it first rasterised (tofu). Force the
		// load, then discard the atlas so PUA glyphs re-rasterise from the real
		// font. Grid untouched — the fallback never supplies the measured cell.
		// The sample char must sit inside the face's unicode-range: fonts.load()
		// filters faces against the sample text's code points, and the default
		// " " sample is outside the PUA range, so it would skip the fetch.
		document.fonts
			.load('16px "Symbols Nerd Font Mono"', '\uE0B0')
			.then(() => {
				if (disposed) return
				try {
					term.clearTextureAtlas()
				} catch {
					/* renderer variance */
				}
			})
			.catch(() => {})
		// Safety net: capture from whatever font is active if the load stalls.
		const cellFallbackTimer = setTimeout(captureCell, 1500)

		term.onData((data) => {
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) {
				const msg: TermClientMessage = { type: 'input', data }
				ws.send(JSON.stringify(msg))
			}
		})

		// Double-Esc exits editing; a single Esc is the terminal's (vim!).
		term.attachCustomKeyEventHandler((e) => {
			// Shift/Alt+Enter → newline (ESC CR) instead of submit — see ./keys.
			// preventDefault + return false so xterm doesn't also send \r.
			const ptyInput = ptyInputForKey(e)
			if (ptyInput) {
				e.preventDefault()
				const ws = wsRef.current
				if (ws?.readyState === WebSocket.OPEN) {
					const msg: TermClientMessage = { type: 'input', data: ptyInput }
					ws.send(JSON.stringify(msg))
				}
				return false
			}
			// Ctrl/Cmd +/-/0: shared per-terminal font size (see ./keys). Owned
			// here so the browser's page-zoom never fires while editing. Read the
			// LIVE shape — this closure's `shape` is stale after prop changes.
			const fontAction = fontSizeActionForKey(e)
			if (fontAction) {
				e.preventDefault()
				const live = editor.getShape(shape.id) as TerminalShape | undefined
				const current = live?.props.fontSize ?? FONT_SIZE_DEFAULT
				const next = nextFontSize(current, fontAction)
				if (live && next !== current) {
					editor.updateShape({ id: shape.id, type: shape.type, props: { fontSize: next } })
				}
				return false
			}
			if (e.type === 'keydown' && (e.ctrlKey || e.metaKey)) {
				const key = e.key.toLowerCase()
				// Paste: Ctrl/Cmd+V and Ctrl+Shift+V → route the clipboard through the
				// PTY (term.paste respects the inner app's bracketed-paste mode). We
				// own the keystroke so tldraw / PasteUrlHandler never see it.
				if (key === 'v') {
					// We paste explicitly via term.paste() below. Returning false from
					// attachCustomKeyEventHandler does NOT call preventDefault (xterm bails
					// before that), so without this the browser's own Ctrl+V also fires a
					// native paste event on xterm's hidden textarea — pasting everything a
					// second time. preventDefault suppresses that native paste, leaving our
					// term.paste as the only one.
					e.preventDefault()
					navigator.clipboard
						?.readText()
						.then((text) => {
							if (text) term.paste(text)
						})
						.catch(() => {})
					return false
				}
				// Copy (from inside a real keystroke, so the clipboard write is
				// allowed): Ctrl+Shift+C always; plain Ctrl/Cmd+C only when there's a
				// live xterm selection (otherwise Ctrl+C must stay SIGINT). Source the
				// text from xterm's own selection (Shift-drag) or, failing that, the
				// last thing tmux copied to us over OSC 52 (mouse/`y` selection).
				if (key === 'c') {
					const sel = term.getSelection()
					if (e.shiftKey || sel) {
						copyInGesture(sel || lastCopyRef.current, term)
						return false
					}
				}
			}
			if (e.type === 'keydown' && e.key === 'Escape') {
				const now = Date.now()
				if (now - lastEscRef.current < 350) {
					lastEscRef.current = 0
					editor.setEditingShape(null)
					editor.setSelectedShapes([shape.id])
					editor.getContainer().focus()
					return false
				}
				lastEscRef.current = now
			}
			return true
		})

		return () => {
			disposed = true
			clearReconnectTimer()
			clearTimeout(cellFallbackTimer)
			window.removeEventListener('online', reconnectNow)
			document.removeEventListener('visibilitychange', reconnectWhenVisible)
			wsRef.current?.close()
			term.dispose()
			webglRef.current = null
			termRef.current = null
			wsRef.current = null
		}
	}, [shape.props.sessionId, editor, shape.id])

	// Editing state drives keyboard focus. (Renderer swap on edit lives in its
	// own effect below.)
	useEffect(() => {
		if (isEditing) termRef.current?.focus()
		else termRef.current?.blur()
	}, [isEditing])

	// Renderer strategy: WebGL while viewing, DOM while editing — everyone,
	// always (no per-machine flag).
	// - View mode can have many terminals compositing while the tldraw camera
	//   pans/zooms; the WebGL renderer is cheap there and glyphs stay at the
	//   base font, inside the atlas's comfort zone.
	// - Edit mode renders at fontSize ≈ base × zoom. Feeding that to an atlas
	//   renderer produced the blur (fractional sizes), drifting side margins
	//   (device-px cell rounding × cols) and square-box glyphs at high
	//   zoom × DPR (atlas overflow) — verified live at DPR 1.1/2.2. The DOM
	//   renderer has no atlas; browser text is crisp at any fractional size.
	// Disposing the addon drops xterm to its DOM renderer; going back needs a
	// fresh instance (disposed addons cannot be reloaded).
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		if (isEditing) {
			webglRef.current?.dispose()
			webglRef.current = null
			return
		}
		const webgl = new WebglAddon()
		webgl.onContextLoss(() => {
			// Degraded but functional: surface it so a silently DOM-rendered
			// terminal isn't invisible to anyone watching the console.
			console.warn('[terminal] WebGL context lost — falling back to DOM renderer')
			webgl.dispose()
			if (webglRef.current === webgl) webglRef.current = null
		})
		term.loadAddon(webgl)
		webglRef.current = webgl
		return () => {
			// Skip if context-loss already disposed it (ref was nulled).
			if (webglRef.current === webgl) {
				webgl.dispose()
				webglRef.current = null
			}
		}
	}, [isEditing, shape.props.sessionId])

	const [viewFit, setViewFit] = useState<{ fx: number; fy: number } | null>(null)

	// Counter-scale the font to the canvas zoom so text stays crisp and xterm's
	// mouse→cell math is exact (the host's CSS transform, in JSX, keeps the net
	// on-screen scale at 1). This must track editZoom *in lockstep with that
	// transform*. The transform applies on render, so the font cannot lag it: this
	// effect once debounced the font by 120ms, which left the terminal rendering at
	// the old font inside the new transform for that window — a visible shrink-then-
	// snap every time you activated the terminal. Applying it straight away makes
	// the change invisible (the net on-screen size is unchanged either way). Only
	// the edited terminal's editZoom changes — idle terminals stay at 1 — so this
	// does not re-render every terminal when the board zooms. The grid (cols/rows)
	// is gateway-authoritative and unaffected; only the rendered font size changes.
	// Rendered font is the zoom-scaled base FLOORED TO WHOLE PIXELS: fractional
	// font sizes make the DOM renderer quantise row heights per row — the
	// source of the bottom-edge drift and row seams while editing — and blur
	// atlas glyphs. Because the font is floored while the host is
	// counter-scaled by the exact zoom, the rendered grid under-fills the box
	// by up to one font-px worth (typically a few percent, measured up to
	// ~7.5% of width at fractional zooms — see spec addendum findings; a
	// small background strip at right/bottom) — deliberately traded for
	// exact mouse→cell selection:
	// xterm's getCoords assumes net on-screen scale 1 (it divides
	// transform-inclusive screen px by transform-independent CSS cell size),
	// so the counter-scale MUST invert the raw zoom, not the font's factor.
	// Floor, not round: rounding up made the content LARGER than the box and
	// clipped the right edge; flooring only ever under-fills. Grid unaffected:
	// captureCell normalises by (fontSize / the base font), which remains the
	// true factor.
	// The lower clamp is 1, not a legibility floor: any larger clamp re-breaks
	// net-scale-1 whenever it binds (right/bottom clipping + mouse→cell
	// selection drift — see above). The floor's only job is fontSize >= 1;
	// the user's own zoom choice governs legibility.
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		// Exact fractional font: only the DOM renderer ever sees a non-integer
		// size (view mode is editZoom=1 → integer base font for WebGL), and it
		// lays out fractional advances crisply. Flooring — an atlas-era remedy —
		// made the rendered cell diverge from the shared grid cell by a
		// zoom-dependent fraction, which live testing showed as wandering
		// margins at every non-integer zoom.
		const nextFont = Math.max(1, baseFont * editZoom)
		if (term.options.fontSize !== nextFont) term.options.fontSize = nextFont
	}, [editZoom, baseFont])

	// View-mode fill compensation. The shared grid cell is pure font metrics
	// (9.6px at 16px JetBrains Mono), but WebGL physically renders cells at
	// whole device pixels — floor(9.6 × DPR)/DPR, e.g. 9.09 CSS px at DPR 1.1
	// — so view-mode content under-fills the grid box by up to half a device
	// pixel per cell (~35px across a wide terminal on a fractional-DPR
	// screen). Scale the host by the per-axis ratio grid-cell / rendered-cell
	// so the box fills exactly. Local cosmetics only: each client compensates
	// its own renderer; the shared grid is untouched, selection doesn't exist
	// in view mode, and edit mode (DOM renderer, true fractional advances)
	// never needs it. Declared AFTER the renderer-strategy and font effects so
	// it measures the fresh WebGL renderer at the base font on edit-exit; the
	// font normalisation and the clamp are belt-and-braces on top of that
	// ordering (a bad measurement can never distort wildly).
	useEffect(() => {
		const term = termRef.current
		if (isEditing || !cellSize || !term) {
			setViewFit(null)
			return
		}
		const rs = rendererCell(term)
		if (!rs) return
		// Normalise to the base font, mirroring captureCell — harmless when the
		// font effect has already run (scale 1), correct if it somehow hasn't.
		const scale = (term.options.fontSize ?? baseFont) / baseFont
		const clamp = (v: number) => Math.min(1.15, Math.max(1, v))
		setViewFit({
			fx: clamp(cellSize.w / (rs.width / scale)),
			fy: clamp(cellSize.h / (rs.height / scale)),
		})
	}, [isEditing, cellSize, baseFont, shape.props.sessionId])

	// Shared font-size changes re-measure the cell; the deterministic grid
	// effect then re-derives cols/rows from the same shared inputs everywhere.
	// baseFont is a synced shape prop and the cell is quantised, which keeps
	// clients on the SAME renderer+DPR in lockstep; clients on different DPRs
	// can still measure cells a bucket apart because the WebGL renderer
	// DPR-quantises its reported cell — a known residual (see spec addendum
	// follow-ups), bounded by the gateway's authoritative dedup.
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		const cell = xtermCell(term)
		if (!cell) return
		const scale = (term.options.fontSize ?? baseFont) / baseFont
		setCellSize(quantizeCell(cell.width / scale, cell.height / scale))
	}, [baseFont])

	// Deterministic grid: cols/rows are a pure function of the shared box (shape
	// w/h) and the quantised base-font cell size (see ./grid), so every client
	// computes the same value. We apply it locally and echo it to the gateway;
	// because the value is identical everywhere, the gateway's dedup turns any
	// redundant echoes from other viewers into no-ops — there is no resize race to
	// win or lose. Re-runs on box change, when the cell size is first known, and on
	// (re)connect (to re-assert a size changed while we were offline).
	useEffect(() => {
		const term = termRef.current
		if (!term || !cellSize) return
		const { cols, rows } = gridFor(shape.props.w, shape.props.h, cellSize)
		if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
		const ws = wsRef.current
		if (ws?.readyState === WebSocket.OPEN) {
			const msg: TermClientMessage = { type: 'resize', cols, rows }
			ws.send(JSON.stringify(msg))
		}
	}, [shape.props.w, shape.props.h, cellSize, connection])

	// w/h drive the shape's rendered box.
	const { w, h } = shape.props

	return (
		<HTMLContainer
			style={{
				width: w,
				height: h,
				position: 'relative',
				// When not editing, let pointer events fall through to tldraw so
				// the shape can be selected, dragged and resized like any other.
				pointerEvents: isEditing ? 'all' : 'none',
			}}
		>
			{/* Title floats above the top border and behaves like a tldraw frame
			    heading: (a) double-click to rename, (b) drag to move the shape,
			    (c) light cream chip. The .tl-frame-heading wrapper (12px, 4px
			    bottom gap, pinned top-left) holds the .tl-frame-label (0 6px,
			    --tl-radius-1) in the repo's brand posture (mono / uppercase /
			    0.14em / seal-blue). Pointer-events are on even when the shape
			    isn't selected so it acts as a move handle. */}
			<div
				onPointerDown={(e) => {
					if (renaming || e.button !== 0) return
					e.stopPropagation()
					beginTitleDrag(e.clientX, e.clientY)
				}}
				onDoubleClick={(e) => {
					if (renaming) return
					e.stopPropagation()
					startRename()
				}}
				style={{
					position: 'absolute',
					left: 0,
					bottom: '100%',
					display: 'flex',
					alignItems: 'center',
					maxWidth: '100%',
					overflow: 'hidden',
					paddingBottom: 4,
					fontFamily: wm.mono,
					fontSize: 12,
					textTransform: 'uppercase',
					letterSpacing: '0.14em',
					cursor: renaming ? 'text' : 'grab',
					pointerEvents: 'all',
				}}
			>
				{renaming ? (
					<input
						autoFocus
						value={draftTitle}
						onChange={(e) => setDraftTitle(e.currentTarget.value)}
						onBlur={commitRename}
						onKeyDown={(e) => {
							e.stopPropagation()
							if (e.key === 'Enter') commitRename()
							else if (e.key === 'Escape') setRenaming(false)
						}}
						onPointerDown={(e) => e.stopPropagation()}
						style={{
							margin: 0,
							padding: '2px 9px',
							border: 'none',
							borderRadius: 'var(--tl-radius-1)',
							background: 'var(--tl-color-panel)',
							boxShadow: 'inset 0 0 0 1.5px var(--tl-color-selected)',
							font: 'inherit',
							color: 'var(--tl-color-text-1)',
							minWidth: 32,
							outline: 'none',
						}}
					/>
				) : (
					<div
						title="Double-click to rename · drag to move"
						style={{
							padding: '2px 9px',
							borderRadius: 'var(--tl-radius-1)',
							// Exact frame-heading fill: tldraw sets backgroundColor inline
							// to theme.negativeSpace (#f9fafb in the light theme) — an inline
							// JS value, which is why the app's --tl-color-* overrides never
							// reach it. This is the "light cream" chip frames actually show.
							background: '#f9fafb',
							color: wm.sealBlue,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'pre',
							userSelect: 'none',
						}}
					>
						{shape.props.title}
					</div>
				)}
			</div>
			{/* The terminal box itself — clipped, bordered, paper-white. */}
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					borderRadius: 4,
					overflow: 'hidden',
					background: '#fff',
					// Constant 1px border in BOTH modes: a border-width change would
					// shrink the content box and visibly shift the terminal text on
					// every edit toggle. The editing highlight is an outer box-shadow
					// ring instead — zero layout impact.
					border: `1px solid ${isEditing ? wm.sealBlue : wm.ink}`,
					boxShadow: isEditing ? `0 0 0 1.5px ${wm.sealBlue}, ${wm.shadowPaper}` : wm.shadowPaper,
				}}
			>
			{/* No in-frame header: tmux's own status bar (status-position top in
			    deploy/tmux-ensembleworks.conf) carries the session name + mode
			    flags. The editing hint is a tooltip; connection drops are shown by
			    the overlay below; the agent status light is the corner dot. */}
			<div
				ref={containerRef}
				title={
					isEditing
						? 'Esc Esc to leave · select, then Ctrl/⌘-Shift-C to copy · Ctrl/⌘-Shift-V to paste'
						: 'Double-click to type'
				}
				style={{
					flex: 1,
					minHeight: 0,
					// KEEP IN SYNC with TERMINAL_PAD in ./grid.ts — one fact, recorded twice.
					padding: '10px 20px 4px 12px',
					opacity: connection === 'live' ? 1 : 0.28,
					filter: connection === 'live' ? undefined : 'grayscale(0.8)',
					transition: 'opacity 160ms ease, filter 160ms ease',
				}}
			>
				{/* xterm renders here. While editing at zoom ≠ 1 the host is sized
				    up by the zoom and scaled back down by 1/zoom, giving the element
				    a net on-screen scale of 1 (so xterm's mouse→cell math is exact)
				    while still filling the frame. At zoom 1 this is the identity.
				    In view mode the host instead applies the fill compensation
				    (viewFit): WebGL's device-pixel cells run slightly smaller than
				    the shared grid cell on fractional-DPR screens, so the content
				    is scaled up per-axis to fill the box (see the viewFit effect). */}
				<div
					ref={hostRef}
					style={
						!isEditing && viewFit
							? {
									width: `calc(100% / ${viewFit.fx})`,
									height: `calc(100% / ${viewFit.fy})`,
									transform: `scale(${viewFit.fx}, ${viewFit.fy})`,
									transformOrigin: 'top left',
								}
							: {
									width: `calc(100% * ${editZoom})`,
									height: `calc(100% * ${editZoom})`,
									transform: `scale(${1 / editZoom})`,
									transformOrigin: 'top left',
								}
					}
				/>
			</div>
			{connection !== 'live' && (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						display: 'grid',
						placeItems: 'center',
						background: 'rgba(250,250,247,0.45)',
						color: connection === 'ended' ? wm.crit : wm.inkMuted,
						fontFamily: wm.mono,
						fontSize: 11,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 1,
						pointerEvents: 'none',
					}}
				>
					{connection === 'ended'
						? 'Session ended'
						: `Connection lost — reconnecting${retryAttempt > 0 ? ` (${retryAttempt})` : ''}…`}
				</div>
			)}
			</div>
		</HTMLContainer>
	)
}
