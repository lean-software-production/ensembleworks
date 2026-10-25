// Task K (docs/plans/2026-07-22-canvas-v2-assets-image.md) — the browser
// contract that discharges the presence gate for the whole assets/image
// sub-cycle (M1/M2/A1/E1's model/doc/intent layers, R1's canvas-react/
// ImageShape, U1/C1/W1/W2's client/canvas-v2/ upload+drop+paste-image
// wiring): drop a tiny fixture image onto empty canvas and assert a new
// shape of kind 'image' now exists, is selected, and its `assetId` resolves
// to a REAL stored `/uploads/...` src — proving the upload actually
// happened, not merely that a shape got created.
//
// LEVEL: browser (not fsm) — the create path is a DOM drop handler
// (CanvasV2App.tsx's onDrop, W1), not a tool FSM; the FSM runner has no DOM
// to drop a file onto (see fsm-runner.ts's `dropFile` throw-stub in
// opsToEvents). This also introduces the `dropFile` GestureOp (there was no
// file-drop primitive in the shared vocabulary before this task) and the
// `assetSrc` Obs (both real in both adapters — assetSrc reads doc state,
// not the DOM, so it needs no throw-stub at either level).
//
// FIXTURE: a hand-built, hand-verified 2x2 RGB PNG (77 bytes) embedded as a
// data URL — no external fixture file, no network beyond the real
// `/uploads` PUT the drop handler's upload-then-create flow (C1) performs.
//
// DISCOVERING THE CREATED SHAPE'S ID: same pattern as
// draw-creates-a-draw-shape / armed-style-applies-to-created-shape — the
// image shape's id is minted from real entropy (image-create.ts's `mintId`,
// `crypto.getRandomValues`), so this contract cannot predict it up front. It
// rides `createImageFromBlob`'s own auto-selection (C1 batches
// `SetSelection([shape.id])` into the same atomic
// PutAsset+CreateShape+SetSelection commit) via `selectedShapeIds()`.
//
// ASYNC SETTLING: `when: 'at-end'` — the browser runner's `pollUntilPass`
// (AT_END_POLL_TIMEOUT_MS, 10s) absorbs the real upload PUT + doc commit +
// render round-trip; no mock, no fake clock.
//
// EMPTY SCENE, DELIBERATELY: no seeded shapes — the dropped image must be
// the only shape alive when `check` runs, so `shapeCount() === 1` is itself
// part of the assertion that a shape was really created.
//
// RED (Obligation 2/4 — see the plan's K task for the full discipline): the
// genuine, clean RED is reached by reverting W1's `onDrop` wiring in
// CanvasV2App to a no-op — the viewport still renders (so the `dropFile`
// op's anchor still resolves and the drop dispatch succeeds), but no image
// is created, so `shapeCount()` stays 0 and `selectedShapeIds()` stays `[]`:
// a clean ASSERTION failure, never a locator error. Reaching the RED by
// removing the viewport instead would throw a locator error at drop-dispatch
// time — a FAKE red that proves nothing about this contract's own
// assertions (same discipline as the draw/line contracts' own REDs).
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// A minimal, hand-verified 2x2 RGB PNG (77 bytes) — decodes to four solid
// pixels (red/green/blue/yellow); no external fixture file needed.
const IMG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM////ZwAAHu8E/KPItPcAAAAASUVORK5CYII='

export const droppingAnImageCreatesAnImageShape: Contract = {
  name: 'dropping-an-image-creates-an-image-shape',
  level: 'browser',
  when: 'at-end',
  // No seeded shapes — see module header's EMPTY SCENE note.
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // Well clear of the toolbar (top) and any panel.
    { kind: 'dropFile', at: { ref: 'point', x: 520, y: 400 }, dataUrl: IMG_DATA_URL, mimeType: 'image/png', name: 'fixture.png' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape after dropping an image, got ${JSON.stringify(ids)}`
    }
    if (obs.shapeCount() !== 1) {
      return `expected shapeCount 1 after one image, got ${obs.shapeCount()}`
    }
    const kind = obs.shapeKind(ids[0]!)
    if (kind !== 'image') {
      return `expected the created shape ${ids[0]} to be kind 'image', got ${JSON.stringify(kind)}`
    }
    const src = obs.assetSrc(ids[0]!)
    if (typeof src !== 'string' || !src.startsWith('/uploads/')) {
      return `expected the image's assetId to resolve to an /uploads src, got ${JSON.stringify(src)}`
    }
    return null
  },
}
