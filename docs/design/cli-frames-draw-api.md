# API-surface design — Frame + drawing-shape creation in the CLI (EW-CLI-DRAW-0001)

Design note for the sprint's step 3 (api-surface). Every record prop below is quoted from the
**installed tldraw 5.1.0** validators, not from a summary. Verified pins (`bun`/npm lockfile,
`node -e "require(...package.json).version"`):

| package | version |
|---|---|
| `tldraw` (client) | **5.1.0** |
| `@tldraw/sync` (client) | 5.1.0 |
| `@tldraw/sync-core` / `@tldraw/tlschema` / `@tldraw/utils` / `@tldraw/validate` (server) | 5.1.0 |

The server store is a real `TLSocketRoom` that runs the **same schema validation on `store.put`** the
browser uses. So the design rule is: *a record that survives `put` renders on the client, unchanged.*
`frame`/`line`/`draw`/`highlight` are already in `defaultShapeSchemas`; only two server enums and the
contract enum block them. **No `cli/src` changes** — the CLI is a pure projection of `GET /api/tools`.

> **The one load-bearing schema gotcha (read this first).** `draw`/`highlight` store their geometry
> as `segments[].path`, a **base64 string** validated only by `T.string`
> (`TLDrawShape.ts:34` — `path: T.string`). The schema therefore **cannot** reject bad point data for
> draw/highlight: a single point, `NaN`, `Infinity`, or `1e12` all encode to *some* valid string and
> `put` returns 200. The server MUST validate point arrays **before** encoding. (`line` is safer — its
> `points` dict is validated coordinate-by-coordinate with `T.number`, which rejects NaN/Infinity —
> but it still needs the magnitude/count/degeneracy guard, because `T.number` accepts `1e12`.)
>
> **And a second, subtler hole (empirically pinned).** For draw/highlight, `encodePoints` stores point
> 0 as Float32 but **every subsequent point as a Float16 *delta*** (`b64Vecs.ts:305-338`). Float16's max
> finite value is **65504**, so a stroke like `[[0,0],[70000,0]]` — both coords well under any absolute
> `|c| ≤ 1e6` bound — has a *delta* of 70000 that overflows to `Infinity` in the stored `path`. `put`
> still returns 200 (path is `T.string`) and the decoded point is `Infinity`. Round-tripped through the
> real `compressLegacySegments`: consecutive delta 65500→65504 decodes fine, **66000 → Infinity**. So an
> absolute-magnitude bound is **not sufficient** for draw/highlight — the guard must also cap the
> **consecutive-point x/y delta at 65504** (see §6/§7). Line is immune (absolute `T.number`, no delta
> encoding).

---

## 0. The verified 5.1.0 validators (source of truth)

Quoted from `node_modules/@tldraw/tlschema/src/…`. `RecordProps` uses `T.object` semantics: **every
listed key is required, and unknown keys are rejected** — so an extra prop (e.g. copying `fill` onto a
highlight) throws → 400.

### `frameShapeProps` — `shapes/TLFrameShape.ts:64-75`
```
w:     T.nonZeroNumber            // :65  finite AND > 0
h:     T.nonZeroNumber            // :66  finite AND > 0
name:  T.string                   // :67  '' is valid
color: DefaultColorStyle.validate // :74  REQUIRED in 5.1.0 (AddColorProp migration :94-106)
```
`color` is a plain color validator (delegates to `DefaultColorStyle`, `TLColorStyle.ts:39-42`, 13
values: `black grey light-violet violet blue light-blue yellow orange green light-green light-red red
white`). **No `richText`, no label prop** — a frame's caption is `props.name`.

### `drawShapeProps` — `shapes/TLDrawShape.ts:122-134`
```
color:      DefaultColorStyle     // :123
fill:       DefaultFillStyle      // :124  values none|semi|solid|pattern|fill|lined-fill (TLFillStyle.ts:39)
dash:       DefaultDashStyle      // :125  values draw|solid|dashed|dotted|none (TLDashStyle.ts:38)
size:       DefaultSizeStyle      // :126  values s|m|l|xl
segments:   T.arrayOf(DrawShapeSegment)  // :127
isComplete: T.boolean             // :128
isClosed:   T.boolean             // :129
isPen:      T.boolean             // :130
scale:      T.nonZeroNumber       // :131  finite AND > 0
scaleX:     T.nonZeroFiniteNumber // :132  finite, non-zero (may be negative)
scaleY:     T.nonZeroFiniteNumber // :133
```
`DrawShapeSegment` (`:32-35`): `{ type: 'free'|'straight', path: T.string }`. `path` is **delta-encoded
base64**, NOT a point array (first point Float32 = 12 bytes, subsequent points Float16 deltas = 6 bytes
each; `b64Vecs.encodePoints`, `misc/b64Vecs.ts:305`). Build it via
`compressLegacySegments([{ type:'free', points: VecModel[] }])` (`TLDrawShape.ts:252-262`), the
**exported** public helper — never hand-write `path`.

