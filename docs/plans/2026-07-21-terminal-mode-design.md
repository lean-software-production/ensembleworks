# Terminal mode — clear canvas boundary, native terminal behaviour

**Date:** 2026-07-21  
**Status:** Validated with owner; not implemented.

## Goal

A canvas terminal must have two unambiguous local modes:

- **Canvas mode:** the terminal is a canvas object. Users select, move, resize,
  and inspect it.
- **Terminal mode:** the terminal is the active work surface. Users type,
  scroll, select, copy, and paste as they would in a terminal on their own
  computer.

`tmux` remains the invisible server-side substrate for a durable, shared shell.
It must not impose user-visible modes, shortcuts, or mouse behaviour.

The design applies to both the legacy tldraw engine and canvas v2. The engines
may use separate adapters, but they must expose the same interaction contract.

## Decisions

| Question | Decision |
| --- | --- |
| Entry | A selected terminal exposes a `⛶` control above its top-right edge; `Enter` opens the selected terminal; double-clicking the terminal body is a secondary shortcut. |
| Entry result | Entering automatically opens local terminal focus view. The terminal enlarges without changing its shared PTY grid; the surrounding canvas is matted. |
| Exit | A persistent **Back to canvas** control, `Ctrl/Cmd+Shift+Enter`, or a matte click exits. The exit action never reaches the canvas beneath. |
| Escape | Plain `Esc` always reaches the terminal. It never exits terminal mode. |
| Camera | Entry snapshots the local camera. Exit restores that snapshot and leaves the terminal selected. |
| Canvas-body mouse input | In canvas mode, click selects and drag moves or resizes the tile. Terminal text cannot be selected and receives no input. Canvas wheel behaviour remains canvas wheel behaviour. |
| Terminal mouse input | In terminal mode, xterm owns pointer and keyboard input. Wheel and trackpad scroll local browser history, not tmux copy mode. |
| Copy | Drag creates a local xterm selection. Copy is explicit: `Ctrl/Cmd+Shift+C` or the terminal context menu. Plain `Ctrl/Cmd+C` remains SIGINT when no selection exists. |
| Paste | `Ctrl/Cmd+V`, `Ctrl/Cmd+Shift+V`, Shift+Insert, and terminal context-menu Paste use xterm's bracketed-paste-aware path. |
| Collaboration | Input remains shared. The terminal header shows the people currently in terminal mode for that session; there is no control lock. |
| Scrollback ownership | tmux keeps the canonical durable history. Each browser holds only a bounded, local viewing cache for the terminal it is actively focusing. |

## User experience

### Canvas mode

A terminal looks and behaves like any other canvas tile. A click selects it;
a drag moves it; resize handles change its size. The floating title remains a
rename and move handle: double-click title to rename, drag title to move.

When selected, the terminal shows the compact `⛶` action above its top-right
edge, opposite the title. Its tooltip and accessible name are **Enter terminal
· Enter**. It replaces the current focus-only affordance. The action disappears
on deselect, so idle terminals remain uncluttered.

A double-click on the terminal body also enters terminal mode. A drag never
enters terminal mode. This gives experienced users a familiar fast path without
making one click start a shell session.

### Terminal mode

Entry opens local focus view automatically. The terminal fills the available
canvas work area at a uniform scale; it does not resize the shared PTY or change
what other viewers see. A matte makes the mode boundary visible.

A persistent header identifies the state as **Terminal input**. It contains:

- **Back to canvas**;
- `Ctrl/Cmd+Shift+Enter` as the keyboard exit route;
- **Shared session** and avatars or names for people currently in terminal mode
  for this session.

The terminal receives focus on entry. All ordinary terminal keys go to xterm,
including `Esc`. A user can leave with the Back button, the exit chord, or a
click on the matte. Those actions are consumed by terminal-mode chrome; they do
not select, pan, or otherwise alter the canvas behind it.

Exit returns keyboard ownership to the canvas, restores the camera from entry,
and leaves the terminal selected. It also clears the user's terminal-activity
presence. A browser blur or transient connection failure does not silently exit
the mode.

## Native terminal behaviour

### Scroll

The browser, not tmux, owns the viewing position. Wheel and trackpad scrolling
use xterm's local scrollback and do not enter tmux copy mode or freeze the
terminal in a hidden state. While the viewer is above the live bottom, terminal
chrome displays **Viewing history · Jump to latest**.

Applications that explicitly request mouse tracking continue to receive their
mouse events. Otherwise, scrolling behaves as it does in a local terminal
emulator.

### Selection, copy, and paste

Dragging in terminal mode selects xterm text locally and leaves that selection
visible. It does not mutate the host clipboard on mouse release. Users copy with
the explicit shortcut or a terminal context-menu item.

Paste reads the host clipboard only during a user gesture, then calls xterm's
normal paste path so bracketed-paste-aware applications receive the correct
input. If browser clipboard permission prevents a programmatic read, the UI
must show a concise, actionable failure rather than silently dropping the
paste.

