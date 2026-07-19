// The FSM runner: play a contract's seeded gesture through a REAL Editor + the
// select tool's FSM (via script.ts's run()), evaluating the invariant against
// an FSM-backed Obs adapter after every event (when: 'every-event') or once at
// the end (when: 'at-end'). Deterministic: the injected clock is fixed and the
// injected id source is the same seeded PRNG the gesture uses, so a failing
// seed reproduces exactly. Mirrors the design's "FSM runner beside the script()
// rig". The browser runner (e2e) interprets the SAME GestureOp[].
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { centroid, localBounds, medianSize, validateShape, worldBounds, type CanvasDocument } from '@ensembleworks/canvas-model'
import type { Anchor, Contract, GestureOp, Obs, Rng } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { applyWheel } from '../camera.js'
import { Editor } from '../editor.js'
import type { InputEvent, Modifiers, Tool } from '../input.js'
import { screenToWorld, worldToScreen } from '../input.js'
import { script } from '../script.js'
import { createSelectAndTransformTool } from '../tools/select-and-transform.js'
import { createSelectTool } from '../tools/select.js'
import { createToolContext } from '../tools/tool-context.js'

// A fixed viewport for FSM-level visibility observations. The browser runner
// reads the real viewport box instead; both must agree on the CONVENTION
// (screenToWorld of the four corners), not the exact pixel size.
const FSM_VIEWPORT = { w: 1280, h: 720 } as const

function mods(over?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }): Partial<Modifiers> {
  return { ...over }
}

/** A minimal `.byId`-only CanvasDocument adapter over LIVE `editor.doc.
 * getShape` reads — mirrors editor.ts's own (private) `liveDocAdapter` (same
 * rationale: worldBounds/worldTransform touch nothing on `doc` except
 * `.byId.get`, so this shim is enough without going through the ToolContext's
 * cached snapshot). Kept package-local rather than imported: editor.ts does
 * not export its helper (and the editor's internals are not a dependency
 * surface the contracts runner should reach into). */
function liveDocAdapter(editor: Editor): CanvasDocument {
  return {
    pages: [], shapes: [], bindings: [],
    byId: { get: (id: string) => editor.doc.getShape(id) } as unknown as CanvasDocument['byId'],
  }
}

function resolveAnchor(a: Anchor, editor: Editor): { x: number; y: number } {
  if (a.ref === 'point') return { x: a.x, y: a.y }
  // Pilot 2 (Phase C): a seeded shape's centre, plus an optional SCREEN-space
  // offset — resolved against the shape's CURRENT world position at the
  // moment the gesture is turned into events (before any of it plays), via
  // worldToScreen(camera, centre).
  const shape = editor.doc.getShape(a.id)
  if (!shape) throw new Error(`resolveAnchor: no seeded shape with id ${JSON.stringify(a.id)}`)
  const centre = centroid(worldBounds(liveDocAdapter(editor), shape))
  const screen = worldToScreen(editor.get().camera, centre)
  return { x: screen.x + (a.dx ?? 0), y: screen.y + (a.dy ?? 0) }
}

/** Turn the abstract gesture ops into a concrete InputEvent[] via script.ts's
 * builder (which stamps deterministic timestamps). */
function opsToEvents(ops: readonly GestureOp[], editor: Editor): InputEvent[] {
  const b = script()
  for (const op of ops) {
    switch (op.kind) {
      case 'down': { const p = resolveAnchor(op.at, editor); b.down(p.x, p.y, { modifiers: mods(op.modifiers) }); break }
      case 'move': { const p = resolveAnchor(op.at, editor); b.move(p.x, p.y, { steps: op.steps ?? 0, modifiers: mods(op.modifiers) }); break }
      case 'up': { b.up({ modifiers: mods(op.modifiers) }); break }
      case 'wheel': { const p = resolveAnchor(op.at, editor); b.wheel(op.dx, op.dy, { at: [p.x, p.y], modifiers: mods(op.modifiers) }); break }
      case 'key': { b.key(op.key, { modifiers: mods(op.modifiers) }); break }
    }
  }
  return b.events()
}

function visibleWorldRectOf(camera: { readonly x: number; readonly y: number; readonly z: number }): { minX: number; minY: number; maxX: number; maxY: number } {
  const tl = screenToWorld(camera, { x: 0, y: 0 })
  const br = screenToWorld(camera, { x: FSM_VIEWPORT.w, y: FSM_VIEWPORT.h })
  return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
}

