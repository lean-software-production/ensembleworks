// Run: bun src/node-index.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
})

// --- correctness parity: index resolves the same node the scan would ---
const a = LoroCanvasDoc.create({ peerId: 1n })
for (let i = 0; i < 200; i++) { a.putShape(shape(`shape:s${i}`) as any) }
a.commit()
assert.equal(a.getShape('shape:s0')!.id, 'shape:s0')
assert.equal(a.getShape('shape:s199')!.id, 'shape:s199')
assert.equal(a.getShape('shape:missing'), undefined)

// --- mutators keep the index coherent ---
a.reparent('shape:s5', 'shape:s0'); a.commit()
assert.equal(a.getShape('shape:s5')!.parentId, 'shape:s0')
a.deleteShape('shape:s0'); a.commit()             // cascades s5
assert.equal(a.getShape('shape:s0'), undefined)
assert.equal(a.getShape('shape:s5'), undefined)
// WHITE-BOX tripwire for the eviction fix (commit 068e23d): the cascade
// delete must EVICT the descendant's bucket from the private index — key
// absent, not merely present-but-filtered. Every black-box read path
// filters isDeleted(), so reverting the eviction to object-identity
// matching (arr.indexOf(node), which never matches the fresh wrapper
// objects .children() returns) passes the ENTIRE suite except this
// assertion — verified: with the eviction reverted to indexOf, the
// shape:s5 line below fails while everything else stays green.
const aIndex = (a as any).index as Map<string, unknown[]>
assert.equal(aIndex.has('shape:s0'), false, 'deleted root evicted from the index (key absent)')
assert.equal(aIndex.has('shape:s5'), false, 'cascade-deleted DESCENDANT evicted from the index (key absent)')

// --- index survives an import (rebuild on merge) ---
const b = LoroCanvasDoc.create({ peerId: 2n })
b.import(a.exportUpdate()); b.commit()
assert.equal(b.listShapes().length, a.listShapes().length)
assert.equal(b.getShape('shape:s1')!.id, 'shape:s1')

// --- duplicate-id contract preserved: repair still reconciles EVERY copy ---
// Trivial single-copy case first (repair on a lone shape is a no-op).
const c = LoroCanvasDoc.create({ peerId: 3n })
c.putShape(shape('shape:dup') as any); c.commit()
c.repair(); c.commit()
assert.equal(c.getShape('shape:dup')!.id, 'shape:dup')

// Now a GENUINE two-physical-node duplicate, built with the fork technique
// from repair.test.ts §5: two docs fork from a shared genesis holding
// shape:x; both delete+recreate shape:x concurrently (different content) and
// cross-import — the tree CRDT keeps BOTH new physical nodes. The index must
// hold both copies in one bucket pre-repair (the duplicate-tolerant contract
// nodesByShapeId promises repair()), and exactly the winner post-repair.
{
  const genesis = LoroCanvasDoc.create({ peerId: 10n })
  genesis.putPage({ id: 'page:p', name: 'P' } as any)
  genesis.putShape(shape('shape:x') as any)
  genesis.commit()
  const genesisSnap = genesis.exportSnapshot()

  const forkA = LoroCanvasDoc.fromSnapshot(genesisSnap, { peerId: 11n })
  const forkB = LoroCanvasDoc.fromSnapshot(genesisSnap, { peerId: 12n })

  forkA.deleteShape('shape:x')
  forkA.putShape(shape('shape:x', { x: 500 }) as any)
  forkA.commit()
  forkB.deleteShape('shape:x')
  forkB.putShape(shape('shape:x', { kind: 'geo' }) as any)
  forkB.commit()

  forkA.import(forkB.exportUpdate()); forkA.commit()

  // Pre-repair: the merge kept both physical nodes AND the index bucket
  // holds both — asserted directly on the private map, not via a read path.
  assert.equal(forkA.listShapes().filter((s) => s.id === 'shape:x').length, 2,
    'precondition: the merge kept BOTH physical nodes for shape:x')
  const forkAIndex = (forkA as any).index as Map<string, unknown[]>
  assert.equal(forkAIndex.get('shape:x')!.length, 2,
    'index bucket holds BOTH live duplicates pre-repair (duplicate-tolerant contract)')

  // Post-repair: dedupe collapses to one winner; the bucket must follow.
  const plan = forkA.repair(); forkA.commit()
  assert.ok(plan.some((o) => o.op === 'dedupeShape' && o.id === 'shape:x'),
    'repair plan names the dedupe')
  assert.equal(forkA.listShapes().filter((s) => s.id === 'shape:x').length, 1,
    'exactly one physical node survives the dedupe')
  assert.equal(((forkA as any).index as Map<string, unknown[]>).get('shape:x')!.length, 1,
    'index bucket collapsed to the single winner post-repair')
}

// --- index survives fromSnapshot (rebuild path) ---
const snap = LoroCanvasDoc.fromSnapshot(a.exportSnapshot(), { peerId: 4n })
assert.equal(snap.getShape('shape:s1')!.id, 'shape:s1')
assert.equal(snap.getShape('shape:s0'), undefined) // was deleted before snapshot

// --- perf gate: getShape must NOT scan the whole tree per lookup ---
// Spy on the private `tree` field's `nodes()` method (the O(n) WASM marshal
// nodeByShapeId used to call on every single lookup) and assert getShape
// does not invoke it at all once the doc is built and indexed.
const d = LoroCanvasDoc.create({ peerId: 5n })
for (let i = 0; i < 1000; i++) { d.putShape(shape(`shape:p${i}`) as any) }
d.commit()

const tree = (d as any).tree
const originalNodes = tree.nodes.bind(tree)
let nodesCallCount = 0
tree.nodes = (...args: unknown[]) => { nodesCallCount++; return originalNodes(...args) }

for (let i = 0; i < 1000; i++) { d.getShape(`shape:p${i % 1000}`) }
assert.equal(nodesCallCount, 0, 'getShape must resolve via the id→node index, not a tree.nodes() scan')

tree.nodes = originalNodes

console.log('ok: node-index')
