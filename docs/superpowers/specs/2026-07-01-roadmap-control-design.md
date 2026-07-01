# Roadmap control — design

**Date:** 2026-07-01
**Status:** approved (brainstorming session; simplified after sub-agent review)
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

A sub-agent over-engineering review then trimmed the elaboration (none of the
five decisions changed): JSON-file store instead of SQLite, ops vocabulary
reduced to `replace`/`set`/`move`, CLI reduced to a JSON ops passthrough,
server-side shape placement (`--place`) dropped, endpoints collapsed to two,
toolbar binding via name prompt, `move` addressing by index only.

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
- `meta.updated` is stamped by the server on every write; client-supplied
  values are ignored.
- **Keys** (`O3`, `O3.I1`, `O3.I1.F2`) are unique across the whole document and
  are the addressing scheme for patch ops and CLI commands. The server
  validates uniqueness on every write.
- **Identity:** a roadmap is `(room, id)`; `id` is a slug of the human `name`
  ("EnsembleWorks Roadmap" → `ensembleworks-roadmap`), validated by the
  existing `sanitizeId` rules. CLI addresses roadmaps by fuzzy name match.
- **Storage:** one JSON file per roadmap, following the `transcript-store.ts`
  precedent: `DATA_DIR/roadmaps/<room>/<id>.json` holding
  `{name, rev, updated, data}`. Whole-file read/write in a small
  `roadmap-store.ts` module; documents are a few KB and the server is
  single-process, so writes are serialized per request. Roadmap content is
  **not** stored in the tldraw document.
- **Concurrency:** `rev` is a monotonic integer bumped on every successful
  write. Patch ops are targeted so concurrent human/agent edits interleave
  without clobbering. Wholesale replace accepts optional `ifRev`; a stale
  guard returns `409` with the current rev. Each ops request is atomic.

## §2 Server API and patch ops

Two endpoints in `createSyncApp` (`server/src/app.ts`), following the existing
validate → `getOrCreateRoom` → `{ok:true,…}` pattern:

| Endpoint | Purpose |
|---|---|
| `GET /api/roadmap?room=[&name=]` | Without `name`: list roadmaps (id, name, rev, updated). With `name`: full document + rev, fuzzy name match (case-insensitive `includes`), like `/api/frame`. |
| `POST /api/roadmap` | Atomic batch of ops. Body `{room, name, ops: […], ifRev?}`. Creates the roadmap when the first op is `replace` and it doesn't exist yet. |

Op vocabulary (ops address nodes by `key`):

- `{op:"replace", data:{…}}` — wholesale create/replace of the document.
  Validates schema + key uniqueness.
- `{op:"set", key, fields:{status? | done? | title? | why? | statement? | text?}}`
  — field updates; covers status cycling, metric done-toggling, and text
  tweaks.
- `{op:"move", key, zone?, index?}` — outcomes move across zones and/or
  reorder; initiatives/metrics/features reorder within their parent by index.

Structural changes (adding/removing outcomes, initiatives, metrics, features)
are done by regenerating the document and pushing a `replace` — the `/roadmap`
skill owns structure via `docs/ROADMAP.md`, so dedicated add/remove ops are
not needed in v1.

**Human edits use the same endpoint:** a drag or status-click in the shape
component POSTs one op. One write path → one validation and one conflict
story for humans and agents alike.

**Change signal (rev fan-out):** after any successful write the server stamps
the new `rev` onto `props.rev` of every `roadmap` shape whose `roadmapId`
matches, via `room.updateStore` (the `/api/terminal-status` mechanism).
tldraw sync broadcasts the prop change; clients refetch over HTTP. No polling,
no extra websocket.

**Shape creation:** toolbar only, following the `createDevServerShape`
precedent — the toolbar button prompts for a roadmap name, slugs it, and
creates a shape with that `roadmapId`. The shape renders its empty state until
data is pushed to that name. No server-side shape placement.

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
`die` on bad args, no jq). Four subcommands; writes are a JSON passthrough in
the style of the existing `canvas shape '<json>'`:

```
canvas roadmap list
canvas roadmap read <name>                          # full JSON + rev on stdout
canvas roadmap push <name> <file.json> [--if-rev R] # sugar for ops '[{"op":"replace",…}]'
canvas roadmap ops  <name> '<ops-json>' [--if-rev R]
```

Mapping to a `/roadmap` skill: INIT/REFRESH → generate JSON from
`docs/ROADMAP.md`, `push --if-rev`; BUMP → a small `ops` batch of
`set`/`move`; before a REFRESH, `read` to fold human re-prioritisation
(zone moves, reordering, status clicks) back into `ROADMAP.md`.

## §5 Errors, testing, scope cuts

**Errors:** 400 malformed schema/op; 404 unknown roadmap or key (error names
the missing key); 409 stale `ifRev` (response carries current rev; CLI prints
it and exits non-zero so callers can re-read and retry). Ops batches are
all-or-nothing. The shape renders an empty state ("no roadmap data / server
unreachable") rather than crashing.

**Testing:** in-process HTTP tests in the `canvas-api.test.ts` style —
replace (create + overwrite), `set` and `move` op behaviour, key-uniqueness
rejection, failing-batch atomicity, `ifRev` conflict, rev fan-out onto a
seeded roadmap shape. The design project's `roadmap.json` seeds the test
fixture. Client-side, keep the view-builders as plain functions unit-testable
without tldraw.

**Docs to update:** `.claude/skills/canvas/SKILL.md`,
`deploy/agent-home/AGENTS.md`.

**Out of scope (v1):** inline text editing on canvas; add/remove items from
the canvas UI (and dedicated add/remove ops — structure changes go through
`replace`); server-side shape placement; synced per-user view state;
roadmap-data history/undo (git owns history via `ROADMAP.md`); auto-sync
between `docs/ROADMAP.md` and the canvas (that orchestration belongs to the
`/roadmap` skill, not this control).