### `highlightShapeProps` — `shapes/TLHighlightShape.ts:93-102`
```
color:      DefaultColorStyle     // :94
size:       DefaultSizeStyle      // :95
segments:   T.arrayOf(DrawShapeSegment)  // :96  (imports DrawShapeSegment from TLDrawShape)
isComplete: T.boolean             // :97
isPen:      T.boolean             // :98
scale:      T.nonZeroNumber       // :99
scaleX:     T.nonZeroFiniteNumber // :100
scaleY:     T.nonZeroFiniteNumber // :101
```
**Smaller set than draw: NO `fill`, NO `dash`, NO `isClosed`.** Copying any of those from the draw
branch → unknown-key throw → 400.

### `lineShapeProps` — `shapes/TLLineShape.ts:157-164`
```
color:  DefaultColorStyle         // :158
dash:   DefaultDashStyle          // :159
size:   DefaultSizeStyle          // :160
spline: LineShapeSplineStyle      // :161  values 'cubic'|'line', default 'line' (:25-28)
points: T.dict(T.string, lineShapePointValidator)  // :162
scale:  T.nonZeroNumber           // :163
```
`points` is a **keyed dictionary, not an array** and has **no `handles`** (removed by the
`HandlesToPoints`/`PointIndexIds` migrations `:237-294`). Each value
(`lineShapePointValidator`, `:65-70`) is:
```
{ id: T.string, index: T.indexKey, x: T.number, y: T.number }
```
`index: T.indexKey` (`validation.ts:1990`) rejects arbitrary strings like `"1"`/`"2"` — it must be a
valid fractional index. Generate keys with `getIndicesAbove(null, n)` (`utils/reordering.ts:72` →
`['a1','a2',…]`). tldraw's own convention (`PointIndexIds` migration `:268-286`) is
**key === id === index**; we follow it. **No `scaleX`/`scaleY` on line.**

### Supporting facts
- `VecModel` (`misc/geometry-types.ts:18-22`): `{ x:number, y:number, z?:number }` — `z` is pen
  pressure; `encodePoints` defaults a missing `z` to `0.5` (`b64Vecs.ts:321,326,330`).
- `T.number` (`validation.ts:1167-1182`) requires `Number.isFinite` → **rejects NaN and Infinity**.
  `T.nonZeroNumber` (`:1221`) requires finite `> 0`. `T.nonZeroFiniteNumber` (`:1248`) requires finite
  `!== 0`.

---

## 1. Verb signatures & flags

CLI surface (unchanged verbs, new `type` values + new optional flags). Braces show which flags each
create type consumes:

```
canvas shape create frame     --name <s> --w <n> --h <n> --x <n> --y <n> --color <c>
canvas shape create line      --points '[[0,0],[120,60],[200,0]]' [--spline line|cubic] [--color <c>]
canvas shape create draw      --points '[[0,0],[40,10],[80,60]]'  [--closed] [--color <c>] [--fill <f>]
canvas shape create highlight --points '[[0,0],[120,0]]'          [--color <c>]
canvas shape update <id> --frame <name>      # reparent INTO a frame (page-position preserved)
canvas shape update <id> --to-page           # reparent OUT to the frame's actual page
canvas shape update <id> --rotate <rad>      # base-field rider (exact)
canvas shape update <id> --lock              # base-field rider (isLocked=true)
canvas shape update <id> --props '{"name":"Renamed"}'   # existing raw-prop merge → frame rename
canvas shape delete <id>                     # frame → direct children KEPT, moved to frame's page
canvas shape delete <id> --with-children     # frame → cascade-delete descendants + their bindings
canvas frame  <name>                         # read: NOW also returns a `drawings` array
canvas frames                                # read: NOW also returns a `drawings` count per frame
```

`--points` is JSON: `'[[x,y],…]'` or `[x,y,pressure]` triples, or `@file`. `cli/src/render/args.ts`
already parses array/JSON flags — no CLI change.

### `contracts/src/tools/canvas.ts` — `canvasShape.zodInput` additions (all OPTIONAL)

Every new field is `.optional()`. A new **required** scalar would reshuffle positional-slot order in
`cli/src/render/args.ts`; optional fields are safe. Add after the existing fields (`:32-48`):

