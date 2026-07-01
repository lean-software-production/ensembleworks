# Roadmap control — design

**Date:** 2026-07-01
**Status:** approved (brainstorming session)
**Visual design source:** claude.ai/design project "React roadmap component design"
(`https://claude.ai/design/p/168df00e-9e91-44a3-af1b-7bc6bf3982b0?file=Roadmap.dc.html`) — the
`Roadmap.dc.html` design component and its `roadmap.json` sample data.

## Goal

Add a native **roadmap control** to the EnsembleWorks canvas — a zoned board
(Done / Now / Next / Later) of outcome columns, each holding initiatives with
metrics and features — and extend the `bin/canvas` CLI so agents (e.g. a
`/roadmap` skill that maintains `docs/ROADMAP.md` in a project repo) can
populate, patch, and read it back.

## Decisions (from brainstorming)

1. **Edit model: two-way.** Roadmap data lives server-side per room. Agents
   write via the CLI; human edits on the canvas persist and agents read them
   back.
2. **CLI writes: replace + patch.** Wholesale `push` for INIT/REFRESH-style
   flows, targeted key-addressed ops for incremental updates.
3. **Cardinality: multiple named roadmaps per room**, addressed by fuzzy name
   match like frames.
4. **Human edits in v1:** drag-reorder, drag outcomes across zones,
   collapse/expand, filter, copy-key — plus **click a status glyph to cycle**
   `planned → in-progress → done` (metric glyphs toggle `done`). The cycle
   skips `parked` — parking is a deliberate act done via the CLI/agent. No
   inline text editing or add/remove from the canvas UI.
5. **Architecture: custom `roadmap` shape + server-side roadmap store**
   (Approach A). Shape props hold a small reference; content rides HTTP —
   per the two-planes rule in `docs/architecture-spec.md`.

## §1 Data model, identity, storage

Wire format is the design project's `roadmap.json` schema, adopted verbatim:

```
meta:       { title, revision, updated }
outcomes[]:  { key, zone: done|now|next|later, status, title, why, initiatives[] }
initiative:  { key, title, status, statement, metrics[], features[] }
metric:      { key, text, done: boolean }
feature:     { key, text, status }
```

- `status ∈ planned | in-progress | done | parked` (all four already render in
  the design component).
- **Keys** (`O3`, `O3.I1`, `O3.I1.F2`) are unique across the whole document and
  are the addressing scheme for patch ops and CLI commands. The server
  validates uniqueness on every write.
- **Identity:** a roadmap is `(room, id)`; `id` is a slug of the human `name`
  ("EnsembleWorks Roadmap" → `ensembleworks-roadmap`), validated by the
  existing `sanitizeId` rules. CLI addresses roadmaps by fuzzy name match.
- **Storage:** a `roadmaps` table in the sync server's SQLite
  (`room, id, name, json, rev, updated_at`), alongside existing room
  persistence. Roadmap content is **not** stored in the tldraw document.
- **Concurrency:** `rev` is a monotonic integer bumped on every successful
  write. Patch ops are targeted so concurrent human/agent edits interleave
  without clobbering. Wholesale replace accepts optional `ifRev`; a stale
  guard returns `409` with the current rev. Each ops request is atomic.

## §2 Server API and patch ops

All endpoints in `createSyncApp` (`server/src/app.ts`), following the existing
validate → `getOrCreateRoom` → `{ok:true,…}` pattern:

| Endpoint | Purpose |
|---|---|
| `GET /api/roadmaps?room=` | List: id, name, rev, updated, counts. |
| `GET /api/roadmap?room=&name=` | Full document + rev. Fuzzy name match (case-insensitive `includes`), like `/api/frame`. |
| `PUT /api/roadmap` | Create or wholesale-replace. Body `{room, name, data, ifRev?}`. Validates schema + key uniqueness. |
| `POST /api/roadmap/ops` | Atomic batch of patch ops. Body `{room, name, ops: […]}`. |

Patch-op vocabulary (each op addresses a node by `key`):

- `{op:"set", key, fields:{status? | done? | title? | why? | statement? | text?}}`
- `{op:"move", key, zone?, before?|after?|index?}` — outcomes move across
  zones and/or reorder; initiatives/metrics/features reorder within parent.
- `{op:"add", kind, parent?, item:{…}}` — server rejects duplicate keys.
- `{op:"remove", key}`
- `{op:"set-meta", fields:{title? | revision? | updated?}}`

