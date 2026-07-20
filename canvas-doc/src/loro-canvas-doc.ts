// loro-crdt's default (nodejs) export reads its .wasm via fs at a build-time-baked
// __dirname, which bun build --compile can't embed — breaks the standalone binary
// wherever node_modules isn't present. /base64 inlines the wasm as a JS string.
import { LoroDoc, VersionVector, type LoroMap, type LoroTree, type LoroTreeNode } from 'loro-crdt/base64'
import { canonicalPageId, cascadeDropSet, repairPlan, stableStringify, validateShape, SHAPE_KINDS, type Binding, type Page, type RepairOp, type Shape, type ShapeKind } from '@ensembleworks/canvas-model'
import { dumpModel } from './bridge.js'
import type { CanvasDoc, ImportResult, InvalidWrite, InvalidWriteHandler } from './canvas-doc.js'

// Node.data layout: we store the whole model shape envelope as flat keys on the
// Loro tree node's data map. The tldraw/model shape id lives under 'shapeId'
// (the Loro TreeID is separate). Loro's movable tree owns parent/child/z-order.
export class LoroCanvasDoc implements CanvasDoc {
  // id → ALL live tree nodes tagged with that shapeId (see nodesByShapeId for
  // why more than one can exist). Maintained incrementally by the
  // single-shape mutators (putShape/reparent/deleteShape) and rebuilt
  // wholesale by reindex() after any bulk/opaque tree rewrite (import(),
  // fromSnapshot, repair()'s raw tree.delete/tree.move calls). Entries are
  // NOT touched by tree.move (moves change neither node identity nor bucket
  // membership) and ARE evicted precisely on deletion: deleteNode's
  // collect() walks the whole subtree BEFORE the cascade delete and evicts
  // every collected node from its bucket by TreeID, so cascade-deleted
  // descendants are pruned too, not just the top-level node. Read-time
  // isDeleted() filtering is defense-in-depth, not the primary mechanism;
  // its remaining genuine consumer is repair()'s raw tree.delete on dedupe
  // losers — and dedupeShapeNodes covers that itself by collapsing the
  // bucket to [winner]. Reviewer-traced conclusion (post-068e23d): there is
  // no known unbounded-growth path for index buckets on docs that never
  // import/repair — the incremental mutators alone keep the index precise.
  private index = new Map<string, LoroTreeNode[]>()

  private constructor(
    private doc: LoroDoc,
    private tree: LoroTree,
    private onInvalidWrite?: InvalidWriteHandler,
  ) {
    this.reindex()
  }

  static create(opts: { peerId: bigint; onInvalidWrite?: InvalidWriteHandler }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'), opts.onInvalidWrite)
  }
  static fromSnapshot(bytes: Uint8Array, opts: { peerId: bigint; onInvalidWrite?: InvalidWriteHandler }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    doc.import(bytes)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'), opts.onInvalidWrite)
  }

  // Rebuild the id→node index from a full tree scan. Called on construction
  // and after any path that rewrites the tree without going through the
  // single-shape mutators below (import, fromSnapshot, repair's raw ops).
  private reindex(): void {
    this.index = new Map()
    for (const n of this.tree.nodes()) {
      if (n.isDeleted()) continue
      const sid = n.data.get('shapeId') as string | undefined
      if (!sid) continue
      const arr = this.index.get(sid)
      if (arr) arr.push(n); else this.index.set(sid, [n])
    }
  }

