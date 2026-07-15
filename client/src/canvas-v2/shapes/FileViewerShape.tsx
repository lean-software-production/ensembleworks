/**
 * canvas-v2 port of client/src/file-viewer/FileViewerShapeUtil.tsx — a file
 * from the agent home rendered as a sandboxed iframe portal (HTML reports,
 * rendered markdown, …), pointed at `/files/{path}`.
 *
 * PRESENT STORE: uses canvas-v2's OWN `presentStoreV2` (a plain get/set
 * module), NOT the legacy client/src/file-viewer/presentStore.ts — the
 * legacy store's tldraw `atom` pulled the whole tldraw package into the v2
 * import graph at module scope (quality-review finding; probe-measured
 * before/after in presentStoreV2.ts's header). The two stores are
 * INDEPENDENT by design — see presentStoreV2.ts for why that's acceptable
 * (one engine per room per user).
 *
 * RESTORED (Task D5, via the D2 `dispatch` channel — see TerminalShape.tsx's
 * module header for the same seam's first use, and ScreenshareShape.tsx's
 * for the D4 precedent):
 *   - ROOM-WIDE REFRESH: the legacy refresh button bumps the shape's synced
 *     `rev` prop via `editor.updateShape({ props: { rev: (shape.props.rev ??
 *     0) + 1 } })` (git history: `client/src/file-viewer/
 *     FileViewerShapeUtil.tsx`'s `refresh`) — every OTHER viewer's iframe
 *     `?rev=` query param changes with it, forcing a reload. This port's
 *     `refresh` now dispatches the equivalent `UpdateProps` intent (see
 *     `fileViewerRefreshIntent` below) instead of only bumping the LOCAL
 *     `nonce` — the room-wide propagation the legacy component had is back.
 *   - PEER-FOLLOW: the legacy component resolves a peer's presenting state
 *     via `presenterFor(editor.getCollaborators(), shape.id)` — tldraw's own
 *     awareness/collaborator API. `ShapeBodyProps` still has no `editor`/
 *     `toolContext`/presence handle, so this port instead reads
 *     `presentStoreV2.getPeers()`/`getSelfKey()` (a plain module accessor —
 *     the same "shared singleton, not a threaded prop" shape as
 *     `canvasV2EmbedLifecycles`, refreshed by CanvasV2App's existing
 *     presence-poll tick) through `presenterFor` (../presence.ts) — the same
 *     freshest-`ts`-wins resolution rule as the legacy `presenterFor`
 *     (git history: `client/src/file-viewer/followLogic.ts`), ported to
 *     canvas-sync's `Presence.presenting: string[]` wire field via
 *     `encodePresenting`/`decodePresenting`. A follower drives its iframe to
 *     the resolved peer's scroll fraction via the existing `postScrollSet`
 *     bridge. Publishing THIS viewer's own presenting state rides
 *     `presentStoreV2.getPublisher()` — the mount's live `PresencePublisher`
 *     — via its `setPresenting` method, which folds into the SAME combined
 *     `set()` write as viewport/cursor (see presence.ts's
 *     `setViewportAndRefreshCursor` doc comment for the same-millisecond LWW
 *     hazard this avoids). A named "who" (peer userName/color) is NOT
 *     restored — canvas-sync's wire carries no identity fields at all (see
 *     presence.ts's `adaptPresence` doc comment on that same gap for
 *     cursors); the legacy `FollowingChip`'s "Following <name>" UI and its
 *     per-presenter local opt-out are cut for this v1 port (cosmetic, no
 *     correctness stake — trivial to re-add once canvas-sync grows identity
 *     fields).
 *
 * EMBED, NO SUSPEND/RESUME HOOKS (documented, matching IframeShape's
 * rationale exactly — this IS an iframe): registers into the shared
 * registry (see ./index.ts's NEKO/FILE-VIEWER EMBED RECLASSIFICATION note
 * for why this kind is an embed at all) so its scroll position and iframe
 * document survive being culled off-screen; visibility:hidden already does
 * the preserving, so there is nothing to pause/resume.
 */
