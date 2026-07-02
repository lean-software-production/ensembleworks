---
name: debugging-roadmap-control
description: Use when debugging or testing the roadmap canvas control — drag-and-drop not working, filter/status-click/rev-refetch misbehaving, or when an interaction needs headless browser verification end-to-end.
---

# Debugging the Roadmap Control

Two planes: **content** lives server-side (`server/src/roadmap-store.ts`) behind
`GET/POST /api/roadmap`; the tldraw shape holds only `{roadmapId, rev}` and
refetches when the server stamps a new `rev` onto it after each write.
**Ground truth is the server doc** — the UI renders optimistically, so verify
every interaction by rev bump + data change, never by screenshot alone.

## Data plane (no browser)

```bash
export CANVAS_URL=http://localhost:5173   # vite proxies /api (sync server: :8788)
export CANVAS_ROOM=debug-roadmap          # NEVER 'team' — that's the live roadmap
bin/canvas roadmap list|read|push|ops ... # see canvas --help
```

`roadmap read` first — the scratch room may already hold a usable doc. If
seeding, use ≥2 initiatives in ONE outcome with mixed statuses — drag
containers are per-parent, so one-initiative-per-outcome fixtures can't
exercise initiative reorder at all.

## UI plane (headless probe)

`probe.mjs` (this skill's directory) drives the shape and already encodes the
traps: blocking prompts, toolbar overflow, pointer-events edit gating, manual
HTML5 drag, POST logging + server rev diff. One-time setup per machine is in
`docs/headless-browser.md`; then run **from the playwright dir**:

```bash
cd /tmp/canvas-probe
node <repo>/.claude/skills/debugging-roadmap-control/probe.mjs drag "feature wip" "feature planned"
# → POSTs: {"op":"move","key":"O1.I1.F2","index":1}   server rev: 10 -> 11
node <repo>/.../probe.mjs click 'css=[title="Cycle status"]'   # cycles a status
```

Commands: `shot [file]` · `click <text|css=SEL>` · `drag <fromText> <toText>` ·
`eval <js>` (escape hatch — runs JS in the editing page); selector contracts
are in the file header. The pass signal is the POST + rev bump (a drag that
lands back in the same slot still posts a move); `POSTs: none` + flat rev =
the interaction never reached the server.

## The tldraw drag-and-drop fact (hard-won)

tldraw's `useDocumentEvents` installs a native bubble-phase `dragover`/`drop`
listener on its container that **stops propagation of every such event** and
re-dispatches a clone onto `.tl-canvas` (its file-drop plumbing). So inside any
tldraw shape:

- React `onDragOver`/`onDrop` **never fire** — only `dragstart`/`dragend` get
  through. Use the capture-phase props (`onDragOverCapture`/`onDropCapture`),
  and since capture dispatches outermost-first, guard every handler on the
  drag's type + container before claiming the event (see the drag core in
  `client/src/roadmap/RoadmapShapeUtil.tsx`).
- Duplicate events targeting `.tl-canvas` in document-level instrumentation
  are the re-dispatched clones — expected noise.
- A native event reaching `document` does NOT mean React handlers ran. To see
  what the component executed, add temporary `console.log`s to its handlers
  (vite hot-reloads) or watch the probe's POST log.

## Common mistakes

- Dragging across containers (e.g. initiative → another outcome) and
  concluding drag is broken: cross-container moves are unsupported by design;
  guards ignore them silently.
- Grepping `node_modules/tldraw/dist-*` for behavior: packages hoist to the
  repo root and ship readable source in `node_modules/@tldraw/*/src/`.
- Suspecting `model.ts` for interaction bugs: it's pure and unit-tested
  (`npx tsx src/roadmap/model.test.ts`); interaction bugs live in the
  ShapeUtil ↔ tldraw boundary.
