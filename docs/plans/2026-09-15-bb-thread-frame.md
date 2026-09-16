# BB thread frame — a native canvas control (2026-09-15)

Owner decisions (2026-09-15):

- The right pane renders the host `ThreadChat` with `variant: "timeline"` (read-only, no composer).
- A frame binds to a thread by picking an existing project thread OR spawning a new one seeded from its child shapes' text.
- Membership is creation-time capture only (as plain frames today). Drag-in/out reparenting is a follow-up.
  **DONE (2026-09-16, frame-membership task):** the follow-up landed. A completed select-tool translate now
  settles membership on pointerup (`canvas-editor/src/tools/select.ts`'s `dropTargetIntents`): each dragged
  shape joins the DEEPEST frame-like shape whose membership region contains its world-bounds centre, or is
  released to the page when it has left one. For `bbthread` the membership region is the WORKSPACE
  (`bbthreadWorkspaceLocalBounds`), never the thread pane. `ReparentShapes` now re-expresses the moved
  shape's envelope in its new parent's frame, so a reparent never moves the shape on screen (and undo
  restores the original local envelope). Contracts: `drag-into-frame-reparents`,
  `drag-out-of-frame-releases-to-page`, `frame-keeps-its-children-when-moved`,
  `bbthread-pane-region-does-not-capture`. NOT done: a drop-target highlight on the frame under the drag
  (the plan's optional visual) — deliberately deferred rather than shipped unverified, since no browser is
  available to this task.
- Agent access to the frame's children: a minimal `bb canvas thread-frames` CLI read.
- The old attach-thread / badge / thread-card / thread-overview code is deleted; kv link data is thrown away, no migration.

## Shape: `bbthread`

Shared clean-room kind, added to `canvas-model` `SHAPE_KINDS`. Props: `box` + `name?: string` + `threadId?: string`.
Default size 960×600. Frame-like: hollow interior, header band + edge margin hit, PLUS a solid right pane
(`bbthreadPaneLocalBounds(shape)` = right third of the body below the header). `isFrameLike(kind)` in
`canvas-model/src/geometry.ts` replaces the five literal `=== 'frame'` checks; `canvas-editor` uses it for
creation capture, header rename, and marquee handling.

Tool: `ToolId 'bbthread'`, create tool via `createKindTool('bbthread')`, no keyboard shortcut. Toolbar entry is
plugin-only: `Toolbar` gains an optional `tools` prop (defaults to `TOOL_ORDER`); the BB plugin passes
`[...TOOL_ORDER, { id: 'bbthread', label: 'Thread' }]`. The web app never shows it.

Body: plugin-owned `plugins/canvas/canvas/shapes/BbThreadShape.tsx`, registered via `registerShape('bbthread', …)`
next to `registerCoreShapes()` in `connection-boot.ts` (non-embed; the plugin mounts no EmbedLayer).
Layout: header band (name, like FrameShape), hollow workspace (left two thirds), right pane:
status row (title + status pill from `experimental_useSidebarThreads`), `ThreadChat variant="timeline" layout="contained"`,
footer with "Open full →" (`openThreadFromCanvas`). Unbound: a picker (rpc `canvas_thread_options`) and a
"New thread" button (rpc `canvas_spawn_thread { prompt }` → `UpdateProps { threadId }`). Pane interaction follows
the web app's idle/focused policy: double-click focuses (events swallowed, timeline scrolls), Escape / click-outside exits.
Bound to an archived/deleted thread: pane shows "thread gone" + Unbind (clears `threadId`).

## Server

Keep: `canvas_thread_options` (thread-picker.ts), `agent-project.ts`, thread-return stack, dock/thread-status.
Add: `canvas_spawn_thread { prompt } → { threadId }`.
Delete: `canvas_run_note`, `canvas_attach_thread`, `canvas_unlink_agent`, `canvas_agents`, `canvas_thread_excerpts`,
`agents.ts`, `agent-attach.ts`, `agent-arms.ts`, `agent-menu.ts`, `agents-ui.tsx`, `agents-view.ts` (move `screenBoxFor`
/`promptTextFor` if still needed), `thread-excerpts*.ts`, `thread-overview*.ts(x)`, `panel/agent-sync.tsx`,
`registerAgentEvents`, the gc sweep, `bb canvas agents`, and their tests. README/skill text updated.
CLI: `bb canvas thread-frames [--json]` lists every bbthread shape: id, name, threadId, children (id, kind, text).

## Gates

`bun run typecheck`; contracts (`bun test.ts` in canvas-editor); plugin `npm run typecheck && npm test && npm run
audit:quality:compare && bb plugin build .` — the deletion breaks the frozen baseline, so re-baseline explicitly.
Interaction contract: `bbthread-pane-is-solid` (a drag starting in the pane translates the shape; one in the
workspace does not). RED recorded before the model/editor change lands.

**Re-baseline note (2026-09-15, shape-body task).** `quality-audit-baseline.json`'s three drift invariants
(`productionTokenLines`, `decisionPoints`, `localImportCycleCount`) are refreshed to this branch's numbers
(9835 / 1149 / 0) — the launch-or-attach deletion (dc70212) plus this task's `BbThreadShape.tsx`/
`bbthread-model.ts`/`bbthread-host.ts` addition moved both far enough from the frozen `ee79ab4` snapshot
(11303 / 1153) to trip the ±5%/no-more-than-5%-drop checks. `moduleDebt`/`functionDebt`/`totalDebt` are
DELIBERATELY left pointing at the original `ee79ab4` numbers (2990 / 2283 / 5273), not reset to this branch's
own near-zero debt (33, all of it pre-existing in `canvas/dock/model.ts`, untouched by this task): the
improvement percentage is a standing "how far we've come since ee79ab4" record, and resetting it to a
current already-low number would make `(frozen.totalDebt - result.totalDebt) / frozen.totalDebt` read 0% the
moment nothing new is added — failing a check whose job is to catch NEW debt, not to demand improvement on
top of improvement. `npm run audit:quality:compare` passes as of this note (99.37% improvement vs `ee79ab4`,
0% drift on all three invariants).

## Pane input routing (2026-09-15, follow-up after live test)

Scrolling and selecting inside the pane did not work. Causes: the viewport's native non-passive `wheel`
listener runs before any React-level `stopPropagation`; pointer capture on pointerdown retargets `click`/
`dblclick` at the viewport so the body's double-click never fires; the shape wrapper sets `user-select: none`;
and while `editingId` is set the session drops every shortcut including Escape (text shapes exit editing via
their textarea's own Escape/blur, which the pane has none of).

Decision: "interacting with a thread pane" is an EDITOR STATE, decided at the input funnel, not fought from
inside the body.

- `EditorState.editingRegion: 'name' | 'body' | null` (null iff `editingId` is null). `BeginEdit` gains
  `region?: 'name' | 'body'` (default `'body'`). Frame header rename sends `'name'`; `FrameNameEditor` mounts
  only for `'name'`.
- Select tool: a double-click inside a bbthread's pane (`bbthreadPaneLocalBounds`) → `SetSelection` +
  `BeginEdit { region: 'body' }`. A pointerdown on anything other than the editing shape ends the edit
  (`EndEdit` first, then the normal pointing transition). Escape while editing → `EndEdit` (new `endEdit`
  shortcut command; `resolveShortcut` no longer returns null for Escape while editing).
- Viewport yield rule (canvas-react, one place): if a DOM event's target is inside an element carrying
  `data-canvas-interactive`, pointer events are neither captured nor forwarded, wheel is neither forwarded nor
  `preventDefault`ed, and keys are forwarded only when `key === 'Escape'`.
- Body: sets `data-canvas-interactive` and `user-select: text` on the pane only while
  `editingId === shape.id && editingRegion === 'body'`; otherwise shows a "Double-click to read · Esc to leave"
  hint. Its memo comparator includes `editingId`/`editingRegion`. The local idle/focused reducer is removed.

Contracts (FSM): `bbthread-pane-double-click-begins-editing`, `bbthread-escape-ends-editing`,
`editing-ends-on-outside-click` (text shape; today the FSM never ends an edit on an outside click — the DOM
textarea blur does). All three RED before the change.

## Resizable pane (2026-09-15, owner request)

The pane's left edge is draggable. Width is a synced shape prop, not local UI state.

- canvas-model: `bbthread` props += `paneFraction?: number`. `BBTHREAD_PANE_MIN_FRACTION = 0.2`,
  `BBTHREAD_PANE_MAX_FRACTION = 2/3`, `BBTHREAD_PANE_FRACTION` stays the default (1/3).
  `paneFractionOf(shape)` = clamp(prop ?? default). `bbthreadPaneLocalBounds`/`bbthreadWorkspaceLocalBounds`
  use it. `BBTHREAD_DIVIDER_MARGIN = 6` (local px each side of the pane's left edge, below the header);
  `isPointOnBbthreadDivider(doc, shape, worldPoint)`. `hitTestPoint` treats the divider band as a hit.
- canvas-editor select tool: pointerdown on a bbthread's divider enters a `resizingPane` mode (takes
  precedence over translate); each move emits `UpdateProps { paneFraction: clamp((w - localX) / w) }`;
  pointerup returns to idle. Escape/cancel drops the mode (props already committed per move, like translate).
- Obs: `shapeProp(id, key): unknown` added to the interface and BOTH adapters (fsm-runner reads the editor doc;
  e2e/lib/contracts.ts reads the page's doc the same way shapeDisplacement does).
- Contracts (FSM): `bbthread-divider-drag-resizes-pane` (900×600 frame, divider at x=600; drag to x=450 →
  paneFraction 0.5 and shape displacement 0) and `bbthread-divider-drag-clamps-at-two-thirds` (drag to
  x=100 → paneFraction 2/3, displacement 0). Both RED today: the divider lies in the solid pane, so the drag
  translates the frame.
- Plugin body: draws a divider strip as a SIBLING of the pane div (never inside the interactive element, so
  the drag is forwarded to the canvas even while the pane is focused), `cursor: ew-resize`, positioned over the
  pane's left edge; layout follows `paneFractionOf`.