**Human edits use the same endpoint:** a drag or status-click in the shape
component POSTs one op. One write path → one validation and one conflict
story for humans and agents alike.

**Change signal (rev fan-out):** after any successful write the server stamps
the new `rev` onto `props.rev` of every `roadmap` shape whose `roadmapId`
matches, via `room.updateStore` (the `/api/terminal-status` mechanism).
tldraw sync broadcasts the prop change; clients refetch over HTTP. No polling,
no extra websocket.

**Shape creation — two doors:**

- Toolbar button (humans): binds to the room's most recently updated roadmap,
  or creates an empty "Roadmap" if none exist.
- `canvas roadmap push … --place [frame]` (agents): after writing the doc,
  creates a shape bound to it (in the named frame, else near the live cursor)
  unless one already exists for that roadmap.

## §3 Client shape

`client/src/roadmap/RoadmapShapeUtil.tsx`, following the terminal-shape recipe:

- `BaseBoxShapeUtil` subclass, `type = 'roadmap'`, props `{w, h, roadmapId, rev}`
  with `T` validators and the `TLGlobalShapePropsMap` augmentation; mirrored
  entry in `server/src/schema.ts` with the "keep in sync" comment (`rev`
  optional — no migration).
- Component is a **React port of `Roadmap.dc.html`**: `sc-for`/`sc-if` become
  maps/conditionals; the `DCLogic` view-builders (`zonesView`, `viewOutcome`,
  drag core, glyph/chip mappers) carry over nearly verbatim. Design tokens are
  copied into a scoped `client/src/roadmap/roadmap.css`; no DC runtime
  (`support.js`) dependency.
- **Data:** fetch `/api/roadmap` on mount; refetch when `props.rev` changes.
  Human edits apply optimistically to local state and POST the op; the rev
  bump reconciles all clients.
- **Interaction gating** as terminals: double-click to enter edit mode
  (drag/filter/status-click active), double-Esc to exit; otherwise the shape
  pans/selects normally.
- **View state** (filter, collapse, drag hover, copied toast) is local per
  client — not part of the document.
- Toolbar registration in `client/src/ui.tsx` (factory + tools entry + menu
  item), like neko.

## §4 CLI surface

New `roadmap` command family in `bin/canvas` (bash + curl, local validation,
`die` on bad args, no jq):

```
canvas roadmap list
canvas roadmap read  <name>                        # full JSON + rev on stdout
canvas roadmap push  <file.json> [--name N] [--if-rev R] [--place [frame]]
canvas roadmap set   <key> [--status S] [--done true|false]
                           [--title T] [--why W] [--statement S] [--text T]
canvas roadmap move  <key> [--zone Z] [--before K | --after K | --index N]
canvas roadmap add   <kind> [--parent K] --json '<item-json>'
canvas roadmap remove <key>
```

Mapping to a `/roadmap` skill: INIT/REFRESH → generate JSON from
`docs/ROADMAP.md`, `push --if-rev`; BUMP → a few `set`/`move` calls; before a
REFRESH, `read` to fold human re-prioritisation back into `ROADMAP.md`.

## §5 Errors, testing, scope cuts

**Errors:** 400 malformed schema/op; 404 unknown roadmap or key (error names
the missing key); 409 stale `ifRev` (response carries current rev; CLI prints
it and exits non-zero so callers can re-read and retry). Ops batches are
all-or-nothing. The shape renders an empty state ("no roadmap data / server
unreachable") rather than crashing.

**Testing:** in-process HTTP tests in the `canvas-api.test.ts` style —
create/replace, each op type, key-uniqueness rejection, failing-batch
atomicity, `ifRev` conflict, rev fan-out onto a seeded roadmap shape. The
design project's `roadmap.json` seeds the test fixture. Client-side, keep the
view-builders as plain functions unit-testable without tldraw.

**Docs to update:** `.claude/skills/canvas/SKILL.md`,
`deploy/agent-home/AGENTS.md`.

**Out of scope (v1):** inline text editing on canvas; add/remove items from
the canvas UI; synced per-user view state; roadmap-data history/undo (git owns
history via `ROADMAP.md`); auto-sync between `docs/ROADMAP.md` and the canvas
(that orchestration belongs to the `/roadmap` skill, not this control).
