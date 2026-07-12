/**
 * canvas-v2 port of client/src/terminal/TerminalShapeUtil.tsx — xterm.js
 * mounted over a WebSocket to the terminal gateway, bridging to
 * `tmux new -A -s canvas-{sessionId}`.
 *
 * REUSED (imported, not forked — per this unit's instruction): grid.ts
 * (`gridFor`/`quantizeCell`, the deterministic shared PTY grid), keys.ts
 * (`ptyInputForKey`/`fontSizeActionForKey`/`nextFontSize`/`FONT_SIZE_DEFAULT`,
 * the pure key-event mapping), wsUrl.ts (`termWsUrl`), theme.ts
 * (`paperTerminalTheme`, `wm`) — all four are already unit-tested in place
 * (grid.test.ts/keys.test.ts/wsUrl.test.ts) and untouched by this port.
 *
 * REWRITTEN (the mount/connect effect itself is inherently coupled inline in
 * the legacy file's single big component, not exported as a reusable hook —
 * this body re-implements the xterm+WS wiring using the pure helpers above,
 * simplified relative to the legacy version): DROPPED for this v1 port —
 * WebGL-vs-DOM renderer switching on edit/view, the zoom-counterscaled edit
 * host, view-mode sub-pixel fill compensation, OSC-52 clipboard bridging,
 * and the title-rename / title-drag-to-move affordance (the last of these
 * needs `editor.updateShape`, which a shape body in this contract cannot
 * call at all — see ./index.ts's INTERACTIVE-CONTENT EVENT POLICY note).
 * These are cosmetic/parity-polish, not the terminal's live-session
 * substance; full parity is G2-golden/Phase-4 territory. KEPT: xterm
 * mounted once per `sessionId`, WS connect with backoff reconnect, the
 * shared deterministic grid (measured once per mount — the legacy file's
 * async web-font remeasure is dropped for the same reason: it only refines
 * an already-good boot estimate), term.onData -> ws input forwarding, the
 * Shift/Alt+Enter -> newline translation, and the focus-swallow policy.
 *
 * EMBED LIFECYCLE — onSuspend closes the WebSocket, onResume reconnects:
 * a REAL bandwidth/CPU win (mirrors the legacy file's own precedent — its
 * `reconnectWhenVisible` already cycles the connection on
 * `document.visibilitychange`, just never proactively closes on hide). The
 * gateway replays the tmux pane's recent output on every `attached` message
 * (see the legacy file's onmessage handler), so closing on suspend loses no
 * data: resuming just gets a fresh replay instead of the (invisible, wasted)
 * live stream. xterm's own DOM/state stays mounted throughout (EmbedHost's
 * visibility:hidden), so there's no re-render cost either.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Shape } from '@ensembleworks/canvas-model'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import { CellSize, gridFor, quantizeCell } from '../../terminal/grid.js'
import { FONT_SIZE_DEFAULT, ptyInputForKey } from '../../terminal/keys.js'
import { termWsUrl } from '../../terminal/wsUrl.js'
import { paperTerminalTheme, wm } from '../../theme.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'
import { useInteractionMode } from './useInteractionMode.js'

const MIN_W = 360
const MIN_H = 220
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

type TerminalConnection = 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'ended' | 'suspended'

export interface TerminalShapeContent {
  readonly w: number
  readonly h: number
  readonly sessionId: string
  readonly title: string
  readonly gateway: string | undefined
  readonly fontSize: number
}

/** Pure props->render-input adapter (unit-tested in TerminalShape.test.ts). */
export function terminalContentFrom(shape: Shape): TerminalShapeContent {
  const p = shape.props as Record<string, unknown>
  return {
    w: typeof p.w === 'number' ? p.w : Math.max(MIN_W, 720),
    h: typeof p.h === 'number' ? p.h : Math.max(MIN_H, 440),
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : 'default',
    title: typeof p.title === 'string' ? p.title : 'terminal',
    gateway: typeof p.gateway === 'string' ? p.gateway : undefined,
    fontSize: typeof p.fontSize === 'number' ? p.fontSize : FONT_SIZE_DEFAULT,
  }
}

// Base-font cell measurement — the one input the deterministic grid divides
// by; see grid.ts's module header for why it must be measured, not shared.
function xtermCell(term: Terminal): CellSize | null {
  const cs = (term as unknown as { _core?: { _charSizeService?: { width?: number; height?: number } } })._core
    ?._charSizeService
  return cs?.width && cs?.height ? quantizeCell(cs.width, cs.height + 1) : null
}