No tmux copy-mode, OSC-52 clipboard relay, or tmux mouse selection is part of
this path.

## Architecture

### Local mode coordinator

Each engine gets an adapter around the same local state machine:

```text
canvas → terminal-focus → canvas
```

The coordinator owns camera snapshot/restore, focus handoff, local terminal
activity presence, and exit conditions. It is local state: it does not modify
the shared canvas document and does not resize the terminal's grid.

The legacy adapter uses its tldraw editing and focus APIs. The v2 adapter uses
its canvas-editor/canvas-react state. They must not retain their present,
incompatible double-Escape and single-Escape semantics.

### Browser terminal viewport

xterm owns terminal input, selection, clipboard operations, and the local
scroll viewport. Canvas-mode terminal previews keep only their live screen; the
active focused terminal receives a bounded local history cache.

Do not keep a second browser-side transcript, such as an unbounded `string[]`
of output. xterm's bounded buffer is the sole browser history cache.

### Gateway and tmux

Tmux continues to supply the persistent session, shell, bounded canonical
history, and multi-viewer fan-out. Canvas tmux configuration disables mouse and
copy-mode behaviour that captures wheel input. Its status bar, prefix,
sessions, panes, windows, and tmux clipboard affordances remain hidden.

The gateway and remote connector need a history handoff that supports browser
hydration on terminal entry and reconnect. The current 256 KiB rolling gateway
replay cache is not sufficient as the only source: it is smaller than tmux
history and vanishes on gateway restart. The implementation must obtain a
bounded tail from the retained tmux session, send it before live output, and
make the snapshot-to-stream boundary atomic so it cannot lose or duplicate
output.

### Memory budget

Moving every tmux history row into every browser would multiply memory by
terminals times viewers. The design explicitly avoids that:

- tmux retains one 50k-line canonical history per session;
- the browser requests only a bounded recent tail on terminal entry;
- xterm has both a row and byte ceiling;
- at most the focused terminal retains browser scrollback; leaving terminal
  mode clears it while preserving the canvas preview;
- inactive/off-screen terminal connections continue to suspend where supported.

Choose the exact client cap from a sustained-output measurement. It must give
normal working scrollback without allowing unbounded browser memory growth.

### Presence

Presence gains a local terminal-session identifier. It represents only that a
person is currently in terminal mode for a particular session; it does not send
keystrokes, scroll position, clipboard contents, or a control lock. The focus
header derives its active-viewer list from this field.

## Failure handling

Connection states remain legible in terminal focus: connecting, reconnecting,
and ended. **Back to canvas** remains available in every state.

Exit terminal mode safely if the terminal is deleted, the session ends, the
page changes, or Present takes precedence. Restore canvas ownership and clear
terminal activity presence. Do not exit because the browser window temporarily
blurs or because a socket reconnects.

History hydration must define a safe response for unavailable or malformed
history. A live terminal must still open, clearly state that only recent output
is available, and continue streaming rather than fail closed.

## Verification

This change touches interaction-bearing terminal and canvas surfaces. It must
add or extend a declaration in `@ensembleworks/interaction-contracts`, run RED
against the unfixed behaviour, and record the verbatim failure. Any observation
added to the shared contract interface must be implemented in both the FSM and
browser adapters; browser-only observations may use the documented FSM
throw-stub where unavailable.

The contract and supporting browser tests must cover:

1. Canvas-body click, drag, resize, and wheel never send terminal input or
   select terminal text.
2. `⛶`, `Enter`, and a stationary body double-click enter terminal mode; a
   drag does not.
3. Terminal mode is visibly distinct, focuses xterm, and disables canvas input.
4. Plain `Esc` reaches the terminal; the Back button, matte click, and exit
   chord return to canvas and restore the entry camera.
5. Wheel scroll uses local history, never tmux copy mode; Jump to latest
   returns to the live bottom.
6. Drag selection requires explicit copy; copy and host paste preserve normal
   SIGINT and bracketed-paste semantics.
7. Two viewers see each other's terminal activity and can still send shared
   input.
8. The bounded browser cache survives sustained output without exceeding its
   row or byte caps.
9. Legacy and v2 expose the same behaviours.
10. Gateway and remote-connector integration tests prove tmux-session survival
    and race-free history hydration across reconnect.

Before implementation, run a small tmux/xterm preflight for mouse-tracking
applications and capture-pane history fidelity. The chosen handoff must work
for ordinary shell output and interactive full-screen programs; if it cannot,
record the limitation before widening the rollout.

## Out of scope

- A hard or soft terminal-control lock.
- Synchronizing browser scroll positions or clipboard contents.
- Changing the shared PTY grid on local terminal focus.
- Replacing tmux as the persistence and fan-out substrate.
- An unlimited browser transcript or history archive.
