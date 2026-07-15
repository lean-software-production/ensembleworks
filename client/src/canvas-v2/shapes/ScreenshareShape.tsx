/**
 * canvas-v2 port of client/src/screenshare/ScreenShareShapeUtil.tsx — a
 * teammate's shared window/screen, attached from the LiveKit track named in
 * the shape's synced props.
 *
 * REUSED VERBATIM (imported, not forked): `useScreenShareTrack` +
 * `getScreenShareRoom` from client/src/screenshare/store.ts — the same
 * module-level LiveKit-Room registry + `useSyncExternalStore` hook the
 * legacy shape uses, already covered by resolve.test.ts/screenshare.test.ts/
 * visibility.test.ts. `SCREENSHARE_HEADER_HEIGHT`/`lockScreenShareAspect`
 * from helpers.ts.
 *
 * RESTORED (Task D4, via the D2 `dispatch` channel — see TerminalShape.tsx's
 * module header for the same seam's first use): (a) stamping a captured
 * `lastFrame` back into the shared `stillUrl` prop, so OTHER viewers/reloads
 * see the tombstone too, not just this session's in-memory capture, and (b)
 * relocking the tile's box to the captured surface's true aspect when the
 * attached video's own intrinsic dimensions change mid-share. Both were
 * previously permanently dropped ("requires `editor.updateShape`, which a
 * shape body in this contract cannot call") — `dispatch` is exactly that
 * missing write seam. See `screenshareStampIntent` / `screenshareAspectRelockIntent`
 * below for the recovered legacy rule + math, cited against
 * `git show main:client/src/screenshare/ScreenShareShapeUtil.tsx` and
 * `client/src/screenshare/share.ts`.
 * STILL DROPPED for this v1 port: the header's freeze-warning tooltip ("A
 * minimized or fully covered source window may freeze — keep it visible on
 * the sharer's machine") — cosmetic, cut for scope, trivial to re-add.
 * KEPT (restored after review — these are pure LOCAL track-state UI, no
 * dependency on the stillUrl stamp-back): the ended/paused badge chip over
 * the still frame and the grayscale/brightness "this is a still, not a live
 * feed" filter on ended tiles — see `screenshareStillTreatment` below (pure,
 * unit-tested).
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
import type { Intent } from '@ensembleworks/canvas-editor'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import type { AttachableTrack } from '../../screenshare/resolve.js'
import { getScreenShareRoom, useScreenShareTrack } from '../../screenshare/store.js'
import { SCREENSHARE_HEADER_HEIGHT, lockScreenShareAspect } from '../../screenshare/helpers.js'
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

/** Pure not-live still treatment (unit-tested in ScreenshareShape.test.ts):
 * what badge + CSS filter the still frame gets for a given non-live track
 * state — same values as the legacy component's inline expressions. An
 * 'ended' tile reads as a still, not a live feed (grayscale + dimmed, badge
 * "share ended"); any other non-live state ('connecting' — e.g. between
 * subscription cycles while a frame is already held) reads as "paused". */
export function screenshareStillTreatment(kind: 'connecting' | 'ended'): { label: string; filter: string | undefined } {
  return kind === 'ended'
    ? { label: 'share ended', filter: 'grayscale(0.5) brightness(0.8)' }
    : { label: 'paused', filter: undefined }
}

/** Pure: the (at most one) UpdateProps intent to stamp a captured last-frame
 * URL back into the shared `stillUrl` prop, so peers/reloads see the
 * tombstone too — not just this viewer, whose capture would otherwise live
 * only in local React state (the gap this file's header names). Mirrors
 * legacy's stamp effect (`git show main:client/src/screenshare/
 * ScreenShareShapeUtil.tsx` ~L176-199) condition-for-condition:
 *  - only once the track has actually ENDED (never a merely-paused/
 *    `connecting` gap between subscription cycles);
 *  - only when this viewer captured a `lastFrame` at all;
 *  - SINGLE-WRITER, exactly legacy's own rule: only the PRESENTER's client
 *    stamps (`localParticipantId === participantId` — legacy: `if
 *    (getScreenShareRoom()?.localParticipant.identity !== participantId)
 *    return`). Every OTHER viewer captured the identical final frame too; if
 *    all of them also stamped, that's N simultaneous writers racing the same
 *    prop — a multiplayer write storm, not a tombstone. The presenter is the
 *    only client guaranteed to both hold the frame and own the share, so
 *    it's the one designated writer;
 *  - the STAMP-LOOP GUARD the plan names: no-ops when `nextStillUrl` is
 *    already the shape's current `stillUrl` — a same-value dispatch would
 *    just re-render this body, re-observe the same ended/lastFrame state,
 *    and re-dispatch forever. */
