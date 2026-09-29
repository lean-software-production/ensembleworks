// Run: bun src/artifact-shape.test.ts
//
// The `artifact` kind's props schema (Canvas artifact viewer, stage 1a —
// the compatibility reader). The shape selects a file to serve, so its props
// are STRICT and VERSIONED: junk is refused at the write boundary rather
// than passed through the way tldraw-parity kinds pass unknown keys. Every
// case runs and reports, instead of stopping at the first failed assertion,
// so one run shows the whole contract.
import assert from 'node:assert/strict'
import { SHAPE_KINDS, isTextCapableKind, shapeSchema, validateShape } from './shape.js'
import { makeDocument } from './document.js'
import { applyRepairToModel, repairPlan } from './repair.js'

const failures: string[] = []
function check(name: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message.split('\n').join('\n    ')}`)
  }
}

const linked = {
  w: 720, h: 540, schemaVersion: 1, source: 'thread-storage',
  threadId: 'thr_fixture01', path: 'reports/deck/index.html', title: 'Launch deck',
}

function artifactWith(props: Record<string, unknown>) {
  return {
    id: 'shape:art', kind: 'artifact', parentId: 'page:p', index: 'a1',
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props,
  }
}

check('artifact is a shape kind', () => {
  assert.ok((SHAPE_KINDS as readonly string[]).includes('artifact'), 'SHAPE_KINDS includes "artifact"')
})

check('artifact is not text-capable', () => {
  assert.equal(isTextCapableKind('artifact' as never), false)
})

// ---- accepted ----
const accepted: Array<[string, Record<string, unknown>]> = [
  ['a linked thread-storage artifact', linked],
  ['a workspace artifact (admitted now so no later gate is needed)', { ...linked, source: 'workspace', path: 'docs/index.html' }],
  ['a fully unlinked artifact', { ...linked, threadId: '', path: '', title: '' }],
  ['path at the 1024-char limit', { ...linked, path: 'a'.repeat(1024) }],
  ['title at the 200-char limit', { ...linked, title: 't'.repeat(200) }],
  ['threadId at the 64-char limit', { ...linked, threadId: 'x'.repeat(64) }],
  ['a single-segment path', { ...linked, path: 'deck.html' }],
  ['a dotted file name (not a dot segment)', { ...linked, path: 'a/.well-known/x..html' }],
]
for (const [name, props] of accepted) {
  check(`accepts ${name}`, () => {
    const result = validateShape(artifactWith(props))
    assert.ok(result.ok, `expected ok, got: ${result.ok ? '' : result.error}`)
  })
}

check('props round-trip through the schema unchanged', () => {
  assert.deepEqual(shapeSchema.parse(artifactWith(linked)).props, linked)
})

// ---- rejected ----
const rejected: Array<[string, Record<string, unknown>]> = [
  ['an extra key (strict)', { ...linked, url: 'https://example.com' }],
  ['schemaVersion 2', { ...linked, schemaVersion: 2 }],
  ['w 0', { ...linked, w: 0 }],
  ['h 0', { ...linked, h: 0 }],
  ['negative w', { ...linked, w: -10 }],
  ['Infinity h', { ...linked, h: Number.POSITIVE_INFINITY }],
  ['NaN w', { ...linked, w: Number.NaN }],
  ['source "host"', { ...linked, source: 'host' }],
  ['an absolute path', { ...linked, path: '/etc/passwd' }],
  ['a bare ".." path', { ...linked, path: '..' }],
  ['a ".." segment', { ...linked, path: 'a/../b' }],
  ['a "." segment', { ...linked, path: './a' }],
  ['an empty segment', { ...linked, path: 'a//b' }],
  ['a trailing slash', { ...linked, path: 'a/' }],
  ['a backslash', { ...linked, path: 'a\\b' }],
  ['a path over 1024 chars', { ...linked, path: 'a'.repeat(1025) }],
  ['a title over 200 chars', { ...linked, title: 't'.repeat(201) }],
  ['a threadId over 64 chars', { ...linked, threadId: 'x'.repeat(65) }],
]
for (const key of Object.keys(linked)) {
  const { [key]: _dropped, ...rest } = linked as Record<string, unknown>
  rejected.push([`a missing "${key}"`, rest])
}
for (const [name, props] of rejected) {
  check(`rejects ${name}`, () => {
    assert.equal(validateShape(artifactWith(props)).ok, false, 'expected the schema to reject it')
  })
}

// ---- repair keeps a valid artifact, drops an invalid one ----
check('repair keeps a valid artifact and drops only the invalid one', () => {
  const doc = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [
      { ...artifactWith(linked), id: 'shape:good' } as never,
      { ...artifactWith({ ...linked, schemaVersion: 2 }), id: 'shape:bad' } as never,
    ],
    bindings: [],
  })
  const plan = repairPlan(doc)
  assert.deepEqual(plan, [{ op: 'dropShape', id: 'shape:bad' }])
  const repaired = applyRepairToModel(doc, plan)
  assert.deepEqual(repaired.shapes.map((s) => s.id), ['shape:good'])
  assert.deepEqual(repaired.byId.get('shape:good')!.props, linked)
})

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} artifact schema case(s)\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('ok: artifact props schema (strict, versioned) + repair')
