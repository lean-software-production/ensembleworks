/**
 * canvas-v2 port of client/src/neko/NekoShapeUtil.tsx — a shared browser
 * (neko container on the VM, real Firefox on a virtual display streamed over
 * WebRTC) embedded as a same-origin iframe, auto-logged-in under this
 * viewer's own canvas identity.
 *
 * REUSED: `peekIdentity` from client/src/identity.ts (never prompts — safe
 * for a render path).
 *
 * DUPLICATED, NOT IMPORTED (a deliberate exception to "reuse, don't fork" —
 * documented rather than silent): `NEKO_DEFAULT_BASE`, `NEKO_USER_PASSWORD`,
 * `buildNekoSrc`, `NEKO_SPLASH_CSS`, `NEKO_HEADER_HEIGHT` below are copied
 * from NekoShapeUtil.tsx rather than imported from it, because that file is
 * one `tldraw`-coupled module (`BaseBoxShapeUtil` and the constants share a
 * file) — importing from it would transitively pull tldraw's shape-util
 * machinery into this seam's shape body for the sake of a handful of
 * one-line pure constants/functions, and this unit's "new files only" scope
 * means NekoShapeUtil.tsx cannot be split to fix that (extracting its pure
 * half into its own module, the way screenshare/helpers.ts already is,
 * would modify a live file this unit must leave untouched). If this
 * duplication becomes a maintenance burden, promoting neko's pure pieces
 * into their own module — mirroring screenshare/helpers.ts — is the fix, but
 * is out of this unit's scope.
 *
 * DROPPED for this v1 port (cosmetic, or `editor`-dependent — same
 * structural gap as every other body's DROPPED section): the aspect-lock
 * resize math (`lockNekoAspect` — resizing is a different seam's job here);
 * the reload/open-in-new-tab header buttons (trivial to re-add, cut only
 * for scope).
 *
 * EMBED LIFECYCLE — onSuspend/onResume pause/resume the mute-enforcement
 * polling interval (see below): this is the live, real session state this
 * port found on re-reading the legacy code (see ./index.ts's NEKO/
 * FILE-VIEWER EMBED RECLASSIFICATION note) — a same-origin iframe streaming
 * a live WebRTC session via neko's own container. The iframe's document
 * (and the WebRTC connection inside it) is preserved by EmbedHost's
 * visibility:hidden exactly like the plain iframe shape; the interval is a
 * small additional CPU cost (400ms polling) worth pausing while off-screen.
 */
import { useEffect, useRef, useState } from 'react'
import type { Shape } from '@ensembleworks/canvas-model'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import { peekIdentity } from '../../identity.js'
import { wm } from '../../theme.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'
import { useInteractionMode } from './useInteractionMode.js'

// See DUPLICATED, NOT IMPORTED above.
const NEKO_USER_PASSWORD = 'neko'
export const NEKO_SPLASH_CSS = '.connect{display:none!important}'
const NEKO_HEADER_HEIGHT = 28
const NEKO_VIDEO_RATIO = 720 / 1280
const NEKO_DEFAULT_W = 2000

/** Re-measure schedule for the layout nudge (ms after iframe load) — same
 * values as the legacy onFrameLoad's loop: neko's player measures its
 * container only on a window 'resize' event, and on first mount it can
 * latch onto a transient layout (the first-mount flicker a manual resize
 * later clears); the spread covers neko's async mount + a cold WebRTC
 * connect taking a couple of seconds. Exported for NekoShape.test.ts —
 * the schedule is the PURE part of the nudge (the dispatch itself needs a
 * live iframe; see the test's coverage note). */
export const NEKO_NUDGE_DELAYS_MS = [0, 250, 750, 1500, 3000] as const

export function buildNekoSrc(base: string, viewerName: string): string {
  const q = `usr=${encodeURIComponent(viewerName)}&pwd=${encodeURIComponent(NEKO_USER_PASSWORD)}&embed=1`
  return base.includes('?') ? `${base}&${q}` : `${base}?${q}`
}

export interface NekoShapeContent {
  readonly w: number
  readonly h: number
  readonly base: string
  readonly title: string
}

/** Pure props->render-input adapter (unit-tested in NekoShape.test.ts). */
export function nekoContentFrom(shape: Shape): NekoShapeContent {
  const p = shape.props as Record<string, unknown>
  return {
    w: typeof p.w === 'number' ? p.w : NEKO_DEFAULT_W,
    h: typeof p.h === 'number' ? p.h : Math.round(NEKO_DEFAULT_W * NEKO_VIDEO_RATIO + NEKO_HEADER_HEIGHT),
    base: typeof p.base === 'string' ? p.base : '/shared-browser/',
    title: typeof p.title === 'string' ? p.title : 'shared browser',
  }
}

