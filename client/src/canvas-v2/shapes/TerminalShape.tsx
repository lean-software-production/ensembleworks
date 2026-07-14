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
 * CONNECTION WIRING — ONE MACHINE, ONE CONNECT PATH (restructured after a
 * quality review; see terminalConnection.ts's module header for the full
 * bug inventory of the previous two-effect version): ALL connect/retry/
 * suspend/resume/ended/dispose sequencing lives in terminalConnection.ts's
 * pure state machine, driven from the mount effect below. The machine's
 * monotonic EPOCH invalidates in-flight socket callbacks (every handler
 * tags its events with the epoch its socket was opened under; stale =
 * dropped), and `dispatchRef` exposes the ONE dispatch to the lifecycle-
 * registration effect — onResume therefore runs THE REAL connect (backoff
 * preserved, `ended` respected: resuming an ended session shows "Session
 * ended", never a fresh shell) instead of the hand-rolled second socket
 * path the review rejected.
 *
 * REWRITTEN vs the legacy component (which is one big inline component, not
 * exported hooks): DROPPED for this v1 port — WebGL-vs-DOM renderer
 * switching on edit/view, the zoom-counterscaled edit host, view-mode
 * sub-pixel fill compensation, OSC-52 clipboard bridging, and the
 * title-rename / title-drag-to-move affordance (the last of these needs
 * `editor.updateShape`, which a shape body in this contract cannot call at
 * all — see ./index.ts's INTERACTIVE-CONTENT EVENT POLICY note). These are
 * cosmetic/parity-polish, not the terminal's live-session substance; full
 * parity is G2-golden/Phase-4 territory. KEPT: xterm mounted once per
 * `sessionId`, WS connect with backoff reconnect, the shared deterministic
 * grid (measured once per mount — the legacy file's async web-font
 * remeasure is dropped for the same reason: it only refines an already-good
 * boot estimate), term.onData -> ws input forwarding, the Shift/Alt+Enter
 * -> newline translation, and the focus-swallow policy. fontSize is an
 * IN-PLACE update (`term.options.fontSize`, re-grid alongside the [w,h]
 * resize effect) — only sessionId/gateway remount the session.
 *
 * ESCAPE SEMANTICS (differs from the legacy double-Esc — know this before
 * chasing a "vim lost focus" bug report): under this seam's shared policy a
 * SINGLE Escape exits interactive mode (useInteractionMode's document-level
 * keydown listener), and because that listener never preventDefault/
 * stopPropagations the key, the SAME Escape still reaches xterm and is
 * forwarded to the PTY — vim/emacs/Claude Code see their Esc, the canvas
 * just also defocuses. The legacy double-Esc-within-350ms disambiguation
 * (single Esc stays in the terminal) is a documented global non-goal of the
 * v1 policy — see ./index.ts's INTERACTIVE-CONTENT EVENT POLICY.
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
import {
  createInitialState,
  reconnectDelayMs,
  transition,
  type TerminalConnAction,
  type TerminalConnEvent,
  type TerminalConnState,
  type TerminalConnStatus,
} from './terminalConnection.js'
import { useInteractionMode } from './useInteractionMode.js'

const MIN_W = 360
const MIN_H = 220

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
// (fontSize is the SHARED shape prop, so measuring at the current fontSize
// IS the base-font cell — the legacy component's zoom normalisation doesn't
// apply here because this port never zoom-scales the font.)
function xtermCell(term: Terminal): CellSize | null {
  const cs = (term as unknown as { _core?: { _charSizeService?: { width?: number; height?: number } } })._core
    ?._charSizeService
  return cs?.width && cs?.height ? quantizeCell(cs.width, cs.height + 1) : null
}

interface ConnDisplay {
  readonly status: TerminalConnStatus
  readonly attempt: number
}

export function TerminalShape({ shape }: ShapeBodyProps) {
  const { w, h, sessionId, title, gateway, fontSize } = terminalContentFrom(shape)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // THE one dispatch — set by the mount effect, consumed by the lifecycle-
  // registration effect (latest-ref pattern: registration must not remount
  // when the session remounts under it).
  const dispatchRef = useRef<((event: TerminalConnEvent) => void) | null>(null)
  // Unit 12 residual (b): SURVIVES a sessionId/gateway remount of the mount
  // effect below (a component-level ref persists across that effect
  // re-running on the SAME component instance — it only resets on a real
  // unmount, which is not this case). Toggled by the lifecycle-registration
  // effect's onSuspend/onResume, alongside the machine dispatch. Consulted by
  // the mount effect at connect time: without this, a sessionId/gateway
  // change that fires while the embed is off-screen and suspended would spin
  // up a BRAND NEW connection machine (createInitialState() -> 'connecting')
  // and unconditionally dispatch 'connect' — opening a live, invisible
  // WebSocket the user never asked to reconnect, and clobbering the correctly
  // -displayed "Off-screen — paused" with "Connecting…". See the mount effect
  // below for the skip-connect fix this drives.
  const suspendedRef = useRef(false)
  // Mount-time font only; later fontSize changes are applied in place by
  // the resize effect below, never by remounting the session.
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const [conn, setConn] = useState<ConnDisplay>({ status: 'connecting', attempt: 0 })
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({ fontSize: fontSizeRef.current, fontFamily: wm.mono, scrollback: 0, theme: paperTerminalTheme })
    term.open(container)
    termRef.current = term

    // ---- the machine driver: pure transitions in, real I/O out ----------
    // Unit 12 residual (b): if the embed was already suspended (off-screen)
    // when this effect fires — a sessionId/gateway change on a hidden
    // terminal — start the FRESH machine instance already in 'suspended'
    // rather than the default 'connecting', so the dispatch below can SKIP
    // connect entirely (see suspendedRef's doc comment above). epoch 0
    // matches createInitialState()'s own starting epoch; 'resume' only
    // requires status === 'suspended' to act, so a later onResume dispatches
    // correctly against this hand-set state exactly as it would against one
    // the machine itself produced.
    let state: TerminalConnState = suspendedRef.current
      ? { epoch: 0, status: 'suspended', attempt: 0 }
      : createInitialState()
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const execute = (action: TerminalConnAction): void => {
      switch (action.type) {
        case 'clearReconnect':
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = null
          break
        case 'closeSocket': {
          const previous = socket
          socket = null
          wsRef.current = null
          previous?.close()
          break
        }
        case 'openSocket':
          openSocket(action.epoch)
          break
        case 'scheduleReconnect':
          reconnectTimer = setTimeout(() => dispatch({ type: 'connect' }), reconnectDelayMs(action.attempt, Math.random()))
          break
        case 'deliver':
          break // handled by the dispatching onmessage handler itself
      }
    }

    const dispatch = (event: TerminalConnEvent) => {
      const result = transition(state, event)
      // Unit 12 residual (a): bail on setConn() when the transition was a
      // no-op — transition()'s `noop` helper (terminalConnection.ts) returns
      // the SAME state reference for an event that didn't change
      // status/attempt (pinned by terminalConnection.test.ts's
      // reference-identity assertion). A chatty PTY session dispatches a
      // 'message' event per data chunk, and while connected/open that's
      // ALWAYS a noop for display purposes (deliver is the only action) — the
      // previous unconditional setConn({...state}) minted a fresh object and
      // forced a React re-render on every single chunk for a value that
      // never changed.
      const changed = result.state !== state
      state = result.state
      if (changed) setConn({ status: state.status, attempt: state.attempt })
      for (const action of result.actions) execute(action)
      return result
    }

    const openSocket = (epoch: number): void => {
      const ws = new WebSocket(termWsUrl(sessionId, term.cols, term.rows, gateway))
      ws.binaryType = 'arraybuffer'
      socket = ws
      wsRef.current = ws
      ws.onerror = () => ws.close()
      // Every handler is tagged with THIS socket's epoch — the machine
      // drops anything stale (suspend/resume/reconnect bumped past it).
      ws.onclose = () => dispatch({ type: 'closed', epoch })
      ws.onmessage = (ev) => {
        const guard = dispatch({ type: 'message', epoch })
        if (!guard.actions.some((a) => a.type === 'deliver')) return // stale/disposed — never touches term
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
              dispatch({ type: 'opened', epoch }) // 'open' means ATTACHED — see terminalConnection.ts
            }
            term.resize(msg.cols, msg.rows)
          } else if (msg.type === 'exit') {
            dispatch({ type: 'exit', epoch })
            term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n')
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer))
        }
      }
    }
    // ----------------------------------------------------------------------

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

    dispatchRef.current = dispatch
    // Unit 12 residual (b): SKIP connect (rather than connect-then-suspend)
    // when the embed was already suspended going into this remount — the
    // simplest correct option that opens zero sockets for a hidden embed.
    // conn's initial React state may still read a previous 'suspended' value
    // from before the remount (useState isn't reset by this effect re-running
    // on the same component instance), but reflect it explicitly here too
    // (harmless if redundant, correct if this is this component's very first
    // mount already suspended — e.g. a shape created off-screen).
    if (suspendedRef.current) setConn({ status: state.status, attempt: state.attempt })
    else dispatch({ type: 'connect' })

    return () => {
      dispatch({ type: 'dispose' }) // closes socket, clears timers, makes every in-flight handler stale
      dispatchRef.current = null
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
    // ONLY sessionId/gateway remount the session — a different sessionId is
    // a DIFFERENT tmux pane. fontSize is applied in place below; w/h resize
    // in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, gateway])

  // Re-derive the deterministic grid whenever the shape's box OR the shared
  // font size changes. fontSize is set in place first (an xterm options
  // update — no session teardown), then the cell is re-measured at the new
  // font and the grid re-derived, matching the legacy component's
  // "fontSize is a shared prop, changing it re-grids for every client"
  // semantics without its zoom machinery.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
    const cell = xtermCell(term)
    if (!cell) return
    const { cols, rows } = gridFor(w, h, cell)
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows)
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [w, h, fontSize])

  // Lifecycle registration: suspend/resume go through THE machine — the
  // same connect path, backoff, and ended-guard as everything else (the
  // review's finding 1..3/5 fix; see terminalConnection.ts). Deps are
  // [shape.id] only: dispatchRef is a latest-ref, so a session remount
  // (sessionId change) does not churn the registration.
  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {
      // suspendedRef is set BEFORE dispatching — see its declaration above:
      // a sessionId/gateway change that races a suspend/resume must see the
      // flag as of the CURRENT lifecycle call, not a stale one from before
      // this event.
      onSuspend: () => {
        suspendedRef.current = true
        dispatchRef.current?.({ type: 'suspend' })
      },
      onResume: () => {
        suspendedRef.current = false
        dispatchRef.current?.({ type: 'resume' })
      },
    })
  }, [shape.id])

  const overlayText =
    conn.status === 'ended'
      ? 'Session ended'
      : conn.status === 'suspended'
        ? 'Off-screen — paused'
        : conn.attempt > 0
          ? `Connection lost — reconnecting (${conn.attempt})…`
          : 'Connecting…'

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
          opacity: conn.status === 'open' ? 1 : 0.28,
          pointerEvents: swallow ? 'auto' : 'none',
        }}
      />
      {conn.status !== 'open' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(250,250,247,0.45)',
            color: conn.status === 'ended' ? wm.crit : wm.inkMuted,
            fontFamily: wm.mono,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1,
            pointerEvents: 'none',
          }}
        >
          {overlayText}
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
