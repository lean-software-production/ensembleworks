import { LoroDoc, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import type { Shape } from '@ensembleworks/canvas-model'
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
  // parents), leave `n` where it is — its data.parentId is retained and a later
  // reparent pass (see bridge.ts loadModel) fixes placement.
  private placeInTree(n: LoroTreeNode, parentId: string): void {
    const current = n.parent()
    if (parentId.startsWith('page:')) {
      if (current) this.tree.move(n.id, undefined)
      return
    }
    const parent = this.nodeByShapeId(parentId)
    if (!parent) return
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
    let n = this.nodeByShapeId(s.id)
    if (!n) n = this.tree.createNode()
    const d = n.data
    d.set('shapeId', s.id); d.set('kind', s.kind); d.set('parentId', s.parentId)
    d.set('index', s.index); d.set('x', s.x); d.set('y', s.y)
    d.set('rotation', s.rotation); d.set('isLocked', s.isLocked); d.set('opacity', s.opacity)
    d.set('meta', s.meta as any); d.set(LoroCanvasDoc.PROP_KEY, s.props as any)
    this.placeInTree(n, s.parentId)
  }
  updateProps(id: string, props: Record<string, unknown>): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
    const cur = (n.data.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {}
    n.data.set(LoroCanvasDoc.PROP_KEY, { ...cur, ...props } as any)
  }
  deleteShape(id: string): void {
    const n = this.nodeByShapeId(id)
    if (n) this.tree.delete(n.id)
  }
  reparent(_id: string, _parentId: string, _index?: number): void { throw new Error('C3') }
  getText(_id: string): string { throw new Error('C4') }
  setText(_id: string, _t: string): void { throw new Error('C4') }

  exportSnapshot(): Uint8Array { return this.doc.export({ mode: 'snapshot' }) }
  exportUpdate(): Uint8Array { return this.doc.export({ mode: 'update' }) }
  import(bytes: Uint8Array): void { this.doc.import(bytes) }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  commit(): void { this.doc.commit() }
}
