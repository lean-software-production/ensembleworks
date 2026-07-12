/**
 * canvas-v2 port of client/src/screenshare/ScreenShareShapeUtil.tsx — a
 * teammate's shared window/screen, attached from the LiveKit track named in
 * the shape's synced props.
 *
 * REUSED VERBATIM (imported, not forked): `useScreenShareTrack` from
 * client/src/screenshare/store.ts — the same module-level LiveKit-Room
 * registry + `useSyncExternalStore` hook the legacy shape uses, already
 * covered by resolve.test.ts/screenshare.test.ts/visibility.test.ts.
 * `SCREENSHARE_HEADER_HEIGHT` from helpers.ts.
 *
 * DROPPED for this v1 port (both require `editor.updateShape`, which a
 * shape body in this contract cannot call — see ./index.ts's
 * INTERACTIVE-CONTENT EVENT POLICY note): stamping a captured `lastFrame`
 * into the shared `stillUrl` prop so OTHER viewers/reloads see the
 * tombstone (kept as LOCAL-only in-memory state here — this viewer, while
 * mounted, still sees its own captured last frame); resize-driven aspect
 * relocking (`lockScreenShareAspect`, itself just math — resizing a shape at
 * all is a different seam's job here, not the body's).
 *
 * EMBED LIFECYCLE — onSuspend/onResume detach/reattach the LiveKit video
 * element from the track: the REAL bandwidth win the phase-3 plan calls out
 * by name. `track.attach()`/`track.detach()` (resolve.ts's `AttachableTrack`)
 * are exactly the LiveKit calls the legacy component already makes on
 * mount/unmount (see its `useEffect` over `track`) — this body just moves
 * that same detach/(re)attach pair onto the suspend/resume boundary instead
 * of mount/unmount, so an off-screen tile stops decoding video entirely
 * (LiveKit's subscription itself isn't touched here — a further, larger win
 * v1 leaves to AvOverlay's existing viewport-proximity subscription loop,
 * which already governs whether the SERVER even sends this viewer the
 * track; see visibility.ts).
 *
 * NO INTERACTION MODE: unlike its five siblings, this body never enters
 * 'focused' (no `useInteractionMode`) — matching the legacy component
 * exactly (`pointerEvents: 'none'`, its own comment: "no edit mode, unlike
 * neko — there's nothing to drive"). A screen share tile is display-only;
 * all interaction (move/resize/annotate) belongs to the canvas itself.
 */
import { useEffect, useRef, useState } from 'react'
import type { Shape } from '@ensembleworks/canvas-model'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import type { AttachableTrack } from '../../screenshare/resolve.js'
import { useScreenShareTrack } from '../../screenshare/store.js'
import { SCREENSHARE_HEADER_HEIGHT } from '../../screenshare/helpers.js'
import { wm } from '../../theme.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'

export interface ScreenshareShapeContent {
  readonly w: number
  readonly h: number
  readonly title: string
  readonly participantId: string
  readonly trackName: string
  readonly stillUrl: string | undefined
  readonly ownerColor: string | undefined
}

/** Pure props->render-input adapter (unit-tested in ScreenshareShape.test.ts). */
export function screenshareContentFrom(shape: Shape): ScreenshareShapeContent {
  const p = shape.props as Record<string, unknown>
  return {
    w: typeof p.w === 'number' ? p.w : 1280,
    h: typeof p.h === 'number' ? p.h : Math.round(1280 / (16 / 9)) + SCREENSHARE_HEADER_HEIGHT,
    title: typeof p.title === 'string' ? p.title : 'screen share',
    participantId: typeof p.participantId === 'string' ? p.participantId : '',
    trackName: typeof p.trackName === 'string' ? p.trackName : '',
    stillUrl: typeof p.stillUrl === 'string' ? p.stillUrl : undefined,
    ownerColor: typeof p.ownerColor === 'string' ? p.ownerColor : undefined,
  }
}

export function ScreenshareShape({ shape }: ShapeBodyProps) {
  const { w, h, title, participantId, trackName, stillUrl, ownerColor } = screenshareContentFrom(shape)
  const state = useScreenShareTrack(participantId, trackName)
  const track = state.kind === 'live' ? state.track : null
  const videoRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef<{ track: AttachableTrack; el: HTMLMediaElement } | null>(null)
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const suspendedRef = useRef(false)

  const attach = (t: AttachableTrack) => {
    const el = videoRef.current
    if (!el || attachedRef.current) return
    const video = t.attach() as HTMLVideoElement
    video.muted = true
    Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain', background: '#000' })
    el.appendChild(video)
    attachedRef.current = { track: t, el: video }
  }

  const detach = () => {
    const attached = attachedRef.current
    if (!attached) return
    if (attached.el instanceof HTMLVideoElement && attached.el.videoWidth > 0) {
      try {
        const scale = Math.min(1, 1280 / attached.el.videoWidth)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(attached.el.videoWidth * scale)
        canvas.height = Math.round(attached.el.videoHeight * scale)
        canvas.getContext('2d')?.drawImage(attached.el, 0, 0, canvas.width, canvas.height)
        setLastFrame(canvas.toDataURL('image/jpeg', 0.7))
      } catch {
        /* draw failed — the still/placeholder fallback covers it */
      }
    }
    attached.track.detach(attached.el)
    attached.el.remove()
    attachedRef.current = null
  }

  useEffect(() => {
    if (track && !suspendedRef.current) attach(track)
    return detach
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track])

  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {
      onSuspend: () => {
        suspendedRef.current = true
        detach()
      },
      onResume: () => {
        suspendedRef.current = false
        if (track) attach(track)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.id, track])

  const statusColor = state.kind === 'live' ? wm.ok : state.kind === 'connecting' ? wm.warn : wm.inkSubtle

  return (
    <div
      data-canvas-v2-shape="screenshare"
      data-screenshare={trackName}
      data-screenshare-state={state.kind}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: w,
        height: h,
        borderRadius: 4,
        overflow: 'hidden',
        background: '#000',
        border: ownerColor ? `4px solid ${ownerColor}` : `1px solid ${wm.ruleStrong}`,
        boxShadow: wm.shadowPaper,
        // Display-only tile: all interaction is the canvas's own (move/
        // resize/annotate) — see NO INTERACTION MODE above.
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: SCREENSHARE_HEADER_HEIGHT,
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
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor }} />
        <span style={{ color: wm.ink, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5 }}>{title}</span>
        <span style={{ opacity: 0.6, marginLeft: 'auto' }}>screen share · {state.kind}</span>
      </div>
      <div ref={videoRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state.kind !== 'live' && (lastFrame || stillUrl) && (
          <img
            src={lastFrame ?? stillUrl}
            alt="last shared frame"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          />
        )}
        {state.kind !== 'live' && !lastFrame && !stillUrl && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: wm.inkMuted, fontFamily: wm.mono, fontSize: 12 }}>
            {state.kind === 'connecting' ? 'connecting…' : 'share ended'}
          </div>
        )}
      </div>
    </div>
  )
}
