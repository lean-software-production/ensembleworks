# BB thread frame — a native canvas control (2026-09-15)

Owner decisions (2026-09-15):

- The right pane renders the host `ThreadChat` with `variant: "timeline"` (read-only, no composer).
- A frame binds to a thread by picking an existing project thread OR spawning a new one seeded from its child shapes' text.
- Membership is creation-time capture only (as plain frames today). Drag-in/out reparenting is a follow-up.
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
