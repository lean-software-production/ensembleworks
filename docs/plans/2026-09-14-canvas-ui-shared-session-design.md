# Canvas UI — one shared session layer for every canvas v2 host

**Status:** design approved by the owner, 2026-09-14. No implementation yet.
Recorded here because Relay (`RELAY_URL`) was not configured in the
authoring shell; move it onto a card if one is created.

## Problem

Canvas v2 has two hosts, and each has its own copy of the layer between the
shared packages and the screen:

- the EnsembleWorks web app's v2 mount, `client/src/canvas-v2` (about 5,300
  lines), which received the 2026-09-13/14 polish run
  (`docs/plans/2026-09-14-canvas-v2-polish.md`);
- the bb Canvas plugin, `plugins/canvas/canvas/panel` plus
  `plugins/canvas/canvas/tool-loop.ts` (about 1,700 lines), an earlier
  reimplementation that has drifted (its tool loop differs from the web app's
  by 411 lines; it has no arrow/draw/line tools and no style panel).

Installing the plugin on a live bb instance showed the result: the polish
that lives in shared packages (shape bodies, handles, hover, text-editor
behaviour) arrived, and everything that lives in the web app's session layer
(style panel, arrow tool, shortcuts, autosize, frame rename, handwriting font)
did not. The plugin also regressed: its own tool loop never switches back to
Select after a create-then-edit, so the next click creates another note.

## Decisions (owner, 2026-09-14)

1. **Both hosts stay.** The web app's v2 mount and the bb plugin both mount
   the shared layer.
2. **Split pure and React.** Pure session logic moves into `canvas-editor`;
   React chrome goes into a new `canvas-ui` package.
3. **CSS variables plus layout slots.** Shared chrome reads `--canvas-ui-*`
   custom properties; each host maps its theme onto them and decides placement.
4. **Authoring-core scope.** Everything that decides how editing feels moves;
   page switcher, presence, image upload and embeds stay host-owned.

## Design

### Layers

**1. Pure session logic — `canvas-editor` (clean-room).** Moved from
`client/src/canvas-v2/{tool-loop,tool-shortcut,style-axes}.ts`:

- the tool set for all 9 tools (select, hand, note, text, geo, frame, arrow,
  draw, line), `createInitialToolStates`, `dispatchToActiveTool`,
  `cancelActiveTool`, `currentSnapResult`;
- `shouldFallBackToSelect` (create-then-edit returns control to Select);
- `deleteSelectionIntents`, `pruneDanglingSelectionIntents`;
- a keyboard resolver: key event plus editor state in, a command out (tool
  letter, Escape, Delete/Backspace, undo/redo, select-all, copy/cut/paste,
  z-order). The select tool keeps owning arrow-key nudge;
- style-axes: relevant axes for a selection or armed tool, current value,
  per-kind defaults.

No DOM, React, clock or PRNG access, so the FSM contract runner exercises it.

**2. Shared React chrome — new `canvas-ui` package.** Depends on
`canvas-editor`, `canvas-react`, `canvas-model`; never on a transport or host.

- `useCanvasSession({ editor, toolContext, host })` — owns active tool and
  tool states, routes Viewport input through the resolver or the active tool,
  applies intents, handles cancel on blur/pointercancel/tool switch, clears
  hover on tool switch.
- `CanvasSurface` — composes `Viewport`, `WorldLayer`, `ShapeLayer`,
  `TextEditor` (with autosize), `FrameNameEditor`, `Overlay` and
  `StylePanel`, with slots: `toolbar` placement, `worldLayers` (e.g. the
  plugin's agent layer), `overlays` (e.g. the web app's editing indicators and
  dev overlay).
- `Toolbar` (icon buttons, tooltips with shortcut letters, `role="toolbar"`,
  `aria-pressed`), `StylePanel` and its icons, and the canvas fonts.
- Styling reads a documented set of `--canvas-ui-*` custom properties with
  defaults equal to the web app's current look. *As shipped:* there is no
  `canvas-ui.css`. Chrome styles are inline React styles whose values are
  `var(--canvas-ui-*, <web-app default>)` (`canvas-ui/src/theme.ts`,
  `UI_VARS`). A host sets the properties on an ancestor element; the plugin
  maps them to bb tokens inline in `plugins/canvas/canvas/theme.ts`.