export function screenshareStampIntent(params: {
  readonly id: string
  readonly trackKind: 'live' | 'connecting' | 'ended'
  readonly lastFrame: string | null
  readonly currentStillUrl: string | undefined
  readonly localParticipantId: string | null | undefined
  readonly participantId: string
  readonly nextStillUrl: string
}): Intent | null {
  const { id, trackKind, lastFrame, currentStillUrl, localParticipantId, participantId, nextStillUrl } = params
  if (trackKind !== 'ended') return null
  if (!lastFrame) return null
  if (localParticipantId !== participantId) return null
  if (nextStillUrl === currentStillUrl) return null
  return { type: 'UpdateProps', id, props: { stillUrl: nextStillUrl } }
}

// Half-pixel: comfortably below any real relock delta, but absorbs float
// rounding noise from the `w / aspect` division so a converged tile never
// re-dispatches an UpdateProps that (modulo rounding) changes nothing.
const ASPECT_RELOCK_EPSILON = 0.5

/** Pure: the (at most one) UpdateProps intent to relock a screenshare
 * tile's box to the captured surface's true aspect ratio, keyed off the
 * ATTACHED video element's own intrinsic dimensions (the browser fires a
 * `resize` event on a `<video>` whenever `videoWidth`/`videoHeight` change —
 * e.g. the sharer resizing the captured window mid-share).
 *
 * Reuses `lockScreenShareAspect` VERBATIM (screenshare/helpers.ts — the same
 * math the legacy `ScreenShareShapeUtil`'s `onResize` used for a *user*-
 * driven box drag, ~L100-108) called with `prevW===currentW`/
 * `prevH===currentH` — since nothing about the BOX changed, only the video's
 * aspect, `lockScreenShareAspect`'s "which dimension changed more" branch
 * (`abs(h-prevH) > abs(w-prevW)`) is `0 > 0`, always false, so it always
 * takes the width-led arm: keep the tile's width, recompute height from the
 * NEW aspect. That is exactly legacy's OTHER relock path — share.ts's 1s
 * `mediaTrack.getSettings()` poll on the SHARER's local capture
 * (`propsForAspect(props.w, nextAspect)`, ~L100-114) — now event-driven off
 * the actual attached track instead of polled, and routed through this
 * port's one write seam (`dispatch`) instead of `editor.updateShape`.
 *
 * SINGLE-WRITER: gated the same way as `screenshareStampIntent` — only the
 * PRESENTER's client relocks. Every viewer's attached video (self-preview or
 * remote) reports the same intrinsic dimensions and would compute the
 * identical corrected box, so letting every viewer ALSO dispatch would be a
 * redundant multi-writer race on the same prop; the presenter is legacy's
 * designated single source of truth for this tile's true proportions.
 *
 * Returns null — the RELOCK-LOOP GUARD the plan names — when the video has
 * no usable intrinsic size yet, or the corrected box is within
 * `ASPECT_RELOCK_EPSILON` of the CURRENT props (so a `dispatch` that
 * changes nothing never fires — otherwise a converged tile would
 * re-observe the same video dimensions on every fired `resize` event and
 * re-dispatch forever). */
export function screenshareAspectRelockIntent(params: {
  readonly id: string
  readonly currentW: number
  readonly currentH: number
  readonly videoWidth: number
  readonly videoHeight: number
  readonly localParticipantId: string | null | undefined
  readonly participantId: string
}): Intent | null {
  const { id, currentW, currentH, videoWidth, videoHeight, localParticipantId, participantId } = params
  if (localParticipantId !== participantId) return null
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null
  const aspect = videoWidth / videoHeight
  const locked = lockScreenShareAspect(currentW, currentH, currentW, currentH, aspect)
  if (Math.abs(locked.w - currentW) < ASPECT_RELOCK_EPSILON && Math.abs(locked.h - currentH) < ASPECT_RELOCK_EPSILON) {
    return null
  }
  return { type: 'UpdateProps', id, props: { w: locked.w, h: locked.h } }
}

/** Uploads a captured last-frame data URL to the same `/uploads` PUT
 * convention as dropped canvas images (assetStore.ts) and legacy's own
 * stamp effect — never inline a base64 frame into the synced CRDT doc
 * itself (a ~100KB+ data URL replicated to every peer and retained in doc
 * history, for a JPEG that only ever needs fetching once). Deterministic id
 * from `trackName` (`screen:<uuid>` → `screenstill-<uuid>`, same derivation
 * as legacy) so re-stamping the same share is idempotent, not that this
 * body ever tries to: `screenshareStampIntent`'s loop guard means a
 * successful upload only ever dispatches once per share. Impure/networked —
 * exercised live, not by this file's unit tests (see the header's SSR/DOM
 * limitation note); D6 E2E territory. */