export function TerminalShape({ shape }: ShapeBodyProps) {
  const { w, h, sessionId, title, gateway, fontSize } = terminalContentFrom(shape)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const suspendedRef = useRef(false)
  const [connection, setConnection] = useState<TerminalConnection>('connecting')
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({ fontSize, fontFamily: wm.mono, scrollback: 0, theme: paperTerminalTheme })
    term.open(container)
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
      if (disposed || ended || suspendedRef.current) return
      clearReconnectTimer()
      const previous = wsRef.current
      if (previous && previous.readyState < WebSocket.CLOSING) previous.close()

      setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
      const ws = new WebSocket(termWsUrl(sessionId, term.cols, term.rows, gateway))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
      }
      ws.onclose = () => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        if (disposed || ended || suspendedRef.current) return
        attempt++
        setConnection('disconnected')
        const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
        reconnectTimer = setTimeout(connect, exponential * (0.8 + Math.random() * 0.4))
      }
      ws.onerror = () => ws.close()
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg: { type?: string; cols?: number; rows?: number }
          try {
            msg = JSON.parse(ev.data)
          } catch {
            return
          }
          if ((msg.type === 'resize' || msg.type === 'attached') && msg.cols && msg.rows) {
            if (msg.type === 'attached') {
              term.reset() // gateway replays recent output after every attach
              setConnection('live')
            }
            term.resize(msg.cols, msg.rows)
          } else if (msg.type === 'exit') {
            ended = true
            setConnection('ended')
            term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n')
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer))
        }
      }
    }

    // Boot grid from the base-font cell, computed synchronously once xterm
    // has opened (charSizeService is populated at open() time for a font
    // already loaded/cached — a cold web-font load may under-measure by a
    // few px until the browser's next layout pass; the legacy file's async
    // remeasure-and-resize refines this further and is dropped here — see
    // module header).
    const cell = xtermCell(term)
    if (cell) {
      const { cols, rows } = gridFor(w, h, cell)
      term.resize(cols, rows)
    }

    term.onData((data) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    term.attachCustomKeyEventHandler((e) => {
      const ptyInput = ptyInputForKey(e)
      if (ptyInput) {
        e.preventDefault()
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: ptyInput }))
        return false
      }
      return true
    })

    connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
    // sessionId/gateway/fontSize changes remount the whole session — a
    // different sessionId is a DIFFERENT tmux pane, not a resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, gateway, fontSize])

  // Re-derive the deterministic grid whenever the shape's box changes
  // (independent of the connect effect, matching the legacy file's own
  // split between "mount the session" and "resize the box").
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const cell = xtermCell(term)
    if (!cell) return
    const { cols, rows } = gridFor(w, h, cell)
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows)
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [w, h])

  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {
      // Real bandwidth/CPU win, not a placeholder — see module header.
      onSuspend: () => {
        suspendedRef.current = true
        setConnection('suspended')
        wsRef.current?.close()
      },
      onResume: () => {
        suspendedRef.current = false
        // The mount effect's own `connect` isn't reachable here (out of
        // scope), so resuming re-triggers a WebSocket the same way a
        // reconnect would; the gateway's `attached` replay make this
        // gapless from the viewer's perspective.
        const term = termRef.current
        if (!term || wsRef.current) return
        setConnection('connecting')
        const ws = new WebSocket(termWsUrl(sessionId, term.cols, term.rows, gateway))
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            let msg: { type?: string; cols?: number; rows?: number }
            try {
              msg = JSON.parse(ev.data)
            } catch {
              return
            }
            if ((msg.type === 'resize' || msg.type === 'attached') && msg.cols && msg.rows) {
              if (msg.type === 'attached') {
                term.reset()
                setConnection('live')
              }
              term.resize(msg.cols, msg.rows)
            } else if (msg.type === 'exit') {
              setConnection('ended')
            }
          } else {
            term.write(new Uint8Array(ev.data as ArrayBuffer))
          }
        }
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null
        }
      },
    })
  }, [shape.id, sessionId, gateway])

  return (
    <div
      ref={rootRef}
      data-canvas-v2-shape="terminal"
      data-interaction-mode={mode}
      onDoubleClick={onDoubleClick}
      style={{
        width: w,
        height: h,
        position: 'relative',
        borderRadius: 4,
        overflow: 'hidden',
        background: '#fff',
        border: `1px solid ${mode === 'focused' ? wm.sealBlue : wm.ink}`,
        boxShadow: mode === 'focused' ? `0 0 0 1.5px ${wm.sealBlue}, ${wm.shadowPaper}` : wm.shadowPaper,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: '100%',
          paddingBottom: 4,
          fontFamily: wm.mono,
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: wm.sealBlue,
        }}
      >
        {title}
      </div>
      <div
        ref={containerRef}
        onPointerDown={swallow ? (e) => e.stopPropagation() : undefined}
        onKeyDown={swallow ? (e) => e.stopPropagation() : undefined}
        style={{
          position: 'absolute',
          inset: 0,
          padding: '10px 20px 4px 12px', // KEEP IN SYNC with grid.ts's TERMINAL_PAD
          opacity: connection === 'live' ? 1 : 0.28,
          pointerEvents: swallow ? 'auto' : 'none',
        }}
      />
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
            : connection === 'suspended'
              ? 'Off-screen — paused'
              : 'Connecting…'}
        </div>
      )}
      {mode === 'idle' && (
        <div
          style={{
            position: 'absolute',
            bottom: 4,
            right: 6,
            fontSize: 10,
            color: wm.inkSubtle,
            pointerEvents: 'none',
          }}
        >
          double-click to type
        </div>
      )}
    </div>
  )
}