**Host port — `CanvasHost`.** Kept deliberately small:

- `clipboard.read(): Promise<string>` / `clipboard.write(text): Promise<void>`;
- `notify(message)` for user-visible failures (toast in the plugin);
- `onCursorScreen(point)` for the host's presence publisher.

**3. Hosts.**

- **Web app** (`client/src/canvas-v2`): WebSocket transport, presence,
  `PageSwitcher`, dev overlay, embeds and their lifecycles, image paste/drop
  and asset upload, identity. Maps nothing (defaults are its look).
- **bb plugin** (`plugins/canvas`): bb rpc/realtime transport, bb theme tokens
  mapped onto `--canvas-ui-*` (light and dark), page tabs, agent layer,
  speaker rings, thread cards and return navigation, dock, bottom-dock
  toolbar placement. Adds `canvas-ui` as a `file:../../canvas-ui` dependency.

### Input and focus flow

DOM input → `Viewport` → `useCanvasSession` → keyboard resolver or the active
tool's FSM → intents → `editor.applyAll` → doc → host transport syncs.

*As shipped* (`canvas-ui/src/use-canvas-session.ts`, `keyboard-scope.ts`):
focus is not moved back to the canvas when an edit ends; it falls to `body` as
before. Instead keydowns reach the session two ways:

- Keydowns inside the viewport go through the `Viewport`'s own `onKeyDown` to
  `handleInput`: shortcuts first, then the active tool.
- A document `keydown` listener handles everything else inside the host's
  keyboard scope (`keyboardScopeRef`: the web app's root, the plugin's panel).
  It ignores editable targets and anything the viewport already handled.
  Shortcuts (Delete, Escape, undo, clipboard, reorder, tool letters, select
  all) run from any in-scope target, including a focused toolbar button or
  page tab. Other keys go to the active tool, except that on a focused chrome
  control Enter and Space (its activation keys) and keys the control already
  `preventDefault`ed stay with the control: Enter on a focused toolbar button
  or page tab activates it and does not begin editing the selection, while
  arrow nudge still works from a focused toolbar button. An Enter that begins
  an edit from `body` is `preventDefault`ed so no newline lands in the new
  text editor.
- A `body`-targeted keydown counts as in scope only while the user's last
  `pointerdown` or `focusin` landed inside the scope (initially true). After
  editing text, focus on `body` still runs canvas shortcuts. After clicking
  another bb pane, Backspace or Ctrl+C there does not act on the canvas.

This removes the plugin's old failure where, after editing text, every canvas
shortcut stopped working until the user clicked the canvas.

### Migration (each stage leaves both hosts green)

1. **Pure logic into `canvas-editor`.** Move with their tests; the web app
   imports from `canvas-editor`. No behaviour change.
2. **Create `canvas-ui` and adopt it in the web app.** Extract the toolbar
   from `CanvasV2App.tsx`; move `StylePanel`, `style-icons`, fonts and the
   session wiring. Visual goldens unchanged.
3. **Adopt `canvas-ui` in the plugin.** Delete `plugins/canvas/canvas/tool-loop.ts`,
   `panel/session-input.ts` and the toolbar markup in `panel/session-view.tsx`;
   map bb theme tokens; keep bottom-dock placement via the toolbar slot.
   (No CSS file ships, so there was no sibling-package CSS bundling to verify;
   see Layers.)
4. **Fix the cross-page arrow bug in the shared renderer.**
   `canvas-react/src/overlay/Arrows.tsx` draws every arrow in the room
   regardless of page (same code on `main`); filter by `pageIdOf` like
   `ShapeLayer` does. Then run the live-bb browser check (below).

### Testing

- FSM contract lane covers the moved pure logic.
- The web app's browser contract lane remains the browser proof for
  `canvas-ui` (it mounts the same components the plugin mounts).