async function uploadScreenshareStill(dataUrl: string, trackName: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const id = `screenstill-${trackName.slice('screen:'.length)}`
  const res = await fetch(`/uploads/${id}`, { method: 'PUT', body: blob })
  if (!res.ok) throw new Error(`screenshare still upload failed: ${res.status}`)
  return `/uploads/${id}`
}

export function ScreenshareShape({ shape, dispatch }: ShapeBodyProps) {
  const { w, h, title, participantId, trackName, stillUrl, ownerColor } = screenshareContentFrom(shape)
  const state = useScreenShareTrack(participantId, trackName)
  const track = state.kind === 'live' ? state.track : null
  const videoRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef<{ track: AttachableTrack; el: HTMLMediaElement; onResize: () => void } | null>(null)
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const suspendedRef = useRef(false)
  // Latest box + local identity, read from the video's `resize` listener —
  // that listener is registered once per attach (inside `attach`, itself
  // stable across renders via the closure captured at attach time) but must
  // always relock against the CURRENT tile size and CURRENT room identity,
  // not whatever was current the moment the track first attached.
  const boxRef = useRef({ w, h })
  useEffect(() => {
    boxRef.current = { w, h }
  }, [w, h])

  const attach = (t: AttachableTrack) => {
    const el = videoRef.current
    if (!el || attachedRef.current) return
    const video = t.attach() as HTMLVideoElement
    video.muted = true
    Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain', background: '#000' })
    el.appendChild(video)
    // Aspect relock (Task D4): the browser fires `resize` on a <video>
    // whenever its intrinsic videoWidth/videoHeight change (e.g. the
    // sharer's captured window itself being resized mid-share). See
    // `screenshareAspectRelockIntent`'s doc comment for the recovered
    // legacy math + the single-writer rationale.
    const onResize = () => {
      if (!dispatch) return
      const intent = screenshareAspectRelockIntent({
        id: shape.id,
        currentW: boxRef.current.w,
        currentH: boxRef.current.h,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        localParticipantId: getScreenShareRoom()?.localParticipant.identity,
        participantId,
      })
      if (intent) dispatch([intent])
    }
    video.addEventListener('resize', onResize)
    attachedRef.current = { track: t, el: video, onResize }
  }

  const detach = () => {
    const attached = attachedRef.current
    if (!attached) return
    attached.el.removeEventListener('resize', attached.onResize)
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

  // Stamp-back (Task D4): once the track has ENDED and this viewer captured
  // a lastFrame, the PRESENTER's client (single-writer — see
  // `screenshareStampIntent`) uploads it and dispatches the resulting URL
  // into the shared `stillUrl` prop, so a peer who never saw the stream (or
  // this same viewer after a reload) still sees the tombstone. The
  // `!stillUrl` pre-check is a cheap skip of the network round-trip;
  // `screenshareStampIntent` is the actual (testable) stamp-loop guard right
  // before dispatch.
  useEffect(() => {
    if (!dispatch) return
    if (state.kind !== 'ended' || !lastFrame || stillUrl) return
    const localParticipantId = getScreenShareRoom()?.localParticipant.identity
    if (localParticipantId !== participantId) return
    let cancelled = false
    ;(async () => {
      try {
        const uploaded = await uploadScreenshareStill(lastFrame, trackName)
        if (cancelled) return
        const intent = screenshareStampIntent({
          id: shape.id,
          trackKind: state.kind,
          lastFrame,
          currentStillUrl: stillUrl,
          localParticipantId,
          participantId,
          nextStillUrl: uploaded,
        })
        if (intent) dispatch([intent])
      } catch {
        /* best-effort, same as legacy — this viewer's in-memory frame still shows */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.kind, lastFrame, stillUrl, participantId, trackName, shape.id, dispatch])

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
          <>
            <img
              src={lastFrame ?? stillUrl}
              alt="last shared frame"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                background: '#000',
                filter: screenshareStillTreatment(state.kind).filter,
              }}
            />
            <span
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                padding: '2px 8px',
                borderRadius: 3,
                background: 'rgba(17,17,17,0.75)',
                color: wm.cream,
                fontFamily: wm.mono,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              {screenshareStillTreatment(state.kind).label}
            </span>
          </>
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
