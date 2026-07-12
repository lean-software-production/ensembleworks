/**
 * canvas-v2 port of client/src/iframe/IframeShapeUtil.tsx — a sandboxed
 * iframe pointed at `shape.props.url` (dev servers proxied under /dev/{port}/,
 * docs, dashboards, …). REUSED FROM THE LEGACY BODY: `toProxiedUrl` isn't
 * needed here (the legacy component never actually calls it in its render —
 * it's exported for callers that create the shape, e.g. PasteUrlHandler —
 * out of scope for a shape BODY port). REWRITTEN: the header's reload/open-
 * in-new-tab buttons (no `editor` needed, pure DOM/window calls — ported
 * near-verbatim); the double-click-to-interact / title-bar-drag-to-move
 * affordance is REPLACED by this seam's own interaction-mode policy (see
 * interactionMode.ts) — dragging the shape itself is the new engine's
 * selection/move machinery's job (Viewport/a future select tool), not the
 * body's, so the legacy title-drag hack (which existed only to work around
 * tldraw's HTMLContainer swallowing drag gestures) has no equivalent here.
 *
 * EMBED, NO LIFECYCLE HOOKS (documented, per EmbedHost.tsx's VISIBLE-BUT-
 * HIDDEN note + this unit's own plan): an iframe's live state is its nested
 * document — visibility:hidden (EmbedHost's wrapper style) keeps that
 * document alive and simply un-paints it; there is nothing this body could
 * usefully pause/resume beyond what the browser already does for a hidden-
 * but-mounted iframe. It still REGISTERS into the shared lifecycle registry
 * (an empty hooks object) so (a) every embed shape is uniformly discoverable
 * through the one registry — a future devtool/watchdog can enumerate live
 * embeds by id without special-casing "kinds with no hooks" — and (b) this
 * is the seam's chosen representative body for proving the registration
 * wiring end-to-end for real (see IframeShape.test.ts + ./index.ts's
 * REGISTRATION ARCHITECTURE note).
 */
import { useEffect, useRef } from 'react'
import type { Shape } from '@ensembleworks/canvas-model'
import type { ShapeBodyProps } from '@ensembleworks/canvas-react'
import { wm } from '../../theme.js'
import { canvasV2EmbedLifecycles } from './embedLifecycles.js'
import { useInteractionMode } from './useInteractionMode.js'

const HEADER_HEIGHT = 28

export interface IframeShapeContent {
  readonly w: number
  readonly h: number
  readonly url: string
  readonly title: string
}

/** Pure props->render-input adapter (unit-tested in IframeShape.test.ts's
 * static-render assertions) — `shape.props` is an untyped bag
 * (canvas-model's `Shape.props: Record<string, unknown>`), so every body
 * needs exactly this kind of defensive read; centralised per-shape rather
 * than inlined so the mapping is one auditable function. */
export function iframeContentFrom(shape: Shape): IframeShapeContent {
  const p = shape.props as Record<string, unknown>
  return {
    w: typeof p.w === 'number' ? p.w : 800,
    h: typeof p.h === 'number' ? p.h : 600,
    url: typeof p.url === 'string' ? p.url : 'about:blank',
    title: typeof p.title === 'string' ? p.title : 'web view',
  }
}

export function IframeShape({ shape }: ShapeBodyProps) {
  const { w, h, url, title } = iframeContentFrom(shape)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { mode, swallow, rootRef, onDoubleClick } = useInteractionMode()

  useEffect(() => {
    // See module header: no onSuspend/onResume — an empty hooks object
    // still registers/unregisters, proving the wiring (this body is the
    // seam's chosen representative for that proof — see IframeShape.test.ts).
    return canvasV2EmbedLifecycles.register(shape.id, {})
  }, [shape.id])

  return (
    <div
      ref={rootRef}
      data-canvas-v2-shape="iframe"
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
          borderBottom: `1px solid ${wm.rule}`,
          userSelect: 'none',
        }}
      >
        <span style={{ color: wm.ink, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <HeaderButton
            label="↻"
            title="Reload"
            onClick={() => {
              if (frameRef.current) frameRef.current.src = url
            }}
          />
          <HeaderButton label="↗" title="Open in new tab" onClick={() => window.open(url, '_blank', 'noopener')} />
        </span>
        {mode === 'idle' && <span style={{ opacity: 0.6 }}>double-click to interact</span>}
      </div>
      <iframe
        ref={frameRef}
        src={url}
        title={title}
        style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', pointerEvents: swallow ? 'auto' : 'none' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      />
    </div>
  )
}

function HeaderButton(props: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
      style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: wm.inkMuted, padding: '0 2px' }}
    >
      {props.label}
    </button>
  )
}
