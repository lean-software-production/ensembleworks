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
  protected nodeByShapeId(id: string): LoroTreeNode | undefined {
    return this.tree.nodes().find((n) => !n.isDeleted() && n.data.get('shapeId') === id)
  }

  listShapes(): Shape[] { return [] }       // C2
  getShape(_id: string): Shape | undefined { return undefined } // C2
  putShape(_s: Shape): void { throw new Error('C2') }
  updateProps(_id: string, _p: Record<string, unknown>): void { throw new Error('C2') }
  deleteShape(_id: string): void { throw new Error('C2') }
  reparent(_id: string, _parentId: string, _index?: number): void { throw new Error('C3') }
  getText(_id: string): string { throw new Error('C4') }
  setText(_id: string, _t: string): void { throw new Error('C4') }

  exportSnapshot(): Uint8Array { return this.doc.export({ mode: 'snapshot' }) }
  exportUpdate(): Uint8Array { return this.doc.export({ mode: 'update' }) }
  import(bytes: Uint8Array): void { this.doc.import(bytes) }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  commit(): void { this.doc.commit() }
}