```ts
type: z.enum(['geo','text','note','arrow','frame','line','draw','highlight']).optional(), // widen :32
// frame
name: z.string().optional().describe('frame caption (props.name)'),
// line / draw / highlight — [x,y] or [x,y,pressure]; page-space, JSON or @file
points: z.array(z.array(z.number())).optional().describe('polyline/stroke points, page coords'),
spline: z.enum(['line','cubic']).optional().describe('line only; default line'),
closed: z.boolean().optional().describe('draw only; sets isClosed'),
// update riders / reparent
rotate: z.number().optional().describe('set rotation in radians (exact)'),
lock:   z.boolean().optional().describe('set isLocked'),
toPage: z.boolean().optional().describe('reparent OUT to the frame\'s page'),
// delete
withChildren: z.boolean().optional().describe('frame delete: cascade descendants + bindings'),
```
`fill` (draw), `color`, `x/y/w/h`, `frame`, `id`, `props` already exist. **Do not add** any field named
`align|group|eraser|laser|image` (AC20). Update the `help` string to name the new types.
`op` stays exactly `['create','update','delete']`; `type` is exactly the 8 above — no more, no less
(AC20 asserts both enums verbatim from `GET /api/tools`).

### Read-output additions (for symmetry — see §5)

`canvasFrames.zodOutput.frames[]` (`canvas.ts:65-70`): add `drawings: z.number()`.

`canvasFrame.zodOutput` (`:80-92`): add
`drawings: z.array(z.object({ id: z.string(), type: z.string(), text: z.string().optional() }))`.

---

## 2. Per-type CREATE record

All four branches slot into `server/src/features/shape.ts` after the `note` branch (`:291`), reusing the
existing `base` record (`:145-156`: `id, typeName:'shape', parentId, index, x, y, rotation:0,
isLocked:false, opacity:1, meta`). The create enum at `:116` widens to the 8 types and its 400 message
updates. The shared color guard already runs at `:38-40`, so **an invalid `--color` 400s before any
branch** for every type. Frame/line/draw/highlight carry **no text** → they never call
`toRichText`/`badgeText`; `base.meta` still stamps `author` (AC21 — none of the four throws for lacking
richText).

### Point-coordinate convention (decided)

Input `--points` are **page-space coordinates** (the coords a human would read off the canvas). We
**normalize to a local origin**, matching tldraw's own line/draw tools (shape positioned at a page
point; points stored local, first anchored near 0,0):

```
minX = min(px_i),  minY = min(py_i)        // bounding-box min of the input
shape.x = (num(body.x) ?? 0) + minX        // origin = bbox-min (+ optional --x/--y nudge)
shape.y = (num(body.y) ?? 0) + minY
localPoints[i] = { x: px_i - minX, y: py_i - minY, z: pressure_i? }   // top-left at (0,0)
```
This makes **AC7 hold by construction**: for an unrotated shape on a page,
`getShapePageBounds` top-left `= shape page-point = (minX,minY) = input origin`, and width/height
`= (maxX-minX)×(maxY-minY) = input extent`. Page-space of point `i` reconstructs as `shape.x + local_i
= px_i` (verbatim), so **AC4's "vertices equal the input sequence" is checked in page space**
(`shape.x + local`). Every AC4–AC6 input is already (0,0)-anchored (`minX=minY=0`), so local == input
there too; normalization only matters when a caller supplies non-zero-anchored points.

> **Parented create is PARENT-RELATIVE (matches the whole create API).** `shape.x` is stored raw
> and, when `--frame` is set, `parentId` is the frame — so `shape.x` is interpreted **relative to the
> frame origin**, exactly as `geo`/`text`/`note`/`sticky` framed-create already behave (`base.x =
> body.x ?? 0`, `shape.ts:145-156`). So `--points` are page coords **on the page** and **frame-local
> under `--frame`**. This is deliberate consistency, NOT the reparent case: `update --frame` translates
> to *preserve* page-position because it MOVES an existing shape; create PLACES at parent-relative
> coords like every other create. The AC7/AC4 page-space assertions above all use unparented shapes,
> where parent-relative == page. (Help text says "parent-relative" so no caller is misled.)