- `canvas-ui/src/use-canvas-session.test.ts` mounts `useCanvasSession` +
  `CanvasSurface` in happy-dom with a real `Editor` and a fake `CanvasHost`
  (scope-gated Backspace, clipboard write and failure notice, Enter/Space and
  arrows on a focused chrome button versus `body`). The plugin keeps static-render
  vitest checks (`plugins/canvas/tests/shared-surface.test.ts`); plugin
  typecheck, tests, `npm run audit:quality:compare`, `bb plugin build .`.
- A checked-in live-bb browser smoke script beside
  `plugins/canvas/tests/live-smoke.ts`, run by hand against a running bb.
- No new source-text wiring guards.

### Risks

- ~~`bb plugin build` bundling CSS from a sibling package is unproven.~~
  Did not arise: canvas-ui ships no CSS file (inline `var()` styles only), so
  the plugin still imports only TypeScript from siblings.
- The ew-lsp-001 deploy recipe must sync `canvas-ui` alongside the other
  canvas packages, because bb rebuilds the frontend bundle from source on
  reload.

### Out of scope

Unifying page switcher or presence, image upload in the plugin, embeds in the
plugin, and the six unstarted polish tasks (live marquee, frame reparent, drag
modifiers, toolbar icons beyond this extraction, context menu, geo hit-test).

### Mockups

None. `docs/designs/` does not exist. The reference look is the web app's
current polished chrome, tinted per host through the CSS variables.

## Acceptance criteria

### 1. The plugin exposes the polished tools and style panel
1. `bb plugin reload canvas`, open **Canvas** in the bb sidebar, and create a new page.
2. Look at the toolbar.
3. Expect: icon buttons for Select, Hand, Note, Text, Shape, Frame, Arrow, Draw and Line, each with a tooltip naming its shortcut letter.

### 2. Colour and font can be changed in the plugin
1. In the plugin canvas, create a note and press Escape.
2. Click the note, then pick a blue swatch and the Serif font in the style panel.
3. Expect: the note turns blue and its text renders in a serif face.

### 3. Note tool returns to Select after typing in the plugin
1. In the plugin canvas, click the Note tool, click the canvas, type "hello", press Escape.
2. Click an empty area of the canvas.
3. Expect: no second note is created, and the Select tool is the pressed toolbar button.

### 4. Shortcuts keep working after editing text in the plugin
1. In the plugin canvas, create a note, type "undo me", press Escape.
2. Press Ctrl+Z without clicking anything, then keep pressing it.
3. Expect: the first press changes the note's text, and continued presses remove the
   note (undo is recorded per edit).

### 5. Arrows stay on their own page
1. In the plugin canvas, draw an arrow on one page.
2. Open another page from the tabs, or create a new one.
3. Expect: no arrow is drawn on the other page.

### 6. Long note text grows the note in the plugin
1. In the plugin canvas, create a note and type three sentences.
2. Press Escape.
3. Expect: the note is taller than it is wide and no text is cut off at the bottom.

### 7. The plugin follows bb's theme
1. Switch bb to dark appearance and open the plugin canvas with a note selected.
2. Look at the toolbar and style panel.
3. Expect: both render with dark backgrounds and light text, not the web app's light panel colours.

### 8. The web app is unchanged
1. From `e2e/`, with ports 8788 and 5273 free, run `bunx playwright test --project=e2e`.
2. Wait for the run to finish.
3. Expect: every test passes, including the visual goldens and the v1-vs-v2 parity gate.

### 9. There is one copy of the session layer
1. From the repo root, run `ls plugins/canvas/canvas/tool-loop.ts plugins/canvas/canvas/panel/session-input.ts client/src/canvas-v2/tool-loop.ts client/src/canvas-v2/StylePanel.tsx`.
2. Read the output.
3. Expect: every path reports "No such file or directory".

### 10. Plugin and repo gates pass
1. Run `bun run typecheck` and `bun run test` at the repo root, then `npm run typecheck && npm test && npm run audit:quality:compare && bb plugin build .` in `plugins/canvas`.
2. Read the exit codes.
3. Expect: all exit 0, apart from the two server loopback tests that cannot open a tmux socket inside an agent sandbox.

