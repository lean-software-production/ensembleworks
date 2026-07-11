import { type CanvasDocument } from './document.js'
import { validateShape } from './shape.js'

export type InvariantRule = 'noOrphans' | 'noCycles' | 'noDanglingBindings' | 'validProps'
export interface Violation { rule: InvariantRule; id: string; detail: string }

// All four executable predicates in one pass. Pure; deterministic order (input
// order). The design's canvas-doc repair pass (Phase 2) will consume these.
export function checkInvariants(doc: CanvasDocument): Violation[] {
  const out: Violation[] = []
  const ids = new Set<string>(doc.shapes.map((s) => s.id))
  const pageIds = new Set<string>(doc.pages.map((p) => p.id))

  for (const s of doc.shapes) {
    // validProps (also catches a malformed envelope)
    const v = validateShape(s)
    if (!v.ok) out.push({ rule: 'validProps', id: s.id, detail: v.error })

    // noOrphans: parent must be an existing shape or page.
    const p = s.parentId
    if (!(ids.has(p) || pageIds.has(p))) out.push({ rule: 'noOrphans', id: s.id, detail: `missing parent ${p}` })
  }

  // noCycles: walking parents from each shape must reach a page within N steps.
  for (const s of doc.shapes) {
    const seen = new Set<string>()
    let cur: string | undefined = s.id
    while (cur && cur.startsWith('shape:')) {
      if (seen.has(cur)) { out.push({ rule: 'noCycles', id: s.id, detail: `cycle via ${cur}` }); break }
      seen.add(cur)
      cur = doc.byId.get(cur)?.parentId
    }
  }

  // noDanglingBindings: both endpoints must be existing shapes.
  for (const b of doc.bindings) {
    if (!ids.has(b.fromId)) out.push({ rule: 'noDanglingBindings', id: b.id, detail: `missing fromId ${b.fromId}` })
    if (!ids.has(b.toId)) out.push({ rule: 'noDanglingBindings', id: b.id, detail: `missing toId ${b.toId}` })
  }
  return out
}