import { useEffect, useRef, useState } from 'react'
import type { Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '@ensembleworks/canvas-editor'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import { wm } from '../../theme.js'
import { presentStoreV2 as presentStore } from './presentStoreV2.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'
import { useInteractionMode } from './useInteractionMode.js'
import { presenterFor } from '../presence.js'

const HEADER_HEIGHT = 28

export interface FileViewerShapeContent {
  readonly w: number
  readonly h: number
  readonly path: string
  readonly title: string
  readonly rev: number
}

/** Pure props->render-input adapter (unit-tested in FileViewerShape.test.ts). */
export function fileViewerContentFrom(shape: Shape): FileViewerShapeContent {
  const p = shape.props as Record<string, unknown>
  const path = typeof p.path === 'string' ? p.path : ''
  return {
    w: typeof p.w === 'number' ? p.w : 720,
    h: typeof p.h === 'number' ? p.h : 540,
    path,
    title: typeof p.title === 'string' && p.title ? p.title : path || 'file viewer',
    rev: typeof p.rev === 'number' ? p.rev : 0,
  }
}

/**
 * Pure: the UpdateProps intent for a refresh action bumping the shared
 * `rev` prop — recovered legacy semantics (git history:
 * `client/src/file-viewer/FileViewerShapeUtil.tsx`'s `refresh`:
 * `editor.updateShape({ props: { rev: (shape.props.rev ?? 0) + 1 } })`).
 * Every peer's iframe `?rev=` query param (see `fileViewerContentFrom`'s
 * `rev` field and this component's iframe `src`) changes when this lands,
 * forcing a reload — a room-wide refresh, not a local one. Called ONLY from
 * the refresh button's `onClick` (an explicit user action), never from a
 * render/effect keyed on `rev` itself — that would be a bump-triggers-
 * rerender-triggers-bump loop; there is no such effect in this component.
 */
export function fileViewerRefreshIntent(id: string, currentRev: number): Intent {
  return { type: 'UpdateProps', id, props: { rev: currentRev + 1 } }
}

/**
 * Pure: what scroll fraction (if any) a follower should drive its iframe
 * to, given whether THIS viewer is itself presenting and the resolved peer
 * presenter (or `null`). A presenter never follows anyone — even if a
 * (stale/racy) peer entry also claims this shape, `isPresentingThis` always
 * wins locally, matching the legacy component's `!isPresentingThis &&
 * peerPresenter` guard. Returns `null` (no follow target) whenever there is
 * nothing to apply, so the caller's effect can no-op cleanly instead of
 * driving the iframe to a stale/undefined fraction.
 */
export function followTargetFraction(params: {
  readonly isPresentingThis: boolean
  readonly peer: { readonly fraction: number } | null
}): number | null {
  if (params.isPresentingThis) return null
  return params.peer ? params.peer.fraction : null
}

export function FileViewerShape({ shape, dispatch }: ShapeBodyProps) {
  const { w, h, path, title, rev } = fileViewerContentFrom(shape)
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastFractionRef = useRef(0)
  const [localNonce, setLocalNonce] = useState(0)
  const [isPresentingThis, setIsPresentingThis] = useState(() => presentStore.get()?.shapeId === shape.id)

  // Room-wide refresh (Task D5 — see module header's RESTORED note): bumps
  // the shared `rev` prop via the D2 `dispatch` channel so every peer's
  // iframe reloads, not just this one. Guarded against `dispatch` being
  // absent (fixtures/tests that omit it — see ShapeBodyProps.dispatch's own
  // doc comment) by the `dispatch?.(...)` no-op below; this is an onClick
  // handler, not a render/effect keyed on `rev`, so there is no bump loop to
  // guard against structurally.
  const refresh = () => {
    dispatch?.([fileViewerRefreshIntent(shape.id, rev)])
    setLocalNonce((n) => n + 1)
  }

  const postScrollSet = (fraction: number) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'ew-scroll-set', fraction }, '*')
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data as { type?: unknown; fraction?: unknown } | null
      if (!d || typeof d !== 'object') return
      if (d.type === 'ew-file-viewer-ready') {
        const mine = presentStore.get()
        if (mine && mine.shapeId === shape.id) postScrollSet(mine.fraction)
      } else if (d.type === 'ew-scroll' && typeof d.fraction === 'number') {
        lastFractionRef.current = d.fraction
        const mine = presentStore.get()
        if (mine && mine.shapeId === shape.id) {
          // Preserve the toggle-time ts — see the legacy component's
          // identical comment (an incumbent who keeps scrolling must not be
          // able to perpetually out-stamp a would-be successor).
          const next = { shapeId: shape.id, fraction: d.fraction, ts: mine.ts }
          presentStore.set(next)
          // Task D5: republish over the wire too — via the SAME combined
          // publisher used for viewport/cursor (setPresenting folds into
          // that ONE shared `set()`, never a second independent write —
          // see presence.ts's PresencePublisher.setPresenting doc comment).
          presentStore.getPublisher()?.setPresenting(next)
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [shape.id])

  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {})
  }, [shape.id])

  // Peer-follow (Task D5 — see module header's RESTORED note): resolve
  // whoever (other than this mount) is presenting THIS shape from the
  // presence-map accessor, then drive this iframe to their scroll fraction
  // whenever it (or their identity) changes. Deliberately does NOT call
  // `presentStore.set`/`getPublisher()?.setPresenting` from this path — a
  // follower's own re-render must never re-publish a "presenting" token
  // (that would both misrepresent a follower as a presenter AND, with two
  // followers of the same presenter, have each follower's re-render nudge
  // the other's resolved peer, a feedback loop between them). Only the
  // scroll-message handler above (gated on `mine.shapeId === shape.id`,
  // i.e. only ever true for the ACTUAL presenter) ever publishes.
  const peer = presenterFor(presentStore.getPeers(), presentStore.getSelfKey(), shape.id)
  const followFraction = followTargetFraction({ isPresentingThis, peer })
  useEffect(() => {
    if (followFraction !== null) postScrollSet(followFraction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followFraction, peer?.peerKey])

  const togglePresent = () => {
    if (isPresentingThis) {
      presentStore.set(null)
      presentStore.getPublisher()?.setPresenting(null)
      setIsPresentingThis(false)
    } else {
      const next = { shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() }
      presentStore.set(next)
      presentStore.getPublisher()?.setPresenting(next)
      setIsPresentingThis(true)
    }
  }

  return (
    <div
      ref={rootRef}
      data-canvas-v2-shape="file-viewer"
      data-interaction-mode={mode}
      onDoubleClick={onDoubleClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: w,
        height: h,
        borderRadius: 4,
        overflow: 'hidden',
        background: '#fff',
        border: mode === 'focused' ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ruleStrong}`,
        boxShadow: wm.shadowPaper,
      }}
    >
      <div
        onPointerDown={swallow ? (e) => e.stopPropagation() : undefined}
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
        }}
      >
        <span style={{ color: wm.ink, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <HeaderButton label="↻" title="Refresh (reloads for everyone)" onClick={refresh} />
          <HeaderButton
            label={isPresentingThis ? 'Presenting — stop' : 'Present'}
            title={isPresentingThis ? 'Stop presenting' : 'Present — others follow your scroll position'}
            active={isPresentingThis}
            onClick={togglePresent}
          />
        </span>
        {mode === 'idle' && <span style={{ opacity: 0.6 }}>double-click to interact</span>}
      </div>
      {path ? (
        <iframe
          ref={iframeRef}
          src={`/files/${path.split('/').map(encodeURIComponent).join('/')}?rev=${rev}&v2=${localNonce}`}
          title={title}
          style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', pointerEvents: swallow ? 'auto' : 'none' }}
          // SECURITY: no `allow-same-origin` — see the legacy component's
          // identical comment; unchanged here.
          sandbox="allow-scripts allow-forms allow-downloads"
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', color: wm.inkSubtle, fontFamily: wm.mono, fontSize: 11 }}>no file</div>
      )}
    </div>
  )
}

function HeaderButton(props: { label: string; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
      style={{
        border: 'none',
        background: props.active ? wm.sealBlue : 'transparent',
        borderRadius: 3,
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: props.active ? 700 : 400,
        color: props.active ? '#fff' : wm.inkMuted,
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {props.label}
    </button>
  )
}