export function NekoShape({ shape }: ShapeBodyProps) {
  const { w, h, base, title } = nekoContentFrom(shape)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const src = useRef(buildNekoSrc(base, peekIdentity().name)).current
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()
  const prefMuted = useRef(true)
  const [muted, setMuted] = useState(true)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Pending layout-nudge timers (see NEKO_NUDGE_DELAYS_MS) — tracked so a
  // reload re-arms a fresh batch and unmount clears any still pending (the
  // legacy component leaked these across unmount; fixed in this port).
  const nudgeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const getVideo = (): HTMLVideoElement | null => {
    try {
      return frameRef.current?.contentDocument?.querySelector('video') ?? null
    } catch {
      return null
    }
  }

  const startPolling = () => {
    if (pollingRef.current) return
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
    pollingRef.current = setInterval(() => {
      const v = getVideo()
      if (v !== managed) {
        managed?.removeEventListener('volumechange', enforce)
        managed = v
        managed?.addEventListener('volumechange', enforce)
      }
      enforce()
    }, 400)
  }
  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }

  useEffect(() => {
    startPolling()
    return () => {
      stopPolling()
      // Clear any still-pending layout nudges (a late nudge after unmount
      // would dereference a dead iframe ref — harmless but sloppy).
      for (const t of nudgeTimersRef.current) clearTimeout(t)
      nudgeTimersRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {
      onSuspend: stopPolling,
      onResume: startPolling,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.id])

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

  // neko's player measures its container only on a window 'resize' event —
  // same-origin lets us dispatch one into the iframe to force a clean
  // re-measure (re-implemented from the legacy nudgeNekoLayout; the helper
  // itself lives inside the tldraw-coupled NekoShapeUtil.tsx and is not
  // importable without dragging tldraw in — see DUPLICATED, NOT IMPORTED).
  const nudgeNekoLayout = () => {
    try {
      frameRef.current?.contentWindow?.dispatchEvent(new Event('resize'))
    } catch {
      /* contentWindow not reachable yet — the next nudge (or a real resize) covers it */
    }
  }

  const onFrameLoad = () => {
    try {
      const win = frameRef.current?.contentWindow
      if (win) (win as unknown as { Audio: unknown }).Audio = SilentAudio
      const doc = frameRef.current?.contentDocument
      if (doc && !doc.getElementById('ew-neko-splash')) {
        const style = doc.createElement('style')
        style.id = 'ew-neko-splash'
        style.textContent = NEKO_SPLASH_CSS
        doc.head.appendChild(style)
      }
    } catch {
      /* content* not reachable yet — cosmetic only */
    }
    // Re-measure across neko's async mount + WebRTC stream start (which can
    // be a couple of seconds on a cold connect) — see NEKO_NUDGE_DELAYS_MS.
    // A reload (onLoad firing again) clears the previous batch first.
    for (const t of nudgeTimersRef.current) clearTimeout(t)
    nudgeTimersRef.current = NEKO_NUDGE_DELAYS_MS.map((delay) => setTimeout(nudgeNekoLayout, delay))
  }

  return (
    <div
      ref={rootRef}
      data-canvas-v2-shape="neko"
      data-interaction-mode={mode}
      onDoubleClick={onDoubleClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: w,
        height: h,
        borderRadius: 4,
        overflow: 'hidden',
        background: '#000',
        border: mode === 'focused' ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ruleStrong}`,
        boxShadow: wm.shadowPaper,
      }}
    >
      <div
        onPointerDown={swallow ? (e) => e.stopPropagation() : undefined}
        style={{
          height: NEKO_HEADER_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          background: wm.panel,
          color: wm.inkMuted,
          fontFamily: wm.mono,
          fontSize: 10,
        }}
      >
        <span style={{ color: wm.ink, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5 }}>{title}</span>
        <span style={{ opacity: 0.6 }}>shared browser · neko</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            title={muted ? 'Unmute audio' : 'Mute audio'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleMute}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: wm.inkMuted }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </span>
        {mode === 'idle' && <span style={{ opacity: 0.6 }}>double-click to drive</span>}
      </div>
      <iframe
        ref={frameRef}
        src={src}
        title={title}
        onLoad={onFrameLoad}
        allow="autoplay; clipboard-read; clipboard-write"
        style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', pointerEvents: swallow ? 'auto' : 'none' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-pointer-lock"
      />
    </div>
  )
}

// No-op stand-in for the iframe's `Audio` constructor — silences neko's
// chat.mp3 join/notification sound (see the legacy component's own
// SilentAudio for the full rationale; identical here).
function SilentAudio() {
  return {
    play: () => Promise.resolve(),
    pause: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    load: () => {},
  }
}
