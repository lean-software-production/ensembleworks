// Run: bun src/tools/tool-context.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { buildSpatialIndex, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createSelectTool } from './select.js'
import { createToolContext } from './tool-context.js'

const geoShape = (id: string, x: number, y: number): Shape => ({
  id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
} as Shape)

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape(geoShape('shape:a', 0, 0))
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  return { doc, editor }
}

// A counting wrapper around the real builder: `builds` counts every index
// construction, including the one at createToolContext time.
function countingBuilder() {
  const counter = { builds: 0 }
  const buildIndex = (m: CanvasDocument) => { counter.builds += 1; return buildSpatialIndex(m) }
  return { counter, buildIndex }
}

// ============================================================================
// 1. LAZY CADENCE (the load-bearing assertion): a 50-move drag-translate —
//    which COMMITS once per pointermove — triggers ZERO index rebuilds while
//    nothing queries the context mid-gesture, and exactly ONE rebuild on the
//    first query afterwards. An eager rebuild-in-listener implementation
//    fails this with builds ≈ 51.
// ============================================================================
{
  const { editor } = setup()
  const { counter, buildIndex } = countingBuilder()
  const ctx = createToolContext(editor, { buildIndex })
  assert.equal(counter.builds, 1, 'construction builds the initial index once')

  const tool = createSelectTool(ctx)
  // pointerdown hits shape:a via ONE query (hitTestTopmost at down) — that
  // query precedes any commit, so it costs zero rebuilds; then 50 moves,
  // each committing a TranslateShapes, none querying.
  const events = script().down(50, 50).move(150, 150, { steps: 49 }).up().events()
  run(editor, tool, events)
  assert.equal(counter.builds, 1, 'a 50-move drag (50 per-move commits) triggers ZERO rebuilds — the listener only marks dirty')

  const hit = ctx.hitTestTopmost({ x: 150, y: 150 }) // shape:a moved +100/+100 → now [100,200]²
  assert.equal(counter.builds, 2, 'the FIRST query after the dirty gesture triggers exactly ONE rebuild')
  assert.equal(hit, 'shape:a', 'and that rebuild sees the post-drag doc state')

  ctx.hitTestTopmost({ x: 150, y: 150 })
  ctx.queryMarquee({ minX: 0, minY: 0, maxX: 500, maxY: 500 }, 'intersect')
  ctx.snapshot()
  assert.equal(counter.builds, 2, 'further queries with no intervening commit reuse the built pair — still no rebuild')

  ctx.dispose()
  console.log('ok: lazy cadence — zero rebuilds mid-drag, exactly one on the next query')
}

// ============================================================================
// 2. Snapshot identity semantics: stable (===) between rebuilds; a NEW
//    reference appears at the first snapshot() after a commit, not at the
//    commit itself.
// ============================================================================
{
  const { editor } = setup()
  const ctx = createToolContext(editor)

  const s1 = ctx.snapshot()
  assert.equal(ctx.snapshot(), s1, 'no commit in between: identical reference')

  editor.apply({ type: 'CreateShape', shape: geoShape('shape:b', 300, 300) })
  // The commit has happened, but identity only changes at the next READ.
  const s2 = ctx.snapshot()
  assert.notEqual(s2, s1, 'first read after a commit returns a NEW snapshot reference')
  assert.ok(s2.byId.has('shape:b'), 'and it reflects the committed change')
  assert.equal(ctx.snapshot(), s2, 'stable again until the next commit')

  ctx.dispose()
  console.log('ok: snapshot identity — stable between rebuilds, fresh reference on first read after a commit')
}

// ============================================================================
// 3. dispose(): unsubscribes the doc listener — commits after dispose no
//    longer mark the context dirty, so its queries answer from the
//    last-built snapshot forever (stale by design) and never rebuild again.
// ============================================================================
{
  const { editor } = setup()
  const { counter, buildIndex } = countingBuilder()
  const ctx = createToolContext(editor, { buildIndex })
  const before = ctx.snapshot()
  assert.equal(counter.builds, 1)

  ctx.dispose()
  editor.apply({ type: 'CreateShape', shape: geoShape('shape:late', 400, 400) })
  assert.equal(ctx.snapshot(), before, 'post-dispose commits never dirty the context — same stale reference')
  ctx.hitTestTopmost({ x: 450, y: 450 })
  assert.equal(counter.builds, 1, 'post-dispose queries never rebuild')
  assert.equal(ctx.hitTestTopmost({ x: 450, y: 450 }), null, 'the stale index predates shape:late, so it is (correctly, per the dispose contract) invisible')

  console.log('ok: dispose() detaches the doc listener — no dirtying, no rebuilds, stale-by-design answers')
}

console.log('ok: tool-context (lazy rebuild cadence, snapshot identity, dispose)')