function makeObs(
  editor: Editor,
  startRect: { minX: number; minY: number; maxX: number; maxY: number },
  startPositions: ReadonlyMap<string, { x: number; y: number }>,
  startSizes: ReadonlyMap<string, { w: number; h: number }>,
  getGrabWorld: () => { x: number; y: number } | null,
  getLastPointer: () => { x: number; y: number } | null,
): Obs {
  return {
    visibleWorldRect() {
      return visibleWorldRectOf(editor.get().camera)
    },
    visibleWorldRectAtStart() {
      // Defensive copy — matches visibleWorldRect()'s fresh-object behavior,
      // so this consume-only Obs property is structural, not a shared live
      // reference a caller could accidentally mutate out from under the
      // runner's own captured baseline.
      return { ...startRect }
    },
    shapeDisplacement(id: string) {
      // NOTE: compares raw shape.x/y (LOCAL coords) — local == world here only
      // because seedScene parents every shape directly to page:p, unrotated.
      const start = startPositions.get(id)
      if (!start) throw new Error(`shapeDisplacement: no seeded shape with id ${JSON.stringify(id)}`)
      const shape = editor.doc.getShape(id)
      // TOLERANCE: a vanished shape (mid-gesture remote delete) has moved
      // nowhere FURTHER since it vanished — same "no throw, degrade" posture
      // select.ts's own TOLERANCE CONTRACT documents.
      if (!shape) return { dx: 0, dy: 0 }
      return { dx: shape.x - start.x, dy: shape.y - start.y }
    },
    shapeSizeDelta(id: string) {
      const start = startSizes.get(id)
      if (!start) throw new Error(`shapeSizeDelta: no seeded shape with id ${JSON.stringify(id)}`)
      const shape = editor.doc.getShape(id)
      // TOLERANCE: a vanished shape (mid-gesture remote delete) — same
      // degrade-not-throw posture as shapeDisplacement just above.
      if (!shape) return { dw: 0, dh: 0 }
      const lb = localBounds(shape)
      return { dw: lb.maxX - start.w, dh: lb.maxY - start.h }
    },
    cursorWorldDisplacement() {
      const grab = getGrabWorld()
      const pointer = getLastPointer()
      if (!grab || !pointer) return { dx: 0, dy: 0 } // no pointer gesture has started yet
      const cursorWorld = screenToWorld(editor.get().camera, pointer)
      return { dx: cursorWorld.x - grab.x, dy: cursorWorld.y - grab.y }
    },
    snapRadius() {
      // Mirrors canvas-model/src/snapping.ts's ACTUAL (un-exported) threshold
      // exactly: 5% of medianSize(doc.shapes) — that module's
      // `SNAP_THRESHOLD_K = 0.05`. NOT medianSize/5 (which would read 20 at
      // a 100-unit medianSize instead of the real 5) — verified against
      // select.test.ts's own fixture comment ("100x100 ... within the
      // 5-unit threshold": 100 * 0.05 = 5, not 100 / 5 = 20).
      return medianSize(editor.doc.listShapes()) * 0.05
    },
    textSelectionSpans() {
      // Pilot 3 is browser-only (types.ts's Obs.textSelectionSpans doc
      // comment): native text selection is a DOM/global-Selection-API
      // concept the FSM has no notion of. A browser-tagged contract never
      // reaches this adapter (library.test.ts filters CONTRACTS to
      // level: 'fsm' before calling runContractFsm) — this throw is a
      // defensive backstop, not a reachable path today.
      throw new Error('not observable at fsm level')
    },
    editingShape() {
      return editor.get().editingId
    },
    on() {
      // Pilot 5 is browser-only (types.ts's Obs.on/peerEditingIndicator doc
      // comments): a REMOTE peer's rendered editing indicator is a DOM
      // concept the FSM has no notion of — there is no second FSM instance
      // to observe from, and this runner drives exactly one Editor. A
      // browser-tagged contract never reaches this adapter (library.test.ts
      // filters CONTRACTS to level: 'fsm' before calling runContractFsm) —
      // this throw is a defensive backstop, matching textSelectionSpans'
      // established not-reachable-today posture.
      throw new Error('multi-actor observation unavailable at fsm level')
    },
    peerEditingIndicator() {
      throw new Error('not observable at fsm level')
    },
  }
}

function seedScene(doc: LoroCanvasDoc, contract: Contract): void {
  doc.putPage({ id: 'page:p', name: 'P' })
  for (const s of contract.scene?.() ?? []) {
    // SceneShape's id/kind are plain strings (the contracts module is pure and
    // cannot import the model's branded types), so the seam validates here —
    // a malformed id prefix or unknown kind must fail LOUDLY at seeding time,
    // never reach the doc as a silently malformed shape.
    const v = validateShape({
      id: s.id, kind: s.kind, parentId: 'page:p', index: 'a1',
      x: s.x, y: s.y, rotation: 0, isLocked: false, opacity: 1, meta: {},
      props: { w: s.w, h: s.h },
    })
    if (!v.ok) throw new Error(`seedScene: invalid SceneShape ${JSON.stringify(s.id)} (kind ${JSON.stringify(s.kind)}): ${v.error}`)
    doc.putShape(v.shape)
  }
  doc.commit()
}