  // id → Loro node, resolved via the index (O(1) amortized) instead of a
  // per-call tree scan. First element of the index bucket is the answer.
  protected nodeByShapeId(id: string): LoroTreeNode | undefined {
    return this.index.get(id)?.find((n) => !n.isDeleted())
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
    return this.index.get(id)?.filter((n) => !n.isDeleted()) ?? []
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

  // Monotonic count of locally-originated writes this doc refused (see
  // InvalidWrite). Never reset.
  private invalidWriteCounter = 0
  get invalidWriteCount(): number { return this.invalidWriteCounter }

  // Count, then report. A rejection is a NO-OP at the call site, so this is
  // the only trace it leaves.
  //
  // Takes the offending VALUE, not a caller-derived kind: every call site is
  // reaching into something that just failed validation, so a caller-supplied
  // kind is exactly where a number, an object, or undefined would enter and
  // quietly violate InvalidWrite's declared type. Coercing here means no call
  // site can get it wrong.
  //
  // Logs on POWERS OF TWO (#1, #2, #4, …) rather than capping. v2 commits at
  // per-pointermove granularity, so a tool emitting an invalid write during a
  // drag would otherwise produce ~60 warnings per second for as long as the
  // drag lasts — enough to hang DevTools, and it buries the FIRST warning,
  // which is the diagnostically useful one. A lifetime cap would fix the flood
  // but make silence indistinguishable from health, and would go permanently
  // quiet so an unrelated bug an hour later never surfaced. This never closes
  // the channel: 10 lines for a ten-second bad drag, 18 for an hour (the count
  // is floor(log2(writes)) + 1 — both figures computed, not estimated). The
  // [#n] marker tells the reader they are seeing a sample, not a census.
  private rejectWrite(op: InvalidWrite['op'], value: unknown, rawId: unknown, error: string): void {
    const rawKind = (value as { kind?: unknown } | null | undefined)?.kind
    // `kind` is coerced here because InvalidWrite.kind is a NARROWED declared
    // type (ShapeKind | '<unknown>') that runtime garbage would violate — not
    // merely because kinds happen to have a closed vocabulary. `id` is
    // declared plain `string`, so its rule is weaker but still checkable:
    // must be a NON-EMPTY string. Empty is coerced too — it passes
    // `typeof === 'string'` and would render as a blank in the log line,
    // reading as a formatting bug rather than as missing data.
    const kind: ShapeKind | '<unknown>' =
      typeof rawKind === 'string' && (SHAPE_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as ShapeKind)
        : '<unknown>'
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : '<no id>'
    const n = ++this.invalidWriteCounter
    const write: InvalidWrite = { op, kind, id, error }
    if (this.onInvalidWrite) {
      try { this.onInvalidWrite(write) }
      catch { /* A reporting sink must NEVER convert a no-op rejection into a
                 throw that escapes Editor.applyAll's un-try/caught intent loop
                 and strands that batch's earlier mutations uncommitted
                 (decision D1). The counter is incremented above, before this
                 call, so a throwing sink cannot skew it either. */ }
    } else if ((n & (n - 1)) === 0) {
      console.warn(`[canvas-doc] rejected invalid ${op} (${kind}) ${id} [#${n}]: ${error}`)
    }
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
    // WRITE BOUNDARY. `validateShape` is the SAME predicate checkInvariants
    // uses for the validProps rule, so anything accepted here is something
    // repair() will not later act on — a locally-originated write can no
    // longer manufacture the state repair() is obliged to destroy.
    // Rejection is a total no-op (not a partial write, not a throw): a throw
    // escapes Editor.applyAll's un-try/caught intent loop and strands that
    // batch's earlier mutations uncommitted. Observability lives in
    // rejectWrite.
    const v = validateShape(s)
    if (!v.ok) {
      // Pass the whole rejected VALUE, not a locally-derived kind or id:
      // rejectWrite coerces both centrally so no call site can leak garbage
      // into InvalidWrite.
      this.rejectWrite('putShape', s, (s as { id?: unknown })?.id, v.error)
      return
    }
    this.putShapeUnchecked(s)
  }
  /**
   * putShape WITHOUT the write-boundary validation above. It exists so tests
   * and hostile-state rigs can construct exactly the docs a REMOTE peer's
   * bytes can still deliver (import() applies remote ops straight to the tree
   * and never passes through putShape, so local validation cannot close that
   * door).
   *
   * Kept off the CanvasDoc interface as a SIGNAL, not a barrier — production
   * reaches this concrete class routinely (SyncServerPeer.doc,
   * SyncClientPeer.doc, ShadowMirror.doc and reconcile()'s parameter are all
   * typed LoroCanvasDoc), so anyone typing `peer.doc.` gets this method in
   * autocomplete with no interface boundary in the way. The actual enforcement
   * is the CI presence gate in scripts/ — see it for the allowlist and how to
   * extend it. Do not call this from production code.
   */
  putShapeUnchecked(s: Shape): void {
    // Placement FIRST, data second (same discipline as reparent): for an
    // existing node Loro's cycle guard throws if s.parentId names a real
    // descendant of it, and no data field may be modified in that case.
    // A freshly created node has no descendants, so its placement cannot cycle.
    let n = this.nodeByShapeId(s.id)
    let isNew = false
    if (!n) { n = this.tree.createNode(); isNew = true }
    this.placeInTree(n, s.parentId)
    const d = n.data
    d.set('shapeId', s.id); d.set('kind', s.kind); d.set('parentId', s.parentId)
    d.set('index', s.index); d.set('x', s.x); d.set('y', s.y)
    d.set('rotation', s.rotation); d.set('isLocked', s.isLocked); d.set('opacity', s.opacity)
    d.set('meta', s.meta as any); d.set(LoroCanvasDoc.PROP_KEY, s.props as any)
    if (isNew) {
      const arr = this.index.get(s.id)
      if (arr) arr.push(n); else this.index.set(s.id, [n])
    }
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
    // Collect the shapeIds (and TreeIDs, for index eviction) of the whole
    // real subtree before the cascade delete, then clear each shape's text
    // container. The emptied Loro container itself persists as a CRDT
    // tombstone (known bloat category per design); clearing its content
    // prevents text resurrection when a shape id is reused.
    // Eviction below matches on TreeID (n.id), not object identity: each call
    // to node.children() returns freshly-constructed LoroTreeNode wrapper
    // objects (probed — a descendant read via .children() is NOT the same JS
    // object as the one stored in the index), but TreeID is a stable value
    // (`counter@peer`) that compares equal across those wrappers.
    const collected: { sid: string; treeId: LoroTreeNode['id'] }[] = []
    const collect = (node: LoroTreeNode): void => {
      const sid = node.data.get('shapeId') as string | undefined
      if (sid) collected.push({ sid, treeId: node.id })
      for (const c of node.children() ?? []) collect(c)
    }
    collect(n)
    this.tree.delete(n.id)
    for (const { sid, treeId } of collected) {
      const t = this.doc.getText(this.textKey(sid))
      if (t.length > 0) t.delete(0, t.length)
      const arr = this.index.get(sid)
      if (arr) {
        const i = arr.findIndex((x) => x.id === treeId)
        if (i !== -1) arr.splice(i, 1)
        if (arr.length === 0) this.index.delete(sid)
      }
    }
  }
  deleteShape(id: string): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
    this.deleteNode(n)
  }
  // Collapse every physical tree node sharing `id` down to ONE — the plan's
  // dedupeShape op (repair() only; not public API). Winner = the node whose
  // dumped shape has the smallest stableStringify: the SAME content rule
  // applyRepairToModel uses, so the two applications cannot drift. Exact
  // content ties are broken by TreeID — identical strings on every converged
  // peer (Loro node ids are `counter@peer`, shared history) — because the
  // PHYSICAL choice must also agree across peers: content ties are
  // model-invisible, but if two peers kept different physical survivors,
  // their repair deltas would cross-delete each other's survivor and the
  // shape would vanish everywhere. Traversal order is forbidden as a tiebreak
  // (probe-proven unstable across converged peers — see test-helpers.ts's
  // byIdAsc note).
  private dedupeShapeNodes(id: string): void {
    const nodes = this.nodesByShapeId(id)
    if (nodes.length <= 1) return // already single (or gone) — idempotent
    const keyed = nodes.map((n) => ({ n, key: stableStringify(this.readNode(n)) }))
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.n.id < b.n.id ? -1 : a.n.id > b.n.id ? 1 : 0))
    const winner = keyed[0]!.n
    const losers = keyed.slice(1).map((k) => k.n)
    const loserTreeIds = new Set(losers.map((l) => l.id))
    // If the winner sits INSIDE a loser's subtree, park it at Loro root first:
    // deleting that loser would otherwise cascade-kill the winner, and
    // rescuing a subtree that contains the winner under the winner would trip
    // Loro's cycle guard. Parking is model-invisible (data.parentId is not
    // touched); physical placement is restored best-effort below.
    let parked = false
    for (let anc = winner.parent(); anc; anc = anc.parent()) {
      if (loserTreeIds.has(anc.id)) { this.tree.move(winner.id, undefined); parked = true; break }
    }
    // RESCUE CHILDREN before any deletion: every physical child of every
    // loser moves under the winner — the model says those children survive
    // (their parentId is the ID, which keeps resolving), so the physical
    // cascade of the loser's deletion must not take them. Placement order
    // under the winner is irrelevant (z-order comes from data.index).
    // Children that are themselves losers are skipped (they are about to be
    // deleted; their own children are rescued by their own loop turn).
    // Cycle-safe: the winner is not inside any loser's subtree (parked
    // above), so no rescued child's subtree can contain it.
    for (const l of losers) {
      for (const c of [...(l.children() ?? [])]) {
        if (c.id === winner.id || loserTreeIds.has(c.id)) continue
        this.tree.move(c.id, winner.id)
      }
    }
    // Delete losers via tree.delete directly — NOT deleteNode: the per-id
    // text container (text:<id>) is SHARED by every physical copy, and
    // deleteNode's text cleanup would wipe the SURVIVOR's text. A loser
    // nested under another loser dies by that ancestor's cascade first —
    // guard on isDeleted() so the second delete is a no-op, not a throw.
    for (const l of losers) if (!l.isDeleted()) this.tree.delete(l.id)
    // Restore the winner's physical placement to its data.parentId if we
    // parked it. May legitimately hit Loro's cycle guard in split-brain
    // states (data.parentId naming a shape that is now physically the
    // winner's descendant after rescue) — leave the winner at root then:
    // placeInTree's own philosophy (root over impossible placement), and
    // model-invisible either way since data.parentId is not modified.
    if (parked) {
      try { this.placeInTree(winner, winner.data.get('parentId') as string) } catch { /* leave at root */ }
    }
    // Collapse the index bucket to the sole survivor — losers were deleted
    // via raw tree.delete above (not deleteNode), so they were never pruned.
    this.index.set(id, [winner])
  }
  // No index maintenance needed here: tree.move repositions the SAME node
  // object already sitting in its id bucket — no identity change, no bucket
  // membership change.
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
    const changed = status.success.size > 0
    // A merge can restructure the tree arbitrarily (create/move/delete nodes
    // outside our mutators' incremental bookkeeping) — rebuild the index
    // wholesale rather than try to diff it. Skipped on a no-op import (the
    // tree didn't move) to keep the common re-import case cheap.
    if (changed) this.reindex()
    return {
      pending: status.pending !== null && status.pending.size > 0,
      changed,
    }
  }
  // PERF (measured, Phase 2 review): ~7.36ms/call at 1k shapes on a CLEAN doc
  // — i.e. that's the floor even when the plan is empty — with ~70% of it in
  // the three list*() WASM marshals inside dumpModel; cost is linear in doc
  // size. Sync peers therefore gate repair() on ImportResult.changed (no-op
  // imports skip it entirely). The id→node index (see nodeByShapeId) removes
  // the O(n) rescan per plan op below, so cost on a DIRTY doc no longer
  // compounds to O(n²) with plan size — see repair-cost.test.ts for the
  // pinned floor.
  repair(): RepairOp[] {
    const model = dumpModel(this)
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
      else if (o.op === 'dedupeShape') {
        if (dropAll.has(o.id)) {
          // The id is claimed by a drop CASCADE (an ancestor of one of its
          // copies is being dropped): cascadeDropSet is keyed by id, so the
          // model drops EVERY entry of this id — mirror that here by
          // deleting all physical copies (deleteNode's text cleanup is
          // correct in this branch: the id is model-dead) instead of
          // collapsing them to a winner the model would not keep.
          for (const n of this.nodesByShapeId(o.id)) this.deleteNode(n)
        } else {
          this.dedupeShapeNodes(o.id)
        }
      }
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
    // repair() above already keeps the index coherent incrementally (deleteNode
    // and dedupeShapeNodes both maintain it, and reparentToRoot's raw move
    // doesn't change node identity), but rebuild wholesale anyway as a
    // defense-in-depth backstop against repair()'s raw tree ops — cheap
    // relative to the list*() scans above, and correctness must not depend on
    // this method's internals staying in perfect lockstep with the index.
    // Skipped when the plan was empty: an empty plan (and therefore an empty
    // dropAll) touches nothing above, so the index is provably still exact —
    // this keeps the common idempotent repair() call (already-clean doc) from
    // paying for a rebuild it doesn't need.
    if (plan.length > 0) this.reindex()
    return plan
  }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void {
    return this.doc.subscribeLocalUpdates(listener)
  }
  commit(): void { this.doc.commit() }
}