## Verification (2026-09-14, after the final-review fix wave)

Live bb smoke (`e2e/scripts/bb-canvas-smoke.mjs` against bb `0.43.0`), plugin reloaded from this branch (`bb plugin reload canvas`, exit 0), script exit 0. The script now deletes only the page ids it created, and runs AC7 twice: in bb's current (light) appearance, and in a Playwright context emulating the dark colour scheme.

```
tabs before run: ["First Page","Discovery","LinkedIn Ads"]
tabs after cleanup: ["First Page","Discovery","LinkedIn Ads"]
PASS  AC1 nine icon tools with shortcut tooltips  [{"id":"select","title":"Select (V)","icon":true},{"id":"hand","title":"Hand (H)","icon":true},{"id":"note","title":"Note (N)","icon":true},{"id":"text","title":"Text (T)","icon":true},{"id":"geo","title":"Shape (R)","icon":true},{"id":"frame","title":"Frame (F)","icon":true},{"id":"arrow","title":"Arrow (A)","icon":true},{"id":"draw","title":"Draw (D)","icon":true},{"id":"line","title":"Line (L)","icon":true}]
PASS  AC3 note tool returns to Select; next click creates nothing  tool=select notes=1
PASS  AC2 colour and font change  {"styleBefore":{"background":"rgb(252, 225, 156)","font":"tldraw_draw, sans-serif"},"styleAfter":{"background":"rgb(138, 163, 255)","font":"tldraw_serif, serif"},"docProps":null}
PASS  AC7 style panel matches bb appearance and uses the bb mapping (default scheme)  panel=rgb(239, 241, 245) body=rgb(239, 241, 245) bodyDark=false
PASS  AC6 long note text grows the note  {"w":200,"h":299,"scroll":299,"client":299}
PASS  AC4 Ctrl+Z works after editing without clicking (first press edits text, repeated presses remove the note)  before=2 after=1 textBeforeUndo="undo me" textAfterFirstUndo="undo m" pressesToRemove=8
PASS  AC5 arrow drawn on its page only  here=1 freshPage=0
PASS  EXTRA-A Backspace scoped to canvas focus (outside page text ignored, canvas click deletes)  outsideTextFound=1 before=1 afterOutsideBackspace=1 afterCanvasBackspace=0
PASS  EXTRA-B Ctrl+Z after page creation undoes cleanly, page still present  notesBefore=1 notesAfter=0 viewportPresent=1 currentTabPresent=1
SKIP  AC7 dark scheme (human-verify: bb did not follow the emulated dark colour scheme)  {"body":"rgb(239, 241, 245)","panel":"rgb(239, 241, 245)","toolbar":"rgba(0, 0, 0, 0)","toolFg":"rgb(76, 79, 105)"}
PASS  no page errors  []
```

10 checks passed, 1 skipped. Page tabs are identical before and after the run.

**AC7 light:** passes, and now also asserts the panel is not the web app's fallback `rgb(250, 250, 247)`, so the bb token mapping is proven live rather than merely "light like the body".

**AC7 dark: human-verify.** bb did not follow Playwright's emulated dark colour scheme (the body stayed `rgb(239, 241, 245)`), so the dark pass could not observe dark chrome. bb's appearance setting was deliberately not changed. To verify: switch bb to dark appearance, open the Canvas with a note selected, and confirm the toolbar and style panel render dark backgrounds with light text.

AC4 asserts per-edit undo (the first Ctrl+Z changes the note's text; repeated presses with no clicking remove the note), matching the owner-accepted per-edit undo granularity gap: the editor records one undo step per `SetText`.

Web app: full Playwright lane `bunx playwright test --project=e2e` 84/84 (includes the new `enter-on-chrome-button-does-not-edit` browser contract); repo `bun run typecheck` 0; `bun run test` passes apart from `server/src/relay-loopback.test.ts` (cannot open the tmux socket inside the agent sandbox), with every file after it run individually and passing; plugin `npm run typecheck` 0, `npm test` 1229/1229, `npm run audit:quality:compare` 0 (95.22% improvement vs `ee79ab4`), `bb plugin build .` 0.