export interface FsmRunResult {
  readonly contract: string
  readonly seed: number
  readonly failure: string | null
}

/** Run one contract at one seed through the FSM. Returns the first invariant
 * failure (with the seed for repro) or null.
 * NOTE: `contract.level` is ignored here — Phase G wires level filtering (which
 * runner runs which declarations); callers today pass fsm-level contracts.
 * NOTE: the tool is chosen by contract.tool (Phase E extension's TOOL SEAM
 * below) — 'select' by default, 'select+transform' for handle-drag
 * contracts. The former "hardwired select tool" limitation is discharged. */
export function runContractFsm(contract: Contract, seed: number): FsmRunResult {
  const rng: Rng = mulberry32(seed)
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  seedScene(doc, contract)
  // Injected clock/PRNG: fixed clock, and an id source derived from a SECOND
  // seeded stream so run() stays deterministic without consuming the gesture's
  // own rng draws.
  const idRng = mulberry32(seed ^ 0x9e3779b9)
  const editor = new Editor({ doc, now: () => 0, random: () => idRng.next(), pageId: 'page:p' })
  const ctx = createToolContext(editor)
  // TOOL SEAM (Phase E extension): build the FSM the contract asks for.
  // Default 'select'; 'select+transform' drives the SAME composite the client
  // ships (createSelectAndTransformTool) so a handle-drag contract exercises
  // the real dispatch — transform.ts gets first crack at each pointerdown,
  // exactly as in the browser.
  const tool: Tool<unknown> = contract.tool === 'select+transform'
    ? (createSelectAndTransformTool(ctx) as Tool<unknown>)
    : (createSelectTool(ctx) as Tool<unknown>)
  const startRect = visibleWorldRectOf(editor.get().camera)

  // Drag-observation baseline (Pilot 2): each seeded shape's START world
  // position, captured ONCE right after seeding (before the gesture plays);
  // the cursor's GRAB world point, captured at the gesture's FIRST 'down'
  // event; and the most recent pointer/wheel SCREEN position seen so far.
  // Together these let shapeDisplacement/cursorWorldDisplacement report
  // TOTAL displacement from gesture start — never a per-event increment
  // (that accumulation is exactly the drift C2/C3 exist to catch).
  const startPositions = new Map<string, { x: number; y: number }>()
  for (const shape of doc.listShapes()) startPositions.set(shape.id, { x: shape.x, y: shape.y })
  const startSizes = new Map<string, { w: number; h: number }>()
  for (const shape of doc.listShapes()) {
    const lb = localBounds(shape)
    startSizes.set(shape.id, { w: lb.maxX, h: lb.maxY }) // localBounds is {0,0,w,h} — geometry.ts's contract
  }
  let grabWorld: { x: number; y: number } | null = null
  let lastPointer: { x: number; y: number } | null = null

  const obs = makeObs(editor, startRect, startPositions, startSizes, () => grabWorld, () => lastPointer)

  const events = opsToEvents(contract.gesture(rng), editor)
  let state: unknown = tool.initialState
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
    // Wheel events are NOT consumed by the select tool (it ignores them) — the
    // runner applies the camera policy itself so a scroll contract observes a
    // camera change, mirroring CanvasV2App.handleInput's wheel branch.
    if (event.type === 'wheel') {
      const next = applyWheel(editor.get().camera, event)
      editor.apply({ type: 'SetCamera', ...next })
    }
    if (event.type === 'pointerdown' || event.type === 'pointermove' || event.type === 'pointerup' || event.type === 'wheel') {
      if (event.type === 'pointerdown' && grabWorld === null) {
        // NOTE: the runner captures grabWorld at POINTERDOWN, while the select
        // tool anchors at the threshold-crossing MOVE — a future contract that
        // zooms between down and first move must align these two capture points.
        grabWorld = screenToWorld(editor.get().camera, { x: event.x, y: event.y })
      }
      lastPointer = { x: event.x, y: event.y }
    }
    if (contract.when === 'every-event') {
      const failure = contract.check(obs)
      if (failure) return { contract: contract.name, seed, failure }
    }
  }
  if (contract.when === 'at-end') {
    const failure = contract.check(obs)
    if (failure) return { contract: contract.name, seed, failure }
  }
  return { contract: contract.name, seed, failure: null }
}
