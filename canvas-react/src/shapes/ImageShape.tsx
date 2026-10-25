// The `image` body (Task R1 — canvas-v2 ASSETS + IMAGE sub-cycle, D-6).
// Replaces `image`'s BoxShape fallback with a real render: resolve
// `props.assetId` against `snapshot.assetById` (A1's asset map, wired
// through `makeDocument`/`dumpModel` — `ShapeBodyProps.snapshot` already
// carries the whole `CanvasDocument`, so no new prop threading is needed
// here) to find the ASSET record's `props.src`, and paint an `<img>` when a
// src resolves. `data-shape-body="image"` is set unconditionally (resolved
// or not) — the same "always tag the wrapper" convention as every other
// *-shape body (DrawShape/LineShape/GeoShape/...), so a caller can always
// find/identify this body regardless of asset-resolution state.
//
// READS `snapshot` (forfeits content-memo — see shapeRegistry.ts's MEMO
// STRATEGY header): acceptable here per D-6, a plain <img> holds no heavy
// session state worth memoizing around.
//
// GRACEFUL STATES (never throw, per D-6 + the mutant table):
//   - no assetId, OR assetId not found in assetById, OR the resolved asset
//     has no (string) `props.src` → a placeholder div, NO <img> element at
//     all. This is the "asset not yet synced / unresolved" case — most
//     visibly, the brief moment between CreateShape landing (assetId set)
//     and the PutAsset intent's record actually being present in a peer's
//     doc, which the upload-THEN-create flow (D-5) makes rare but not
//     impossible on a slow peer.
//   - a broken image (`src` resolves but the byte fetch 404s/decodes
//     nothing) → per D-6, MVP does NOT add onError machinery; the browser's
//     own broken-image glyph is an acceptable degraded state this cycle.
//
// SIZING: the <img> fills its wrapper at width/height:100% with
// object-fit:contain — ShapeBody.tsx sizes THIS body's own outer wrapper
// (not built here) to the shape's localBounds, which geometry.ts's generic
// branch derives from props.w/h (a bare image with w/h gets exact bounds; a
// w/h-less v1 image falls back to the documented 100x100 loose-bounds
// default, same gap as line/draw). So sizing is delegated entirely to the
// wrapper — the <img> itself carries no shape-specific pixel dimensions,
// only the 100%/100%/object-fit contract, which is why it looks identical
// across differently-sized shapes (see image-shape.test.ts's sizing block).
//
// draggable={false}: prevents the browser's native HTML5 image-drag
// gesture from fighting this canvas's own pointer-based shape-drag.
//
// XSS note (D-6, constraint 5): a foreign/untrusted asset.props.src flows
// into <img src>. An <img src> does not execute script — a `javascript:`
// URL in img src is inert in modern browsers, and nothing here uses
// srcdoc/innerHTML — so a hostile src is a broken image at worst. The
// schema's string-typed src (D-1) plus this note is the posture; no
// sanitization beyond "it is a string" is warranted.
import type { ShapeBodyProps } from '../shapeRegistry.js'

export function ImageShape({ shape, snapshot }: ShapeBodyProps) {
  const props = shape.props as Record<string, unknown>
  const assetId = typeof props.assetId === 'string' ? props.assetId : undefined
  const asset = assetId ? snapshot.assetById.get(assetId) : undefined
  const src = typeof asset?.props?.src === 'string' ? asset.props.src : undefined

  if (src === undefined) {
    return (
      <div
        data-shape-body="image"
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          border: '1px dashed #999',
          background: '#f0f0f0',
        }}
      />
    )
  }

  return (
    <div data-shape-body="image" style={{ width: '100%', height: '100%' }}>
      <img
        src={src}
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}