### frame — `store.put`
```ts
store.put({
  ...base,                          // parentId resolved as today (:130-139): frame? → page
  type: 'frame',
  props: {
    w: num(body.w) ?? 800,          // TLFrameShape.ts:65 nonZeroNumber — missing → default; explicit 0/neg → 400
    h: num(body.h) ?? 600,          // :66
    name: typeof body.name === 'string' ? body.name : (text ?? ''),   // :67 string; '' ok (AC2 → browser labels "Frame")
    color: color ?? 'black',        // :74 DefaultColorStyle; color already guarded at shape.ts:38
  },
} as any)
```
**Gotcha:** `color` is required in 5.1.0 — omit it and `put` throws. Default `'black'`. `w`/`h` default
to non-zero so a bare `create frame` never 400s (AC2).

### line — `store.put`
```ts
const pts   = parsePoints(body.points, 2)     // pure guard (§7): ≥2 pts, finite, |c|≤1e6, ≥2 distinct → throws → 400
const origin = { x: Math.min(...pts.map(p=>p.x)), y: Math.min(...pts.map(p=>p.y)) }
store.put({
  ...base,
  x: (num(body.x) ?? 0) + origin.x,
  y: (num(body.y) ?? 0) + origin.y,
  type: 'line',
  props: {
    color: color ?? 'black',        // TLLineShape.ts:158
    dash:  'draw',                  // :159
    size:  'm',                     // :160
    spline: body.spline === 'cubic' ? 'cubic' : 'line',   // :161 (default line)
    points: buildLinePoints(toLocal(pts, origin)),        // :162 keyed dict {id,index:IndexKey,x,y}
    scale: 1,                       // :163 nonZeroNumber
  },
} as any)
```
**Gotcha:** `points` is a **keyed dict with valid IndexKeys**, not an array; `buildLinePoints` uses
`getIndicesAbove(null, n)` so `key===id===index` and vertex order = index order (AC4).

### draw — `store.put`
```ts
const pts   = parsePoints(body.points, 2)
const origin = { x: Math.min(...pts.map(p=>p.x)), y: Math.min(...pts.map(p=>p.y)) }
store.put({
  ...base,
  x: (num(body.x) ?? 0) + origin.x,
  y: (num(body.y) ?? 0) + origin.y,
  type: 'draw',
  props: {
    color: color ?? 'black',        // TLDrawShape.ts:123
    fill:  typeof body.fill === 'string' ? body.fill : 'none',  // :124 DefaultFillStyle — bad fill → put throws → 400
    dash:  'draw',                  // :125
    size:  'm',                     // :126
    segments: buildSegments(toLocal(pts, origin)),   // :127 [{type:'free', path:<base64>}]
    isComplete: true,               // :128
    isClosed: !!body.closed,        // :129  --closed → true
    isPen: false,                   // :130
    scale: 1,                       // :131 nonZeroNumber
    scaleX: 1,                      // :132 nonZeroFiniteNumber
    scaleY: 1,                      // :133
  },
} as any)
```
**Gotchas:** `segments[].path` must go through `compressLegacySegments` (base64); `scaleX`/`scaleY` are
**required** and absent from the docstring example in the file — omitting them → throw. Point validation
happens in `parsePoints` because the schema can't (see the load-bearing note up top). **`buildSegments`
additionally rejects any consecutive-point x/y delta > 65504** (Float16 delta ceiling) → 400 — draw and
highlight only.

### highlight — `store.put`
```ts
const pts   = parsePoints(body.points, 2)
const origin = { x: Math.min(...pts.map(p=>p.x)), y: Math.min(...pts.map(p=>p.y)) }
store.put({
  ...base,
  x: (num(body.x) ?? 0) + origin.x,
  y: (num(body.y) ?? 0) + origin.y,
  type: 'highlight',
  props: {
    color: color ?? 'black',        // TLHighlightShape.ts:94
    size:  'm',                     // :95
    segments: buildSegments(toLocal(pts, origin)),   // :96
    isComplete: true,               // :97
    isPen: false,                   // :98
    scale: 1,                       // :99
    scaleX: 1,                      // :100
    scaleY: 1,                      // :101
  },
} as any)
```
**Gotcha:** the smaller prop set — **no `fill`, no `dash`, no `isClosed`**. `buildSegments` is shared
with draw; the difference is purely the props object.

---

## 3. UPDATE — reparent + riders

Extend the update branch (`shape.ts:72-108`). It already loads the single record; also build
`records = store.getAll()`, `byId`, and `shapes = records.filter(typeName==='shape')` in the same
transaction (as the create branch does at `:126-128`). After `next` is assembled from the prop merge:

```ts
// --- reparent (mutually: --frame OR --to-page) ---
let newParentId: string | undefined
if (typeof body.frame === 'string') {
  const target = findFrameByName(shapes, body.frame)         // canvas/frames-helper.ts
  if (!target) { problem = { status: 404, error: 'frame not found' }; return }
  newParentId = target.id
} else if (body.toPage) {
  newParentId = pageIdOf(record, byId) ?? records.find(r=>r.typeName==='page')?.id ?? 'page:page'
}
if (newParentId) {
  const { x, y } = translateForReparent(record, newParentId, byId)   // preserves page-point
  next.parentId = newParentId
  next.x = x; next.y = y
  const sibs = shapes.filter(r => r.parentId === newParentId && r.id !== id && typeof r.index === 'string')
  const top  = sibs.length ? sibs.sort(sortByIndex).at(-1)!.index : undefined
  next.index = getIndexAbove(top)                            // AC8 z-order: at/above existing children
}
// --- riders ---
if (body.rotate !== undefined) {
  const r = num(body.rotate)
  if (r === undefined) { throw new Error('rotate must be a finite number') }  // → 400 (AC10)
  next.rotation = r
}
if (typeof body.lock === 'boolean') next.isLocked = body.lock
store.put(next)
```

- **`--frame` (AC8):** `translateForReparent` uses `pagePoint` so the shape's page-position is
  unchanged (±1px); browser clips it inside without moving it. `index` recomputed against the **new
  parent's** siblings → valid, unique, sorts at/above them.
- **`--to-page` (AC9):** target is the frame's **actual** page via `pageIdOf` (walks the parent chain),
  **not** a hardcoded `page:page` — correct on multi-page docs. Page-point unchanged.
- **`--rotate` (AC10):** `body.rotate !== undefined` but non-finite → `num` returns `undefined` → we
  throw → the surrounding `try/catch` (`:103-105`) returns 400. A valid value sets `rotation` exactly.
