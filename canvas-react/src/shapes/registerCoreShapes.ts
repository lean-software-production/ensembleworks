// REGISTRATION for the core tldraw-parity shape bodies (C1-C4:
// NoteShape/FrameShape/TextShape/GeoShape; R1 added DrawShape) into
// canvas-react's own shapeRegistry. UNLIKE registerCanvasV2Shapes()
// (client/src/canvas-v2/shapes/index.ts) — which lives OUT-OF-PACKAGE
// because its six bodies hold real client-owned session state (xterm,
// LiveKit, the gateway WS, this app's identity/presence plumbing) — these
// bodies are plain, self-contained React components with no dependency
// beyond canvas-react's own ShapeBodyProps contract (shape/snapshot/
// editorState/getText), so they belong IN canvas-react, registered by
// canvas-react itself. See shapeRegistry.ts's FALLBACK POLICY header:
// before this function is called, note/frame/text/geo/draw are
// unregistered and render as the generic labeled BoxShape; calling it gives
// each its own dedicated body instead.
//
// NON-EMBED: all five use the two-argument `registerShape(kind, Component)`
// form, which defaults `{ embed: false }` (RegisterShapeOptions.embed) —
// none of these holds a live session/connection that needs the
// culling-safe EmbedHost/EmbedLayer lifecycle; ShapeLayer's plain
// cull-and-unmount treatment is exactly right for them, same as the
// legacy tldraw shape utils they port.
//
// IDEMPOTENT, mirroring registerCanvasV2Shapes()'s module-level guard: a
// second call is a silent no-op (registerShape itself is replace-semantics
// safe either way, but the guard additionally means a caller — CanvasV2App,
// hot-reload, a future second mount — never needs to reason about call
// count).
import { registerShape } from '../shapeRegistry.js'
import { NoteShape } from './NoteShape.js'
import { FrameShape } from './FrameShape.js'
import { TextShape } from './TextShape.js'
import { GeoShape } from './GeoShape.js'
import { DrawShape } from './DrawShape.js'

let registered = false

/** Register the core shape bodies (note/frame/text/geo/draw) into
 * canvas-react's shapeRegistry. Idempotent — a second call is a no-op. */
export function registerCoreShapes(): void {
  if (registered) return
  registered = true
  registerShape('note', NoteShape)
  registerShape('frame', FrameShape)
  registerShape('text', TextShape)
  registerShape('geo', GeoShape)
  registerShape('draw', DrawShape)
}
