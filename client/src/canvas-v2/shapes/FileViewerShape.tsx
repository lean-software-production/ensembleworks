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
 * DROPPED for this v1 port, both are STRUCTURAL gaps (not cut for scope) —
 * this contract gives a shape body no way to reach them at all:
 *   - PEER-FOLLOW: the legacy component resolves a peer's presenting state
 *     via `presenterFor(editor.getCollaborators(), shape.id)` — tldraw's own
 *     awareness/collaborator API. `ShapeBodyProps` has no `editor`/
 *     `toolContext` handle, and canvas-v2's own presence surface (whatever
 *     canvas-sync eventually exposes) isn't wired to shape bodies yet. So
 *     THIS viewer can still toggle "I am presenting" (pure presentStore
 *     read/write, no editor needed), but following a PEER's scroll position
 *     is not reproduced here — deferred until shape bodies get a
 *     presence/collaborators read path (a future seam, not G2/Phase-4
 *     specific).
 *   - ROOM-WIDE REFRESH: the legacy refresh button bumps the shape's synced
 *     `rev` prop via `editor.updateShape`, which is a canvas-document
 *     mutation this contract's read-only `{ shape, snapshot, editorState }`
 *     cannot perform. This port's refresh button reloads LOCALLY only (a
 *     local `nonce` appended to the iframe src) — it no longer propagates
 *     to other viewers. Deferred for the same reason as terminal's
 *     title-rename and screenshare's stillUrl stamp-back: no shape body in
 *     this unit can mutate the document.
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
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import { wm } from '../../theme.js'
import { forwardPinchToCanvas, parsePinchMessage } from '../../file-viewer/pinchForward.js'
import { presentStoreV2 as presentStore } from './presentStoreV2.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'
import { useInteractionMode } from './useInteractionMode.js'

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

export function FileViewerShape({ shape }: ShapeBodyProps) {
  const { w, h, path, title, rev } = fileViewerContentFrom(shape)
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastFractionRef = useRef(0)
  const [localNonce, setLocalNonce] = useState(0)
  const [isPresentingThis, setIsPresentingThis] = useState(() => presentStore.get()?.shapeId === shape.id)

  // Local reload — see DROPPED above (no shared `rev` bump available here).
  const refresh = () => setLocalNonce((n) => n + 1)

  const postScrollSet = (fraction: number) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'ew-scroll-set', fraction }, '*')
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data as { type?: unknown; fraction?: unknown } | null
      if (!d || typeof d !== 'object') return
      const pinch = parsePinchMessage(d)
      if (pinch) {
        // Pinch over the interactive viewer zooms the CANVAS (spec:
        // 2026-07-15-pinch-zoom-guard-design.md) — replay on the iframe
        // element so it bubbles into the Viewport's wheel/zoom path.
        if (iframeRef.current) forwardPinchToCanvas(iframeRef.current, pinch)
        return
      }
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
          presentStore.set({ shapeId: shape.id, fraction: d.fraction, ts: mine.ts })
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [shape.id])

  useEffect(() => {
    return canvasV2EmbedLifecycles.register(shape.id, {})
  }, [shape.id])

  const togglePresent = () => {
    if (isPresentingThis) {
      presentStore.set(null)
      setIsPresentingThis(false)
    } else {
      presentStore.set({ shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() })
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
          <HeaderButton label="↻" title="Refresh (this viewer only — see module header)" onClick={refresh} />
          <HeaderButton
            label={isPresentingThis ? 'Presenting — stop' : 'Present'}
            title={isPresentingThis ? 'Stop presenting' : 'Present — a future seam will let others follow your scroll'}
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
