import { LoroDoc, VersionVector, type LoroMap, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import { canonicalPageId, cascadeDropSet, makeDocument, repairPlan, type Binding, type Page, type RepairOp, type Shape } from '@ensembleworks/canvas-model'
import type { CanvasDoc, ImportResult } from './canvas-doc.js'

// Node.data layout: we store the whole model shape envelope as flat keys on the
// Loro tree node's data map. The tldraw/model shape id lives under 'shapeId'
// (the Loro TreeID is separate). Loro's movable tree owns parent/child/z-order.
export class LoroCanvasDoc implements CanvasDoc {
  private constructor(private doc: LoroDoc, private tree: LoroTree) {}

  static create(opts: { peerId: bigint }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'))
  }
  static fromSnapshot(bytes: Uint8Array, opts: { peerId: bigint }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    doc.import(bytes)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'))
  }

  // id → Loro node, resolved from the tree each call (cheap; correctness over caching).
  // PERF: an id→node index was suggested by review but deferred — revisit only if
  // this O(n) scan becomes a measured problem at real scale.
  protected nodeByShapeId(id: string): LoroTreeNode | undefined {
    return this.tree.nodes().find((n) => !n.isDeleted() && n.data.get('shapeId') === id)
  }
  // ALL non-deleted physical nodes tagged with this shapeId — normally exactly
  // one (nodeByShapeId's single-match assumption holds under ordinary usage),
  // but Loro's tree CRDT resolves conflicting structural ops per NODE
  // identity, not per our application-level shapeId convention layered on
  // top of it: under heavy concurrent churn across peers (independent
  // creates/moves racing on a shared id), the merge CAN converge into more
  // than one physical node sharing a shapeId (probe-proven by the E1
  // convergence rig — canvas-sync/src/convergence.test.ts). repair() uses
  // this (see below) so it reconciles EVERY duplicate, matching
  // applyRepairToModel (canvas-model/repair.ts), which operates over the
  // full shapes ARRAY and so never misses one either.
  private nodesByShapeId(id: string): LoroTreeNode[] {
    return this.tree.nodes().filter((n) => !n.isDeleted() && n.data.get('shapeId') === id)
  }

  // Make the Loro tree the single source of truth for hierarchy: move `n` so its
  // real tree parent matches `parentId`. A page id means "root". If parentId
  // names a shape that has no node yet (bulk load inserting children before
  // parents), detach `n` to a root — never leave it under a STALE real parent
  // (split-brain: data.parentId says X, tree says Y, and deleting Y would
  // cascade-delete a shape that logically moved away). data.parentId is
  // retained and a later reparent pass (see bridge.ts loadModel) fixes placement.
  private placeInTree(n: LoroTreeNode, parentId: string): void {
    const current = n.parent()
    if (parentId.startsWith('page:')) {
      if (current) this.tree.move(n.id, undefined)
      return
    }
    const parent = this.nodeByShapeId(parentId)
    if (!parent) { if (current) this.tree.move(n.id, undefined); return }
    if (!current || current.id !== parent.id) this.tree.move(n.id, parent.id)
  }

  private static PROP_KEY = '__props'

  private readNode(n: LoroTreeNode): Shape {
    const d = n.data
    return {
      id: d.get('shapeId') as string,
      kind: d.get('kind') as Shape['kind'],
      parentId: d.get('parentId') as any,
      index: d.get('index') as string,
      x: d.get('x') as number, y: d.get('y') as number,
      rotation: d.get('rotation') as number,
      isLocked: d.get('isLocked') as boolean,
      opacity: d.get('opacity') as number,
      meta: (d.get('meta') as Record<string, unknown>) ?? {},
      props: (d.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {},
    } as Shape
  }

  listShapes(): Shape[] {
    return this.tree.nodes().filter((n) => !n.isDeleted() && n.data.get('shapeId')).map((n) => this.readNode(n))
  }
  getShape(id: string): Shape | undefined {
    const n = this.nodeByShapeId(id)
    return n ? this.readNode(n) : undefined
  }
  putShape(s: Shape): void {
    // Placement FIRST, data second (same discipline as reparent): for an
    // existing node Loro's cycle guard throws if s.parentId names a real
    // descendant of it, and no data field may be modified in that case.
    // A freshly created node has no descendants, so its placement cannot cycle.
    let n = this.nodeByShapeId(s.id)
    if (!n) n = this.tree.createNode()
    this.placeInTree(n, s.parentId)
    const d = n.data
    d.set('shapeId', s.id); d.set('kind', s.kind); d.set('parentId', s.parentId)
    d.set('index', s.index); d.set('x', s.x); d.set('y', s.y)
    d.set('rotation', s.rotation); d.set('isLocked', s.isLocked); d.set('opacity', s.opacity)
    d.set('meta', s.meta as any); d.set(LoroCanvasDoc.PROP_KEY, s.props as any)
  }
  updateProps(id: string, props: Record<string, unknown>): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
    const cur = (n.data.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {}
    n.data.set(LoroCanvasDoc.PROP_KEY, { ...cur, ...props } as any)
  }
  // Node-level core of deleteShape, factored out so repair() can apply it to
  // EVERY physical node sharing an id (see nodesByShapeId) while the public
  // single-id deleteShape keeps its existing first-match behavior unchanged.
  private deleteNode(n: LoroTreeNode): void {
    // Collect the shapeIds of the whole real subtree before the cascade delete,
    // then clear each shape's text container. The emptied Loro container itself
    // persists as a CRDT tombstone (known bloat category per design); clearing
    // its content prevents text resurrection when a shape id is reused.
    const ids: string[] = []
    const collect = (node: LoroTreeNode): void => {
      const sid = node.data.get('shapeId') as string | undefined
      if (sid) ids.push(sid)
      for (const c of node.children() ?? []) collect(c)
    }
    collect(n)
    this.tree.delete(n.id)
    for (const sid of ids) {
      const t = this.doc.getText(this.textKey(sid))
      if (t.length > 0) t.delete(0, t.length)
    }
  }
  deleteShape(id: string): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
    this.deleteNode(n)
  }
  reparent(id: string, parentId: string, index?: number): void {
    const node = this.nodeByShapeId(id)
    if (!node) return
    // Resolve the target and perform the tree move FIRST: Loro's native cycle
    // guard throws if parentId names a descendant of id, and we must not touch
    // data.parentId if that happens.
    if (parentId.startsWith('page:')) {
      this.tree.move(node.id, undefined, index)
    } else {
      const parent = this.nodeByShapeId(parentId)
      if (!parent) throw new Error(`reparent: unknown parent ${parentId}`)
      this.tree.move(node.id, parent.id, index)
    }
    node.data.set('parentId', parentId)
  }
  // Each shape gets a dedicated LoroText container keyed by shape id. Full
  // ProseMirror binding is Phase 3; plain text proves the container this phase.
  private textKey(id: string): string { return `text:${id}` }
  /** Contract: missing shape → '' (guarded, not just "container never written"). */
  getText(id: string): string {
    if (!this.nodeByShapeId(id)) return ''
    return this.doc.getText(this.textKey(id)).toString()
  }
  setText(id: string, text: string): void {
    if (!this.nodeByShapeId(id)) return
    const t = this.doc.getText(this.textKey(id))
    t.delete(0, t.length)
    t.insert(0, text)
  }

  // Top-level LoroMaps keyed by id (bindings/pages are not tree-shaped, so a
  // flat map is the natural container — see A1 in the phase-2 plan).
  private bindings(): LoroMap { return this.doc.getMap('bindings') }
  private pages(): LoroMap { return this.doc.getMap('pages') }

  putBinding(b: Binding): void { this.bindings().set(b.id, b as any) }
  deleteBinding(id: string): void {
    const m = this.bindings()
    if (m.get(id) !== undefined) m.delete(id)
  }
  listBindings(): Binding[] {
    const m = this.bindings()
    return m.keys().map((k) => m.get(k) as Binding).filter(Boolean)
  }
  putPage(p: Page): void { this.pages().set(p.id, p as any) }
  deletePage(id: string): void {
    const m = this.pages()
    if (m.get(id) !== undefined) m.delete(id)
  }
  listPages(): Page[] {
    const m = this.pages()
    return m.keys().map((k) => m.get(k) as Page).filter(Boolean)
  }

  exportSnapshot(): Uint8Array { return this.doc.export({ mode: 'snapshot' }) }
  exportUpdate(sinceVersion?: Uint8Array): Uint8Array {
    if (!sinceVersion) return this.doc.export({ mode: 'update' })
    const from = VersionVector.decode(sinceVersion)
    return this.doc.export({ mode: 'update', from })
  }
  versionBytes(): Uint8Array { return this.doc.oplogVersion().encode() }
  import(bytes: Uint8Array): ImportResult {
    // Loro's ImportStatus.pending is Map<PeerID, CounterSpan> | null; collapse
    // to the engine-agnostic boolean (true iff there are actual pending spans).
    // ImportStatus.success maps each peer to the span of ops NEWLY APPLIED by
    // this call — probed against loro-crdt 1.13.6: a fresh import yields a
    // non-empty map, an exact repeat (or an empty-history update) yields an
    // EMPTY map, and a partial overlap lists only the newly-applied span. So
    // `changed` = success non-empty.
    const status = this.doc.import(bytes)
    return {
      pending: status.pending !== null && status.pending.size > 0,
      changed: status.success.size > 0,
    }
  }
  // Compute the model inline from this doc's own lists (not via bridge.ts's
  // dumpModel) to avoid a bridge↔impl import cycle: bridge.ts imports
  // LoroCanvasDoc for its type, so LoroCanvasDoc must not import bridge.ts back.
  //
  // PERF (measured, Phase 2 review): ~7.36ms/call at 1k shapes on a CLEAN doc
  // — i.e. that's the floor even when the plan is empty — with ~70% of it in
  // the three list*() WASM marshals above; cost is linear in doc size. Sync
  // peers therefore gate repair() on ImportResult.changed (no-op imports skip
  // it entirely). The deferred id→node index (see nodeByShapeId's PERF note)
  // is the lever if this floor ever matters at real scale.
  repair(): RepairOp[] {
    const model = makeDocument({ pages: this.listPages(), shapes: this.listShapes(), bindings: this.listBindings() })
    const plan = repairPlan(model)
    // dropAll = the plan's dropShape ids plus their transitive descendants in
    // the MODEL (shared cascadeDropSet — same fixpoint applyRepairToModel
    // runs, so the two applications cannot drift). It serves two purposes:
    // 1. Skip-set: a reparentToRoot op whose id is in dropAll is SKIPPED, so
    //    plan-application order can never matter — without the skip, applying
    //    reparent(descendant) before dropShape(ancestor) would move the
    //    descendant out of the doomed subtree and silently resurrect it,
    //    diverging from applyRepairToModel (which always drops it).
    // 2. Binding sweep: a binding whose endpoint is in dropAll becomes
    //    dangling MID-pass (it wasn't when the plan was computed, so the plan
    //    has no deleteBinding op for it); delete it here so a SINGLE repair()
    //    call converges — not only the second.
    const dropAll = cascadeDropSet(model.shapes, new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id)))
    // PERF: each deleteBinding/deleteShape/reparent below re-resolves its id
    // via the O(n) nodeByShapeId scan (see that method's deferred-index PERF
    // note), so a large plan costs O(n²). Same revisit-if-measured stance.
    for (const o of plan) {
      if (o.op === 'deleteBinding') this.deleteBinding(o.id)
      // dropShape/reparentToRoot are applied to EVERY physical node sharing
      // this id (nodesByShapeId), not just the first match — see that
      // method's comment: under concurrent churn there can be more than one,
      // and applyRepairToModel (the pure reference this must agree with)
      // operates over the full shapes array, so it never misses a duplicate
      // either. Normal (non-duplicated) docs see exactly one node here, so
      // this is behavior-preserving for every existing single-node case.
      else if (o.op === 'dropShape') for (const n of this.nodesByShapeId(o.id)) this.deleteNode(n) // cascade + text cleanup
      else if (o.op === 'reparentToRoot') {
        if (dropAll.has(o.id)) continue // claimed by a drop cascade — see above
        // 'page:orphans' is unreachable: repairPlan emits no reparentToRoot
        // ops for a zero-page doc (dead-code safety only).
        const pageId = canonicalPageId(model.pages) ?? 'page:orphans'
        for (const n of this.nodesByShapeId(o.id)) {
          this.tree.move(n.id, undefined) // page id ⇒ Loro root
          n.data.set('parentId', pageId)
        }
      }
    }
    for (const b of model.bindings) {
      if (dropAll.has(b.fromId) || dropAll.has(b.toId)) this.deleteBinding(b.id)
    }
    return plan
  }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void {
    return this.doc.subscribeLocalUpdates(listener)
  }
  commit(): void { this.doc.commit() }
}