- **`--lock` (AC10):** `isLocked = true`. Both survive reload (they're persisted record fields).
- **Ordering:** when reparenting, the translation is authoritative; the existing `--x/--y` overrides
  (`:99-100`) apply only when **not** reparenting (guard them with `if (!newParentId)`), else a caller's
  stray `--x` would fight the translation.

**Rotated-parent limitation (AC22):** `pagePoint` (`geometry.ts:38-49`) sums parent `x/y` and
**ignores `rotation`**. Reparenting into/out of a **rotated** frame will therefore mis-place the shape.
This slice supports **unrotated parents only**; the limitation is recorded here (and should be echoed in
help/README) rather than silently mis-translated. No affine transform is claimed.

---

## 4. DELETE — frame semantics

Extend the delete branch (`shape.ts:49-69`). Today it deletes `target` + bindings touching it, which
**orphans a frame's children** (dangling `parentId`). New behavior keys on `target.type === 'frame'`;
non-frame delete is unchanged (AC14).

```ts
const target = records.find(r => r.id === id)
if (!target) { /* existing 404 */ }

if (target.type === 'frame') {
  if (body.withChildren) {
    // cascade: frame + ALL descendants (BFS over parentId) + every binding touching a removed shape
    const removeIds = new Set<string>([target.id])
    let frontier = [target.id]
    while (frontier.length) {
      const kids = records.filter(r => r.typeName === 'shape' && frontier.includes(r.parentId))
      frontier = kids.map(k => k.id).filter(kid => !removeIds.has(kid))
      for (const kid of frontier) removeIds.add(kid)
    }
    for (const rid of removeIds) { store.delete(rid); deleted++ }
    for (const r of records) {
      if (r.typeName === 'binding' && (removeIds.has(r.fromId) || removeIds.has(r.toId))) {
        store.delete(r.id); deleted++     // AC12: arrow OUTSIDE bound to sticky INSIDE loses its binding
      }
    }
  } else {
    // default: reparent DIRECT children only to the frame's own parent, translate page-position
    const directKids = records.filter(r => r.typeName === 'shape' && r.parentId === target.id)
    const sibs = records.filter(r => r.typeName==='shape' && r.parentId===target.parentId && typeof r.index==='string')
    let top = sibs.length ? sibs.sort(sortByIndex).at(-1)!.index : undefined
    for (const kid of directKids) {
      top = getIndexAbove(top)
      store.put({ ...kid,
        parentId: target.parentId,        // the frame's ACTUAL parent (page, or an enclosing frame)
        x: (kid.x ?? 0) + target.x,       // child was frame-relative; frame was parent-relative
        y: (kid.y ?? 0) + target.y,       // ⇒ child.x + frame.x is correct in the frame's parent space
        index: top,                       // fresh index under the new parent (avoid collision)
      })
    }
    store.delete(target.id); deleted++
    for (const r of records) {            // bindings touching the FRAME itself still cascade
      if (r.typeName === 'binding' && (r.fromId === target.id || r.toId === target.id)) {
        store.delete(r.id); deleted++
      }
    }
  }
}
```

- **AC11 (default):** frame gone; each **direct** sticky survives with `parentId === target.parentId`
  (the frame's real page, not `page:page`) and page-point unchanged (`x += frame.x`). No dangling
  `parentId`.
- **AC13 (nested):** `delete A` (default) moves only A's **direct** children (frame B) to A's page,
  translating B's position; **B's own sticky is a grandchild — untouched — so it stays under B**.
  `delete A --with-children` removes A, B, and B's sticky (BFS reaches all descendants).
- **AC12 (`--with-children`):** removes the whole subtree and every binding whose `fromId`/`toId` is any
  removed id — including a binding from an arrow that lives **outside** the frame. No binding in the
  store references a deleted id afterward.
- **Coordinate translation** matches tldraw's own Editor: `child.x + frame.x` is exact for an
  **unrotated** frame; the rotated-parent caveat (AC22) applies to delete-reparent too.

---

## 5. READ symmetry — `canvas frame` / `canvas frames`

Today `frames.ts` counts/returns only `note|text|image|terminal|iframe` and **omits `geo` entirely**.
The read side gains a single **`drawings`** bucket spanning `geo|line|draw|highlight` (closing the
pre-existing geo read gap too). Minimal and consistent with the existing shapes.

### `GET /api/canvas/frames` (`frames.ts:33-54`)
Add one count to each frame row:
```ts
const DRAWING_TYPES = ['geo','line','draw','highlight']
// inside .map(f => …):
drawings: children.filter(r => DRAWING_TYPES.includes(r.type)).length,
```
Row now carries `notes, texts, images, terminals, iframes, drawings`. Count moves as drawings are
added/removed (AC16). `byProximity` strips `pt` and is unaffected.

### `GET /api/canvas/frame` (`frames.ts:87-149`)
Add a `drawings` array alongside `notes/texts/images/terminals/iframes`:
```ts
const DRAWING_TYPES = ['geo','line','draw','highlight']
drawings: children
  .filter(r => DRAWING_TYPES.includes(r.type))
  .map(c => {
    const text = richTextToPlainText(c.props?.richText)   // geo has a label; line/draw/highlight don't
    return text ? { id: c.id, type: c.type, text } : { id: c.id, type: c.type }
  }),
```
Each item is `{ id, type, text? }` — `text` present only where the shape has a `richText` label (geo).
Line/draw/highlight surface as `{ id, type }`. Reads recompute children every call, so AC17 (read
reflects reparent/delete) holds with no extra work: after §3 the shape appears under its new frame;
after §4 the survivors no longer appear under the deleted frame.

---

## 6. Error matrix (AC19 / AC10 / AC2 / AC20)

Every 4xx writes **no record** (guards run before `put`, or `put` throws inside the `try` and nothing
commits). Enforcement site in parentheses.

| Input | Result | Enforced |
|---|---|---|
| `create <unknown type>` (e.g. `group`, `image`, `eraser`) | **400** `type must be …` | create enum `shape.ts:116` |
| `--color mauve` (any) | **400** | color guard `shape.ts:38-40` |
| line `--points '[[0,0]]'` (<2) | **400** | `parsePoints(…,2)` (§7) |
| line/draw/highlight `--points '[]'` | **400** | `parsePoints` (empty) |
| draw/highlight `--points '[[0]]'` (1-tuple) | **400** | `parsePoints` (each pt must be [num,num(,num)]) |
| any `--points '[["a",0]]'` (non-numeric) | **400** | `parsePoints` (finite-number check) |
| any `--points` with `NaN`/`Infinity` | **400** | `parsePoints` (`Number.isFinite`) — belt-and-braces with `T.number` for line |
| any `--points` huge `1e12` | **400** | `parsePoints` (`\|c\| ≤ 1e6`) — **required for draw/highlight**, whose base64 `path` bypasses `T.number` |
| draw/highlight all-coincident (`[[0,0],[0,0]]`, "duplicate-consecutive") | **400** | `parsePoints` (≥2 **distinct** points) |
| draw/highlight stroke with a **consecutive-point jump > 65504px** in x or y (e.g. `[[0,0],[70000,0]]`) | **400**, no record | `buildSegments` Float16-delta ceiling (§7) — line is **immune** (absolute `T.number`) |
| `create draw --fill bogus` | **400** | `DefaultFillStyle` on `put` |
| `update … --frame no-such-frame` | **404** `frame not found` | `findFrameByName` miss (§3) |
| `update … --rotate abc/NaN/Infinity` | **400** | rider guard (§3) → throw → catch `:104` |
| frame rename `--props '{"name":123}'` | **400** (not 500) | `frameShapeProps.name = T.string` on `put`, caught `:294-296` |
| `create frame` no size | **200** (defaults 800×600) | frame branch (§2) — never 400s for missing size (AC2) |
| `GET /api/tools` op / type enums | exactly `create\|update\|delete` / the 8 types | contract enum (§1) — nothing named align/group/eraser/laser/image (AC20) |

> **Degeneracy rule (documented choice).** "≥2 **distinct** points" = the de-duplicated point set has
> ≥2 members. This rejects `[[0,0],[0,0]]` (collapsed blob) and single points, while a valid horizontal
> highlight `[[0,0],[120,0]]` (2 distinct, zero y-extent) **passes** — so the guard is
> *distinctness*, not *both-axes-non-zero*. A stray consecutive duplicate inside an otherwise real path
> is tolerated (still ≥2 distinct). This is the reading that satisfies every concrete AC7/AC19 case.
> `\|c\| ≤ 1e6` rejects `1e12`. Separately, `buildSegments` (draw/highlight) rejects any
> **consecutive-point x/y delta > 65504** — the Float16 delta ceiling, above which a coordinate decodes
> to `Infinity` despite `put` returning 200. Below that ceiling, Float16 delta *precision* (Appendix 7)
> is the fidelity envelope for legal strokes.

---

## 7. Test seams

### Pure module — `server/src/canvas/drawShapes.ts` (+ `drawShapes.test.ts`, `node:assert`)
Repo convention: fiddly logic lives in a plain module with a `node:assert` script (like
`frameNav`/`panelLayout`). Extract:

- **`parsePoints(raw, min): {x,y,z?}[]`** — the single input guard. Throws a typed error when `raw`
  isn't an array, any point isn't `[num,num]`/`[num,num,num]` of **finite** numbers, `|x|` or `|y| >
  1e6`, `raw.length < min`, or fewer than 2 **distinct** points. This is where every AC19 draw/highlight
  case is caught (the schema can't see inside the base64 `path`). RED tests: each bad input throws;
  good input returns the parsed vecs.
- **`buildSegments(localPoints): TLDrawShapeSegment[]`** — draw/highlight only. **First rejects any
  consecutive-point x/y delta `> 65504`** (the Float16 delta ceiling; above it a coordinate encodes to
  `Infinity`) by throwing the typed error → 400; then `compressLegacySegments([{type:'free', points}])`.
  Living here (not in `parsePoints`) keeps `line` immune, since line stores absolute `T.number`. RED
  tests: (a) `b64Vecs.decodePoints(result[0].path)` round-trips back to `localPoints` within **±1px**
  (Float32 first point, Float16 deltas) — the AC5/AC6 "not just it renders" requirement; (b)
  `[[0,0],[70000,0]]` throws (66000+ delta), while `[[0,0],[65000,0]]` and `[[0,0],[120,0]]` pass — the
  empirically-pinned 65504 boundary.
- **`buildLinePoints(localPoints): Record<string, {id,index,x,y}>`** — `getIndicesAbove(null, n)` keys.
  RED test: assert each key is a **valid `IndexKey`** (`T.indexKey.isValid`) and that
  `Object.values(...).sort(sortByIndex)` reproduces input order with `key===id===index` — **do NOT
  assert literal `'a1'/'a2'`**. `getIndicesAbove` jitters keys (a0-based) outside `NODE_ENV==='test'`,
  so in the running server the strings are non-deterministic; assert *validity + order*, or run the unit
  under `NODE_ENV=test` if a stable literal is wanted.
- **`translateForReparent(shape, newParentId, byId): {x,y}`** — `P = pagePoint(shape,byId)`,
  `NP = (byId.get(newParentId) is a shape) ? pagePoint(newParent,byId) : {0,0}`, return `P - NP`.
  (Subsumes the plan's `oldParent` arg — `pagePoint` already walks up via `byId`.) RED test: synthetic
  `byId` with a nested frame; page-point preserved for frame↔page moves.
- Helpers `toLocal(points, origin)` and `originOf(points)` (bbox-min) may live here too, so the
  normalization is unit-tested independently of HTTP.

### HTTP integration — new `server/src/shape-api.test.ts`
Boot the real app in-process (copy the `scribe-api.test.ts:17-82` harness: `createSyncApp({dataDir})`,
`server.listen(0)`, `makeTestClient`, a seeded frame, `documents()` snapshot reader — **no mocks, real
SQLite**). Drive `POST /api/canvas/shape` and `GET /api/canvas/frame(s)`; assert the **decoded** record:

- create frame/line/draw/highlight → record present with right `type`; decode `props.segments`
  (`b64Vecs.decodePoints`) / read `props.points` (sorted by `index`) and assert points == input ±1px in
  page space (`shape.x + local`); bounds/origin per AC7 (AC1, AC4–AC7).
- reparent `--frame` → `parentId` changed, page-point ±1px, `index` valid/at-top (AC8); `--to-page` →
  actual page id, page-point ±1px (AC9); `--rotate`/`--lock` exact + bad rotate → 400 (AC10).
- delete frame default → children survive on the frame's page, unmoved, no dangling `parentId`
  (AC11/AC13); `--with-children` → subtree + bindings gone (AC12/AC13); non-frame delete unchanged
  (AC14).
- read symmetry: `drawings` array/count reflect creates and move on reparent/delete (AC15–AC17).
- error matrix rows (§6) → the exact 4xx (AC19); `GET /api/tools` enums verbatim (AC20); `meta.author`
  stamping on credentialed vs anonymous vs none (AC21).

---

## Appendix — where the real 5.1.0 validators differed from the plan/summary

Confirmations and corrections the reviewer will check:

1. **Frame `color` — CONFIRMED required.** `TLFrameShape.ts:74`, added by `AddColorProp` migration.
   Omitting it throws. Default `'black'`.
2. **Draw `scale` vs `scaleX/scaleY` — REFINED.** The summary lumped them; the file distinguishes:
   `scale: T.nonZeroNumber` (`:131`, must be `>0`) but `scaleX/scaleY: T.nonZeroFiniteNumber`
   (`:132-133`, finite non-zero, may be negative). All three = `1` is safe. Same on highlight
   (`:100-102`).
3. **Highlight — CONFIRMED smaller set** and additionally **has `isComplete` + `isPen`** (`:98-99`),
   which are easy to forget: it's draw minus `fill`/`dash`/`isClosed`, not draw minus everything.
4. **Line — CONFIRMED keyed dict, no handles, no scaleX/scaleY**; `index` must be a real `IndexKey`
   (`T.indexKey`, `validation.ts:1990` — rejects `"1"`/`"2"`). Use `getIndicesAbove(null, n)`; the plan
   said "getIndices … or getIndexAbove chain" — `getIndicesAbove` is the clean n-key call and is a
   **new import** from `@tldraw/utils`.
5. **The base64 hole — ELEVATED.** `DrawShapeSegment.path` is `T.string` (`:34`), so the schema
   validates **nothing** about draw/highlight geometry. All point validation (count, finiteness,
   magnitude, degeneracy) must be server-side in `parsePoints`. Line is partly protected by `T.number`
   in its point validator but still needs the magnitude/count/degeneracy guard (`1e12` is finite).
6. **`T.number` rejects NaN/Infinity — CONFIRMED** (`validation.ts:1167-1182`), so line NaN/Infinity
   points 400 even without the guard; the guard is still needed for draw/highlight and for `1e12`.
7. **Float16 delta encoding — CORRECTED (gate must-fix).** `encodePoints` stores the first point as
   Float32 (exact) and **every subsequent point as a Float16 delta** (`b64Vecs.ts:305-338`). Two
   consequences, empirically round-tripped through the real `compressLegacySegments`:
   - **Hard ceiling (enforced).** Float16 max finite = **65504**; a consecutive delta of 66000 decodes
     to `Infinity` while `put` still returns 200 (path is `T.string`). An absolute `|c| ≤ 1e6` bound
     does **not** catch this (`[[0,0],[70000,0]]` passes it). The original design only bounded absolute
     magnitude — the fix adds a **consecutive-delta cap of 65504 in `buildSegments`** (draw/highlight
     only; line stores absolute `T.number` and is immune), returning 400. This is the one defect that
     failed the adversarial gate; §1's "survives put ⇒ renders unchanged" invariant now holds.
   - **Precision (below the ceiling).** Near the origin ~0.1px, degrading with delta magnitude; the
     `±1px`/`±2px` AC tolerances hold for the tested strokes (small, low-thousands px). A documented
     fidelity envelope, not a bug.
8. **`geo` was never on the read side — NOTED.** `frames.ts` counts note/text/image/terminal/iframe;
   adding the `drawings` bucket (`geo|line|draw|highlight`) also closes a pre-existing geo read gap.
