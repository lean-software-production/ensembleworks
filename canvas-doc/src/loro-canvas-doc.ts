import { LoroDoc, type LoroMap, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import type { Binding, Page, Shape } from '@ensembleworks/canvas-model'
import type { CanvasDoc } from './canvas-doc.js'

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
  deleteShape(id: string): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
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
  exportUpdate(): Uint8Array { return this.doc.export({ mode: 'update' }) }
  import(bytes: Uint8Array): void { this.doc.import(bytes) }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  commit(): void { this.doc.commit() }
}
