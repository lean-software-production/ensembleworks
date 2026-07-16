// The FSM runner: play a contract's seeded gesture through a REAL Editor + the
// select tool's FSM (via script.ts's run()), evaluating the invariant against
// an FSM-backed Obs adapter after every event (when: 'every-event') or once at
// the end (when: 'at-end'). Deterministic: the injected clock is fixed and the
// injected id source is the same seeded PRNG the gesture uses, so a failing
// seed reproduces exactly. Mirrors the design's "FSM runner beside the script()
// rig". The browser runner (e2e) interprets the SAME GestureOp[].
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { validateShape } from '@ensembleworks/canvas-model'
import type { Anchor, Contract, GestureOp, Obs, Rng } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { applyWheel } from '../camera.js'
import { Editor } from '../editor.js'
import type { InputEvent, Modifiers } from '../input.js'
import { screenToWorld } from '../input.js'
import { script } from '../script.js'
import { createSelectTool } from '../tools/select.js'
import { createToolContext } from '../tools/tool-context.js'

// A fixed viewport for FSM-level visibility observations. The browser runner
// reads the real viewport box instead; both must agree on the CONVENTION
// (screenToWorld of the four corners), not the exact pixel size.
const FSM_VIEWPORT = { w: 1280, h: 720 } as const

function mods(over?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }): Partial<Modifiers> {
  return { ...over }
}

function resolveAnchor(a: Anchor): { x: number; y: number } {
  // Phase A: only the absolute point form exists. Pilot 2 (Phase C) extends
  // this to resolve a shape anchor via worldToScreen(editor.get().camera, ...).
  return { x: a.x, y: a.y }
}

/** Turn the abstract gesture ops into a concrete InputEvent[] via script.ts's
 * builder (which stamps deterministic timestamps). */
function opsToEvents(ops: readonly GestureOp[]): InputEvent[] {
  const b = script()
  for (const op of ops) {
    switch (op.kind) {
      case 'down': { const p = resolveAnchor(op.at); b.down(p.x, p.y, { modifiers: mods(op.modifiers) }); break }
      case 'move': { const p = resolveAnchor(op.at); b.move(p.x, p.y, { steps: op.steps ?? 0, modifiers: mods(op.modifiers) }); break }
      case 'up': { b.up({ modifiers: mods(op.modifiers) }); break }
      case 'wheel': { const p = resolveAnchor(op.at); b.wheel(op.dx, op.dy, { at: [p.x, p.y], modifiers: mods(op.modifiers) }); break }
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

function makeObs(editor: Editor, startRect: { minX: number; minY: number; maxX: number; maxY: number }): Obs {
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
 * NOTE: the select tool is hardwired — a tool seam on Contract is a known
 * later extension (first contract needing another tool adds it). */
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
  const tool = createSelectTool(ctx)
  const startRect = visibleWorldRectOf(editor.get().camera)
  const obs = makeObs(editor, startRect)

  const events = opsToEvents(contract.gesture(rng))
  let state = tool.initialState
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
